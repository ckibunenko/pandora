import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { CsrfGuard, RolesGuard, SessionGuard } from "./guards.js";
import { LoginRateLimiter } from "./login-rate-limiter.js";
import { PasswordHasher } from "./password-hasher.js";
import { SessionCleanupService } from "./session-cleanup.service.js";
import { SessionsService } from "./sessions.service.js";

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionsService,
    PasswordHasher,
    LoginRateLimiter,
    SessionCleanupService,
    // Global guards run in registration order: authenticate, then CSRF, then role checks.
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [PasswordHasher],
})
export class AuthModule {}
