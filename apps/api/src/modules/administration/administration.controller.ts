import { applyDecorators, Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBody, ApiCookieAuth, ApiHeader, ApiParam, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  adminOrganizationSchema,
  adminUserSchema,
  createOrganizationSchema,
  createUserSchema,
  errorEnvelopeSchema,
  organizationListResponseSchema,
  organizationParamsSchema,
  organizationQuerySchema,
  resetPasswordSchema,
  updateOrganizationSchema,
  updateUserSchema,
  userListResponseSchema,
  userParamsSchema,
  userQuerySchema,
  type AdminOrganization,
  type AdminUser,
  type CreateOrganization,
  type CreateUser,
  type OrganizationListResponse,
  type OrganizationQuery,
  type ResetPassword,
  type UpdateOrganization,
  type UpdateUser,
  type UserListResponse,
  type UserQuery,
} from "@pandora/contracts";
import type { z } from "zod";
import { openApiSchema } from "../../common/openapi/zod-openapi.js";
import { ZodValidationPipe } from "../../common/validation/zod-validation.pipe.js";
import type { AuthContext } from "../auth/auth-context.js";
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from "../auth/auth.constants.js";
import { CurrentAuth, Roles } from "../auth/decorators.js";
import { OrganizationsService } from "./organizations.service.js";
import { UsersService } from "./users.service.js";

const ERROR = openApiSchema(errorEnvelopeSchema);

function AdminEndpoints(tag: string) {
  return applyDecorators(
    ApiTags(tag),
    ApiCookieAuth(SESSION_COOKIE_NAME),
    ApiResponse({ status: 401, description: "UNAUTHENTICATED", schema: ERROR }),
    ApiResponse({ status: 403, description: "FORBIDDEN or CSRF_TOKEN_INVALID", schema: ERROR }),
    ApiResponse({ status: 404, description: "NOT_FOUND", schema: ERROR }),
    ApiResponse({ status: 422, description: "VALIDATION_FAILED", schema: ERROR }),
    Roles("administrator"),
  );
}
function Returns(schema: z.ZodType, status = 200) {
  return ApiResponse({ status, schema: openApiSchema(schema) });
}
function ListQuery(schema: z.ZodType) {
  const properties = openApiSchema(schema, "input").properties ?? {};
  return applyDecorators(
    ...Object.entries(properties).map(([name, property]) => ApiQuery({ name, required: false, schema: property })),
  );
}
function Mutation(schema: z.ZodType, conflicts?: string) {
  return applyDecorators(
    ApiHeader({ name: CSRF_HEADER_NAME, required: true }),
    ApiBody({ schema: openApiSchema(schema, "input") }),
    ApiResponse({ status: 400, description: "MALFORMED_REQUEST", schema: ERROR }),
    ...(conflicts ? [ApiResponse({ status: 409, description: conflicts, schema: ERROR })] : []),
  );
}

@AdminEndpoints("organization administration")
@Controller("admin/organizations")
export class AdminOrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  @ListQuery(organizationQuerySchema)
  @Returns(organizationListResponseSchema)
  list(@Query(new ZodValidationPipe(organizationQuerySchema)) query: OrganizationQuery): Promise<OrganizationListResponse> {
    return this.organizations.list(query);
  }

  @Get(":organizationId")
  @ApiParam({ name: "organizationId", format: "uuid" })
  @Returns(adminOrganizationSchema)
  detail(@Param(new ZodValidationPipe(organizationParamsSchema)) params: { organizationId: string }): Promise<AdminOrganization> {
    return this.organizations.detail(params.organizationId);
  }

  @Post()
  @Mutation(createOrganizationSchema, "ORGANIZATION_NAME_EXISTS, CONCURRENT_MODIFICATION")
  @Returns(adminOrganizationSchema, 201)
  create(
    @Body(new ZodValidationPipe(createOrganizationSchema)) body: CreateOrganization,
    @CurrentAuth() auth: AuthContext,
  ): Promise<AdminOrganization> {
    return this.organizations.create(body, auth);
  }

  @Patch(":organizationId")
  @ApiParam({ name: "organizationId", format: "uuid" })
  @Mutation(updateOrganizationSchema, "ORGANIZATION_NAME_EXISTS, DISTRIBUTOR_ORGANIZATION_PROTECTED, CONCURRENT_MODIFICATION")
  @Returns(adminOrganizationSchema)
  update(
    @Param(new ZodValidationPipe(organizationParamsSchema)) params: { organizationId: string },
    @Body(new ZodValidationPipe(updateOrganizationSchema)) body: UpdateOrganization,
    @CurrentAuth() auth: AuthContext,
  ): Promise<AdminOrganization> {
    return this.organizations.update(params.organizationId, body, auth);
  }
}

@AdminEndpoints("user administration")
@Controller("admin/users")
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ListQuery(userQuerySchema)
  @Returns(userListResponseSchema)
  list(@Query(new ZodValidationPipe(userQuerySchema)) query: UserQuery): Promise<UserListResponse> {
    return this.users.list(query);
  }

  @Get(":userId")
  @ApiParam({ name: "userId", format: "uuid" })
  @Returns(adminUserSchema)
  detail(@Param(new ZodValidationPipe(userParamsSchema)) params: { userId: string }): Promise<AdminUser> {
    return this.users.detail(params.userId);
  }

  @Post()
  @Mutation(createUserSchema, "EMAIL_ALREADY_EXISTS, CONCURRENT_MODIFICATION")
  @Returns(adminUserSchema, 201)
  create(@Body(new ZodValidationPipe(createUserSchema)) body: CreateUser, @CurrentAuth() auth: AuthContext): Promise<AdminUser> {
    return this.users.create(body, auth);
  }

  @Patch(":userId")
  @ApiParam({ name: "userId", format: "uuid" })
  @Mutation(updateUserSchema, "LAST_ACTIVE_ADMINISTRATOR, CONCURRENT_MODIFICATION")
  @Returns(adminUserSchema)
  update(
    @Param(new ZodValidationPipe(userParamsSchema)) params: { userId: string },
    @Body(new ZodValidationPipe(updateUserSchema)) body: UpdateUser,
    @CurrentAuth() auth: AuthContext,
  ): Promise<AdminUser> {
    return this.users.update(params.userId, body, auth);
  }

  @Post(":userId/password")
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: "userId", format: "uuid" })
  @Mutation(resetPasswordSchema, "CONCURRENT_MODIFICATION")
  @Returns(adminUserSchema)
  resetPassword(
    @Param(new ZodValidationPipe(userParamsSchema)) params: { userId: string },
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: ResetPassword,
    @CurrentAuth() auth: AuthContext,
  ): Promise<AdminUser> {
    return this.users.resetPassword(params.userId, body, auth);
  }
}
