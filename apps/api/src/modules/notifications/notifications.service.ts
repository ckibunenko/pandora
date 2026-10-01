import { Injectable } from "@nestjs/common";
import {
  notificationEventTypeSchema,
  notificationSchema,
  type Notification,
  type NotificationListResponse,
  type NotificationQuery,
  type NotificationStatus,
  type NotificationSummary,
  type RetryNotification,
} from "@pandora/contracts";
import { recordAudit } from "../../common/audit/audit.js";
import { Clock } from "../../common/clock/clock.js";
import { ApiException } from "../../common/errors/api-exception.js";
import { IdempotencyService } from "../../common/idempotency/idempotency.service.js";
import { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import type { AuthContext } from "../auth/auth-context.js";

const SUMMARY_SELECT = {
  id: true,
  eventType: true,
  status: true,
  recipientEmail: true,
  subject: true,
  attemptCount: true,
  maxAttempts: true,
  nextAttemptAt: true,
  lastError: true,
  correlationId: true,
  createdAt: true,
  sentAt: true,
  order: { select: { id: true, number: true } },
  recipient: { select: { id: true, displayName: true } },
} satisfies Prisma.NotificationJobSelect;
const DETAIL_SELECT = {
  ...SUMMARY_SELECT,
  body: true,
  attempts: {
    select: { number: true, workerId: true, startedAt: true, finishedAt: true, outcome: true, error: true },
    orderBy: { number: "asc" },
  },
} satisfies Prisma.NotificationJobSelect;
type JobSummary = Prisma.NotificationJobGetPayload<{ select: typeof SUMMARY_SELECT }>;
type JobDetail = Prisma.NotificationJobGetPayload<{ select: typeof DETAIL_SELECT }>;

const STATUS: Record<JobSummary["status"], NotificationStatus> = { PENDING: "pending", SENDING: "sending", SENT: "sent", FAILED: "failed" };
const DB_STATUS: Record<NotificationStatus, JobSummary["status"]> = { pending: "PENDING", sending: "SENDING", sent: "SENT", failed: "FAILED" };
const OUTCOME = { IN_PROGRESS: "in_progress", SENT: "sent", FAILED: "failed", AMBIGUOUS: "ambiguous" } as const;

/** Delivery diagnostics (overview §3): operators get the operational view; only administrators see addresses and bodies. */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly idempotency: IdempotencyService,
  ) {}

  private summary(job: JobSummary, auth: AuthContext): NotificationSummary {
    return {
      id: job.id,
      eventType: notificationEventTypeSchema.parse(job.eventType),
      status: STATUS[job.status],
      order: job.order,
      recipient: job.recipient,
      recipientEmail: auth.user.role === "administrator" ? job.recipientEmail : null,
      subject: job.subject,
      attemptCount: job.attemptCount,
      maxAttempts: job.maxAttempts,
      nextAttemptAt: job.status === "PENDING" ? job.nextAttemptAt.toISOString() : null,
      lastError: job.lastError,
      correlationId: job.correlationId,
      createdAt: job.createdAt.toISOString(),
      sentAt: job.sentAt?.toISOString() ?? null,
    };
  }

  private detailDto(job: JobDetail, auth: AuthContext): Notification {
    return {
      ...this.summary(job, auth),
      body: auth.user.role === "administrator" ? job.body : null,
      attempts: job.attempts.map((attempt) => ({
        number: attempt.number,
        workerId: attempt.workerId,
        startedAt: attempt.startedAt.toISOString(),
        finishedAt: attempt.finishedAt?.toISOString() ?? null,
        outcome: OUTCOME[attempt.outcome],
        error: attempt.error,
      })),
    };
  }

  private async findDetail(tx: Prisma.TransactionClient, notificationId: string, auth: AuthContext): Promise<Notification> {
    const job = await tx.notificationJob.findUnique({ where: { id: notificationId }, select: DETAIL_SELECT });
    if (!job) {
      throw ApiException.notFound("Notification not found.");
    }
    return this.detailDto(job, auth);
  }

  async list(query: NotificationQuery, auth: AuthContext): Promise<NotificationListResponse> {
    const where: Prisma.NotificationJobWhereInput = {
      ...(query.status ? { status: DB_STATUS[query.status] } : {}),
      ...(query.eventType ? { eventType: query.eventType } : {}),
    };
    return this.prisma.$transaction(
      async (tx) => {
        const total = await tx.notificationJob.count({ where });
        const jobs = await tx.notificationJob.findMany({
          where,
          select: SUMMARY_SELECT,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        });
        return { items: jobs.map((job) => this.summary(job, auth)), total, page: query.page, pageSize: query.pageSize };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  detail(notificationId: string, auth: AuthContext): Promise<Notification> {
    return this.findDetail(this.prisma, notificationId, auth);
  }

  /** Grants a failed job exactly one more attempt now; the worker delivers it outside this transaction. */
  retry(notificationId: string, input: RetryNotification, auth: AuthContext, key: string): Promise<Notification> {
    return this.idempotency.execute(
      { organizationId: auth.user.organization.id, actorId: auth.user.id, operation: "notification.retry", target: notificationId, key },
      input,
      notificationSchema,
      async (tx) => {
        const job = await tx.notificationJob.findUnique({ where: { id: notificationId }, select: { status: true, attemptCount: true, maxAttempts: true } });
        if (!job) {
          throw ApiException.notFound("Notification not found.");
        }
        if (job.status !== "FAILED") {
          throw ApiException.notificationNotRetryable(`Only failed notifications can be retried; this one is ${STATUS[job.status]}.`);
        }
        const updated = await tx.notificationJob.updateMany({
          where: { id: notificationId, status: "FAILED", attemptCount: job.attemptCount },
          data: { status: "PENDING", maxAttempts: job.attemptCount + 1, nextAttemptAt: this.clock.now() },
        });
        if (updated.count !== 1) {
          throw ApiException.notificationNotRetryable("This notification changed in the meantime. Reload it.");
        }
        await recordAudit(tx, this.clock, auth, {
          entityType: "notification",
          entityId: notificationId,
          action: "retry_requested",
          before: { status: "failed", attemptCount: job.attemptCount, maxAttempts: job.maxAttempts },
          after: { status: "pending", attemptCount: job.attemptCount, maxAttempts: job.attemptCount + 1 },
        });
        return this.findDetail(tx, notificationId, auth);
      },
      200,
    );
  }
}
