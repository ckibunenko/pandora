import { SetMetadata, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { UserRole } from "@pandora/contracts";
import type { Request } from "express";
import { ApiException } from "../../common/errors/api-exception.js";
import type { AuthContext } from "./auth-context.js";

export const IS_PUBLIC_KEY = "auth:isPublic";
export const ROLES_KEY = "auth:roles";

/** Opts a route out of the default-deny session guard. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

export const CurrentAuth = createParamDecorator((_data: unknown, context: ExecutionContext): AuthContext => {
  const auth = context.switchToHttp().getRequest<Request>().auth;
  if (!auth) {
    throw ApiException.unauthenticated();
  }
  return auth;
});
