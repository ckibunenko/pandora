import { applyDecorators, Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { ApiBody, ApiCookieAuth, ApiHeader, ApiParam, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  errorEnvelopeSchema,
  notificationListResponseSchema,
  notificationParamsSchema,
  notificationQuerySchema,
  notificationSchema,
  retryNotificationSchema,
  type Notification,
  type NotificationListResponse,
  type NotificationQuery,
  type RetryNotification,
} from "@pandora/contracts";
import { IDEMPOTENCY_KEY_HEADER, IdempotencyKey } from "../../common/idempotency/idempotency-key.decorator.js";
import { openApiSchema } from "../../common/openapi/zod-openapi.js";
import { ZodValidationPipe } from "../../common/validation/zod-validation.pipe.js";
import type { AuthContext } from "../auth/auth-context.js";
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from "../auth/auth.constants.js";
import { CurrentAuth, Roles } from "../auth/decorators.js";
import { NotificationsService } from "./notifications.service.js";

const ERROR = openApiSchema(errorEnvelopeSchema);
const NOTIFICATION = openApiSchema(notificationSchema);
const listQueries = Object.entries(openApiSchema(notificationQuerySchema, "input").properties ?? {}).map(([name, schema]) =>
  ApiQuery({ name, required: false, schema }),
);

@ApiTags("notifications")
@ApiCookieAuth(SESSION_COOKIE_NAME)
@ApiResponse({ status: 401, description: "UNAUTHENTICATED", schema: ERROR })
@ApiResponse({ status: 403, description: "FORBIDDEN or CSRF_TOKEN_INVALID", schema: ERROR })
@ApiResponse({ status: 422, description: "VALIDATION_FAILED", schema: ERROR })
@Roles("operator", "administrator")
@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiResponse({ status: 200, description: "Newest first; recipient emails for administrators only.", schema: openApiSchema(notificationListResponseSchema) })
  @applyDecorators(...listQueries)
  list(@Query(new ZodValidationPipe(notificationQuerySchema)) query: NotificationQuery, @CurrentAuth() auth: AuthContext): Promise<NotificationListResponse> {
    return this.notifications.list(query, auth);
  }

  @Get(":notificationId")
  @ApiParam({ name: "notificationId", format: "uuid" })
  @ApiResponse({ status: 200, description: "With attempts; email and body for administrators only.", schema: NOTIFICATION })
  @ApiResponse({ status: 404, description: "NOT_FOUND", schema: ERROR })
  detail(@Param(new ZodValidationPipe(notificationParamsSchema)) params: { notificationId: string }, @CurrentAuth() auth: AuthContext): Promise<Notification> {
    return this.notifications.detail(params.notificationId, auth);
  }

  @Post(":notificationId/retry")
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: "notificationId", format: "uuid" })
  @ApiHeader({ name: CSRF_HEADER_NAME, required: true })
  @ApiHeader({ name: IDEMPOTENCY_KEY_HEADER, required: true, description: "1–255 printable ASCII characters." })
  @ApiBody({ schema: openApiSchema(retryNotificationSchema, "input") })
  @ApiResponse({ status: 200, description: "Queued for one more attempt, or the original response replayed.", schema: NOTIFICATION })
  @ApiResponse({ status: 400, description: "MALFORMED_REQUEST or IDEMPOTENCY_KEY_REQUIRED", schema: ERROR })
  @ApiResponse({ status: 404, description: "NOT_FOUND", schema: ERROR })
  @ApiResponse({ status: 409, description: "NOTIFICATION_NOT_RETRYABLE, IDEMPOTENCY_KEY_REUSED, REQUEST_IN_PROGRESS, or CONCURRENT_MODIFICATION", schema: ERROR })
  retry(
    @Param(new ZodValidationPipe(notificationParamsSchema)) params: { notificationId: string },
    @Body(new ZodValidationPipe(retryNotificationSchema)) body: RetryNotification,
    @IdempotencyKey() key: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<Notification> {
    return this.notifications.retry(params.notificationId, body, auth, key);
  }
}
