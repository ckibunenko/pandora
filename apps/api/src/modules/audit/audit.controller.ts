import { applyDecorators, Controller, Get, Param, Query } from "@nestjs/common";
import { ApiCookieAuth, ApiParam, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import { auditEventSchema, auditListResponseSchema, auditParamsSchema, auditQuerySchema, errorEnvelopeSchema, type AuditEvent, type AuditListResponse, type AuditQuery } from "@pandora/contracts";
import { openApiSchema } from "../../common/openapi/zod-openapi.js";
import { ZodValidationPipe } from "../../common/validation/zod-validation.pipe.js";
import type { AuthContext } from "../auth/auth-context.js";
import { SESSION_COOKIE_NAME } from "../auth/auth.constants.js";
import { CurrentAuth, Roles } from "../auth/decorators.js";
import { AuditService } from "./audit.service.js";

const ERROR = openApiSchema(errorEnvelopeSchema);
const listQueries = Object.entries(openApiSchema(auditQuerySchema, "input").properties ?? {})
  .map(([name, schema]) => ApiQuery({ name, required: false, schema }));

@ApiTags("audit")
@ApiCookieAuth(SESSION_COOKIE_NAME)
@ApiResponse({ status: 401, description: "UNAUTHENTICATED", schema: ERROR })
@ApiResponse({ status: 403, description: "FORBIDDEN", schema: ERROR })
@ApiResponse({ status: 422, description: "VALIDATION_FAILED", schema: ERROR })
@Roles("operator", "administrator")
@Controller("audit-events")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiResponse({ status: 200, description: "Filtered audit summaries; operators see orders and inventory only.", schema: openApiSchema(auditListResponseSchema) })
  @applyDecorators(...listQueries)
  list(@Query(new ZodValidationPipe(auditQuerySchema)) query: AuditQuery, @CurrentAuth() auth: AuthContext): Promise<AuditListResponse> {
    return this.audit.list(query, auth);
  }

  @Get(":eventId")
  @ApiParam({ name: "eventId", format: "uuid" })
  @ApiResponse({ status: 200, schema: openApiSchema(auditEventSchema) })
  @ApiResponse({ status: 404, description: "NOT_FOUND (including events outside the operator's scope)", schema: ERROR })
  detail(@Param(new ZodValidationPipe(auditParamsSchema)) params: { eventId: string }, @CurrentAuth() auth: AuthContext): Promise<AuditEvent> {
    return this.audit.detail(params.eventId, auth);
  }
}
