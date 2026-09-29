import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Res } from "@nestjs/common";
import { ApiBody, ApiCookieAuth, ApiHeader, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  errorEnvelopeSchema,
  loginRequestSchema,
  sessionResponseSchema,
  type LoginRequest,
  type SessionResponse,
} from "@pandora/contracts";
import type { CookieOptions, Response } from "express";
import { APP_CONFIG } from "../../common/config/app-config.js";
import type { AppConfig } from "../../common/config/app-config.js";
import { openApiSchema } from "../../common/openapi/zod-openapi.js";
import { ZodValidationPipe } from "../../common/validation/zod-validation.pipe.js";
import type { AuthContext } from "./auth-context.js";
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from "./auth.constants.js";
import { AuthService } from "./auth.service.js";
import { CurrentAuth, Public } from "./decorators.js";
import { SessionsService } from "./sessions.service.js";

const ERROR_SCHEMA = openApiSchema(errorEnvelopeSchema);
const SESSION_SCHEMA = openApiSchema(sessionResponseSchema);

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiBody({ schema: openApiSchema(loginRequestSchema, "input") })
  @ApiResponse({ status: 200, description: "Session created; sets the session cookie.", schema: SESSION_SCHEMA })
  @ApiResponse({ status: 401, description: "INVALID_CREDENTIALS", schema: ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: "VALIDATION_FAILED", schema: ERROR_SCHEMA })
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionResponse> {
    const result = await this.auth.login(body.email, body.password);
    response.cookie(SESSION_COOKIE_NAME, result.token, { ...this.cookieOptions(), expires: result.expiresAt });
    return { user: result.user, csrfToken: result.csrfToken };
  }

  @Get("session")
  @ApiCookieAuth(SESSION_COOKIE_NAME)
  @ApiResponse({ status: 200, schema: SESSION_SCHEMA })
  @ApiResponse({ status: 401, description: "UNAUTHENTICATED", schema: ERROR_SCHEMA })
  session(@CurrentAuth() auth: AuthContext): SessionResponse {
    return { user: auth.user, csrfToken: auth.csrfToken };
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth(SESSION_COOKIE_NAME)
  @ApiHeader({ name: CSRF_HEADER_NAME, required: true })
  @ApiResponse({ status: 204, description: "Session revoked; clears the session cookie." })
  @ApiResponse({ status: 401, description: "UNAUTHENTICATED", schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: "CSRF_TOKEN_INVALID", schema: ERROR_SCHEMA })
  async logout(@CurrentAuth() auth: AuthContext, @Res({ passthrough: true }) response: Response): Promise<void> {
    await this.sessions.revoke(auth.sessionId, "logout");
    response.clearCookie(SESSION_COOKIE_NAME, this.cookieOptions());
  }

  private cookieOptions(): CookieOptions {
    return { httpOnly: true, sameSite: "lax", secure: this.config.sessionCookieSecure, path: "/" };
  }
}
