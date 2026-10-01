import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { Clock } from "../common/clock/clock.js";
import { WORKER_CONFIG, type WorkerConfig } from "../common/config/worker-config.js";
import { PrismaService } from "../infrastructure/prisma/prisma.service.js";
import { DeliveryError, MailTransport } from "./mail-transport.js";

interface ClaimedJob {
  readonly id: string;
  readonly eventType: string;
  readonly recipientUserId: string;
  readonly recipientEmail: string;
  readonly subject: string;
  readonly body: string;
  readonly correlationId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
}

const AMBIGUOUS = "Lease expired before the outcome was recorded; the message may or may not have been delivered.";
const RELEASED = "Not sent: the worker stopped before this attempt began.";
const clip = (text: string) => (text.length > 500 ? `${text.slice(0, 499)}…` : text);

/**
 * Delivers committed outbox jobs (overview §7, coding standards §8). Each job is claimed under a lease with an
 * in-progress attempt, sent outside any transaction, and its outcome is recorded only while this worker still owns
 * the lease. A lease that expires first turns the attempt `ambiguous`: delivery is at least once, never exactly once.
 * The worker never touches business tables.
 */
@Injectable()
export class NotificationWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(NotificationWorker.name);
  private stopping = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly transport: MailTransport,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.logger.log({ message: "Notification worker started", worker_id: this.config.workerId, failure_mode: this.config.failureMode });
    this.loop = this.run();
  }

  /** Stops claiming new work and waits for the job in flight, so a stop never abandons a held lease needlessly. */
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
    this.logger.log({ message: "Notification worker stopped", worker_id: this.config.workerId });
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let processed = 0;
      try {
        processed = await this.tick();
      } catch (error: unknown) {
        this.logger.error({ message: "Notification worker cycle failed", error: error instanceof Error ? error.message : String(error) });
      }
      if (processed === 0 && !this.stopping) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.config.pollIntervalMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  }

  private delayAfter(attempt: number): number {
    const delays = this.config.retryDelaysMs;
    return delays[Math.min(attempt - 1, delays.length - 1)] ?? 0;
  }

  async tick(): Promise<number> {
    await this.reclaimExpired();
    const jobs = await this.claim();
    for (const [index, job] of jobs.entries()) {
      if (this.stopping) {
        await this.release(jobs.slice(index));
        break;
      }
      await this.deliver(job);
    }
    return jobs.length;
  }

  /** On shutdown, claimed jobs that were never sent go back to the queue at once instead of waiting for their lease. */
  private async release(jobs: readonly ClaimedJob[]): Promise<void> {
    const now = this.clock.now();
    for (const job of jobs) {
      await this.prisma.$transaction(async (tx) => {
        const owned = await tx.notificationJob.updateMany({
          where: { id: job.id, status: "SENDING", leaseOwner: this.config.workerId },
          data: { status: job.attempt >= job.maxAttempts ? "FAILED" : "PENDING", leaseOwner: null, leaseExpiresAt: null, lastError: RELEASED, nextAttemptAt: now },
        });
        if (owned.count === 1) {
          await tx.notificationAttempt.updateMany({
            where: { jobId: job.id, number: job.attempt, outcome: "IN_PROGRESS" },
            data: { outcome: "FAILED", finishedAt: now, error: RELEASED },
          });
        }
      });
    }
    this.logger.log({ message: "Released unsent notifications on shutdown", released: jobs.length, worker_id: this.config.workerId });
  }

  /** Jobs whose lease ran out (crashed or hung worker): the open attempt becomes ambiguous and counts. */
  private async reclaimExpired(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = this.clock.now();
      const expired = await tx.$queryRaw<{ id: string; attempt_count: number; max_attempts: number; correlation_id: string }[]>`
        SELECT id, attempt_count, max_attempts, correlation_id FROM notification_jobs
        WHERE status = 'SENDING' AND lease_expires_at < ${now}
        ORDER BY lease_expires_at, id LIMIT ${this.config.batchSize}
        FOR UPDATE SKIP LOCKED`;
      for (const job of expired) {
        await tx.notificationAttempt.updateMany({
          where: { jobId: job.id, outcome: "IN_PROGRESS" },
          data: { outcome: "AMBIGUOUS", finishedAt: now, error: AMBIGUOUS },
        });
        const exhausted = job.attempt_count >= job.max_attempts;
        await tx.notificationJob.update({
          where: { id: job.id },
          data: {
            status: exhausted ? "FAILED" : "PENDING",
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: AMBIGUOUS,
            nextAttemptAt: new Date(now.getTime() + this.delayAfter(job.attempt_count)),
          },
        });
        this.logger.warn({ message: "Notification lease expired", job_id: job.id, correlation_id: job.correlation_id, exhausted });
      }
    });
  }

  private async claim(): Promise<ClaimedJob[]> {
    return this.prisma.$transaction(async (tx) => {
      const now = this.clock.now();
      const due = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM notification_jobs
        WHERE status = 'PENDING' AND next_attempt_at <= ${now}
        ORDER BY next_attempt_at, id LIMIT ${this.config.batchSize}
        FOR UPDATE SKIP LOCKED`;
      const claimed: ClaimedJob[] = [];
      for (const { id } of due) {
        const job = await tx.notificationJob.update({
          where: { id },
          data: {
            status: "SENDING",
            leaseOwner: this.config.workerId,
            leaseExpiresAt: new Date(now.getTime() + this.config.leaseMs),
            attemptCount: { increment: 1 },
          },
          select: {
            id: true,
            eventType: true,
            recipientUserId: true,
            recipientEmail: true,
            subject: true,
            body: true,
            correlationId: true,
            attemptCount: true,
            maxAttempts: true,
          },
        });
        await tx.notificationAttempt.create({
          data: { jobId: id, number: job.attemptCount, workerId: this.config.workerId, startedAt: now, outcome: "IN_PROGRESS" },
        });
        claimed.push({ ...job, attempt: job.attemptCount });
      }
      return claimed;
    });
  }

  private async deliver(job: ClaimedJob): Promise<void> {
    let failure: DeliveryError | undefined;
    try {
      await this.transport.send({
        to: job.recipientEmail,
        subject: job.subject,
        text: job.body,
        headers: { "X-Correlation-Id": job.correlationId, "X-Pandora-Notification": job.id, "X-Pandora-Event": job.eventType },
      });
    } catch (error: unknown) {
      failure = error instanceof DeliveryError ? error : new DeliveryError(error instanceof Error ? error.message : String(error), false);
    }
    const now = this.clock.now();
    const final = failure !== undefined && (failure.permanent || job.attempt >= job.maxAttempts);
    const recorded = await this.prisma.$transaction(async (tx) => {
      // Only the lease owner records an outcome; after a lost lease the attempt is (or will be) marked ambiguous.
      const owned = await tx.notificationJob.updateMany({
        where: { id: job.id, status: "SENDING", leaseOwner: this.config.workerId },
        data: failure
          ? {
              status: final ? "FAILED" : "PENDING",
              leaseOwner: null,
              leaseExpiresAt: null,
              lastError: clip(failure.message),
              nextAttemptAt: new Date(now.getTime() + this.delayAfter(job.attempt)),
            }
          : { status: "SENT", sentAt: now, leaseOwner: null, leaseExpiresAt: null, lastError: null },
      });
      if (owned.count !== 1) return false;
      await tx.notificationAttempt.updateMany({
        where: { jobId: job.id, number: job.attempt, outcome: "IN_PROGRESS" },
        data: { outcome: failure ? "FAILED" : "SENT", finishedAt: now, error: failure ? clip(failure.message) : null },
      });
      return true;
    });
    const log = {
      job_id: job.id,
      event_type: job.eventType,
      recipient_user_id: job.recipientUserId,
      attempt: job.attempt,
      correlation_id: job.correlationId,
    };
    if (!recorded) {
      this.logger.warn({ message: "Notification lease lost before recording the outcome", ...log });
    } else if (failure) {
      this.logger.warn({ message: final ? "Notification failed" : "Notification attempt failed; will retry", ...log, permanent: failure.permanent, error: clip(failure.message) });
    } else {
      this.logger.log({ message: "Notification sent", ...log });
    }
  }
}
