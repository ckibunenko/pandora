import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { UserRole } from "@pandora/contracts";
import type { Request } from "express";
import { ApiException } from "../../common/errors/api-exception.js";
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from "./auth.constants.js";
import { IS_PUBLIC_KEY, ROLES_KEY } from "./decorators.js";
import { SessionsService } from "./sessions.service.js";
import { tokensMatch } from "./session-token.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isPublic(reflector: Reflector, context: ExecutionContext): boolean {
  return reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]) === true;
}

/** Default deny: every route needs a valid session unless marked @Public(). */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isPublic(this.reflector, context)) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const cookies: Record<string, unknown> = request.cookies ?? {};
    const token = cookies[SESSION_COOKIE_NAME];
    if (typeof token !== "string" || token.length === 0) {
      throw ApiException.unauthenticated();
    }
    const auth = await this.sessions.authenticate(token);
    if (!auth) {
      throw ApiException.unauthenticated();
    }
    request.auth = auth;
    return true;
  }
}

/** Cookie-authenticated mutations must echo the session's CSRF token in a header. */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (isPublic(this.reflector, context) || SAFE_METHODS.has(request.method)) {
      return true;
    }
    const header = request.header(CSRF_HEADER_NAME);
    if (!request.auth || header === undefined || !tokensMatch(request.auth.csrfToken, header)) {
      throw ApiException.csrfTokenInvalid();
    }
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }
    const auth = context.switchToHttp().getRequest<Request>().auth;
    if (!auth) {
      throw ApiException.unauthenticated();
    }
    if (!required.includes(auth.user.role)) {
      throw ApiException.forbidden();
    }
    return true;
  }
}
