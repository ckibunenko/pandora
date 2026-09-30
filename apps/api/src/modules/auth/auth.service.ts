import { Injectable } from "@nestjs/common";
import type { SessionUser } from "@pandora/contracts";
import { ApiException } from "../../common/errors/api-exception.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { LoginRateLimiter } from "./login-rate-limiter.js";
import { PasswordHasher } from "./password-hasher.js";
import { SessionsService, type CreatedSession } from "./sessions.service.js";
import { toSessionUser } from "./session-user.mapper.js";

export interface LoginResult extends CreatedSession {
  readonly user: SessionUser;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordHasher,
    private readonly sessions: SessionsService,
    private readonly limiter: LoginRateLimiter,
  ) {}

  async login(email: string, password: string): Promise<LoginResult> {
    // Checked before the account lookup, so known and unknown emails are limited identically.
    const attemptKey = await this.limiter.begin(email);
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        isActive: true,
        passwordHash: true,
        organization: { select: { id: true, name: true, type: true, isActive: true } },
      },
    });

    if (!user) {
      await this.passwords.verifyAgainstDummy(password);
      throw ApiException.invalidCredentials();
    }
    const passwordValid = await this.passwords.verify(user.passwordHash, password);
    // Inactive accounts get the same response as a wrong password so account status is not disclosed.
    if (!passwordValid || !user.isActive || !user.organization.isActive) {
      throw ApiException.invalidCredentials();
    }

    await this.limiter.succeeded(attemptKey);
    const session = await this.sessions.create(user.id);
    return { ...session, user: toSessionUser(user) };
  }
}
