import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { Clock } from "../../common/clock/clock.js";
import { ApiException } from "../../common/errors/api-exception.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { LOGIN_ATTEMPT_LIMIT, LOGIN_ATTEMPT_WINDOW_MS } from "./auth.constants.js";

/** Only a digest of the normalized email is stored or logged; unknown emails are keyed the same way. */
function attemptKey(email: string): string {
  return createHash("sha256").update(email.toLowerCase()).digest("hex");
}

@Injectable()
export class LoginRateLimiter {
  private readonly logger = new Logger(LoginRateLimiter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /**
   * Counts the window and records the attempt under a per-email advisory lock, so parallel attempts check
   * exactly LOGIN_ATTEMPT_LIMIT passwords and the rest get 429. The lock covers only these two statements,
   * never password hashing. Refused attempts are not recorded.
   * Returns the key to pass to `succeeded` after a correct password.
   */
  async begin(email: string): Promise<string> {
    const keyHash = attemptKey(email);
    const now = this.clock.now();
    const windowStart = new Date(now.getTime() - LOGIN_ATTEMPT_WINDOW_MS);
    const oldestBlocking = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${keyHash}, 0))`;
      const recent = await tx.loginAttempt.findMany({
        where: { keyHash, attemptedAt: { gt: windowStart } },
        orderBy: { attemptedAt: "asc" },
        select: { attemptedAt: true },
      });
      if (recent.length >= LOGIN_ATTEMPT_LIMIT) {
        return recent[0]?.attemptedAt ?? now;
      }
      await tx.loginAttempt.create({ data: { keyHash, attemptedAt: now } });
      return null;
    });
    if (!oldestBlocking) {
      return keyHash;
    }

    const freeAt = oldestBlocking.getTime() + LOGIN_ATTEMPT_WINDOW_MS;
    const retryAfterSeconds = Math.max(1, Math.ceil((freeAt - now.getTime()) / 1000));
    this.logger.warn({ message: "Sign-in attempts limited", key: keyHash.slice(0, 12), retry_after_seconds: retryAfterSeconds });
    throw ApiException.tooManyLoginAttempts(retryAfterSeconds);
  }

  /** A correct password clears the window for that email. */
  async succeeded(keyHash: string): Promise<void> {
    await this.prisma.loginAttempt.deleteMany({ where: { keyHash } });
  }
}
