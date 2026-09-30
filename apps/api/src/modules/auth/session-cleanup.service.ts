import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { Clock } from "../../common/clock/clock.js";
import { APP_CONFIG, type AppConfig } from "../../common/config/app-config.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { LOGIN_ATTEMPT_WINDOW_MS, SESSION_IDLE_TIMEOUT_MS, SESSION_RETENTION_MS } from "./auth.constants.js";

/**
 * Periodically removes sessions that have been unusable (expired, idle-expired, or revoked) for longer than
 * the retention period, and sign-in attempts older than the rate-limit window. Deletes are idempotent, so
 * several API instances may run it at the same time.
 */
@Injectable()
export class SessionCleanupService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SessionCleanupService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    void this.runSafely();
    this.timer = setInterval(() => void this.runSafely(), this.config.sessionCleanupIntervalSeconds * 1000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  async run(): Promise<{ sessions: number; loginAttempts: number }> {
    const now = this.clock.now().getTime();
    const unusableBefore = new Date(now - SESSION_RETENTION_MS);
    const sessions = await this.prisma.session.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: unusableBefore } },
          { revokedAt: { lt: unusableBefore } },
          { lastSeenAt: { lt: new Date(now - SESSION_IDLE_TIMEOUT_MS - SESSION_RETENTION_MS) } },
        ],
      },
    });
    const loginAttempts = await this.prisma.loginAttempt.deleteMany({
      where: { attemptedAt: { lt: new Date(now - LOGIN_ATTEMPT_WINDOW_MS) } },
    });
    return { sessions: sessions.count, loginAttempts: loginAttempts.count };
  }

  private async runSafely(): Promise<void> {
    try {
      const removed = await this.run();
      if (removed.sessions > 0 || removed.loginAttempts > 0) {
        this.logger.log({ message: "Session cleanup", removed_sessions: removed.sessions, removed_login_attempts: removed.loginAttempts });
      }
    } catch (error: unknown) {
      // A failed run is retried at the next interval; it must never stop the API.
      this.logger.error({ message: "Session cleanup failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
}
