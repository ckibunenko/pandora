import { Injectable } from "@nestjs/common";
import { Clock } from "../../common/clock/clock.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import type { AuthContext } from "./auth-context.js";
import { SESSION_ABSOLUTE_TTL_MS, SESSION_IDLE_TIMEOUT_MS, SESSION_TOUCH_INTERVAL_MS } from "./auth.constants.js";
import { generateToken, hashToken } from "./session-token.js";
import { toSessionUser } from "./session-user.mapper.js";

export type SessionRevocationReason = "user_deactivated" | "role_changed" | "password_reset" | "organization_deactivated";

/** Ends every unexpired session that matches `where` inside the caller's transaction; returns how many ended. */
export async function revokeSessions(
  tx: Prisma.TransactionClient,
  clock: Clock,
  where: Prisma.SessionWhereInput,
  reason: SessionRevocationReason,
): Promise<number> {
  const now = clock.now();
  const result = await tx.session.updateMany({
    where: { ...where, revokedAt: null, expiresAt: { gt: now } },
    data: { revokedAt: now, revokedReason: reason },
  });
  return result.count;
}

export interface CreatedSession {
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async create(userId: string): Promise<CreatedSession> {
    const now = this.clock.now();
    const token = generateToken();
    const csrfToken = generateToken();
    const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS);
    await this.prisma.session.create({
      data: { userId, tokenHash: hashToken(token), csrfToken, createdAt: now, lastSeenAt: now, expiresAt },
    });
    return { token, csrfToken, expiresAt };
  }

  /** Returns the session's auth context, or null when it is unknown, revoked, expired, or its user/organization is inactive. */
  async authenticate(token: string): Promise<AuthContext | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        id: true,
        csrfToken: true,
        lastSeenAt: true,
        expiresAt: true,
        revokedAt: true,
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            role: true,
            isActive: true,
            organization: { select: { id: true, name: true, type: true, isActive: true } },
          },
        },
      },
    });
    if (!session || session.revokedAt !== null) {
      return null;
    }

    const now = this.clock.now();
    const idleMs = now.getTime() - session.lastSeenAt.getTime();
    if (now >= session.expiresAt || idleMs >= SESSION_IDLE_TIMEOUT_MS) {
      return null;
    }
    // Checked on every request so a deactivation takes effect immediately, before any explicit revocation.
    if (!session.user.isActive || !session.user.organization.isActive) {
      return null;
    }

    if (idleMs >= SESSION_TOUCH_INTERVAL_MS) {
      await this.prisma.session.updateMany({
        where: { id: session.id, lastSeenAt: { lt: now } },
        data: { lastSeenAt: now },
      });
    }

    return { sessionId: session.id, csrfToken: session.csrfToken, user: toSessionUser(session.user) };
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
  }
}
