import {
  applyDecorators,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  adminCatalogQuerySchema,
  catalogQuerySchema,
  catalogResponseSchema,
  createProductSchema,
  createVariantSchema,
  errorEnvelopeSchema,
  productParamsSchema,
  productSchema,
  updateProductSchema,
  updateVariantSchema,
  variantParamsSchema,
  variantSchema,
  type AdminCatalogQuery,
  type CatalogQuery,
  type CreateProduct,
  type CreateVariant,
  type UpdateProduct,
  type UpdateVariant,
} from "@pandora/contracts";
import { z } from "zod";
import { openApiSchema } from "../../common/openapi/zod-openapi.js";
import { ZodValidationPipe } from "../../common/validation/zod-validation.pipe.js";
import type { AuthContext } from "../auth/auth-context.js";
import {
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from "../auth/auth.constants.js";
import { CurrentAuth, Roles } from "../auth/decorators.js";
import { CatalogService } from "./catalog.service.js";

const error = openApiSchema(errorEnvelopeSchema);
function ResponseContract(schema: z.ZodType, status = 200) {
  return applyDecorators(
    ApiResponse({ status, schema: openApiSchema(schema) }),
  );
}
function ListQuery(admin = false) {
  const schema = openApiSchema(
    admin ? adminCatalogQuerySchema : catalogQuerySchema,
    "input",
  );
  return applyDecorators(
    ...Object.entries(schema.properties ?? {}).map(([name, property]) =>
      ApiQuery({ name, required: false, schema: property }),
    ),
  );
}
function Mutation(schema: z.ZodType) {
  return applyDecorators(
    ApiHeader({ name: CSRF_HEADER_NAME, required: true }),
    ApiBody({ schema: openApiSchema(schema, "input") }),
    ApiResponse({
      status: 400,
      description: "MALFORMED_REQUEST",
      schema: error,
    }),
  );
}
function ProductId() {
  return ApiParam({ name: "productId", format: "uuid" });
}

@ApiTags("catalog")
@ApiCookieAuth(SESSION_COOKIE_NAME)
@ApiResponse({ status: 401, description: "UNAUTHENTICATED", schema: error })
@ApiResponse({ status: 422, description: "VALIDATION_FAILED", schema: error })
@ApiResponse({ status: 404, description: "NOT_FOUND", schema: error })
@Controller("catalog/products")
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}
  @Get()
  @ListQuery()
  @ResponseContract(catalogResponseSchema)
  list(@Query(new ZodValidationPipe(catalogQuerySchema)) query: CatalogQuery) {
    return this.catalog.list(query);
  }

  @Get(":productId")
  @ProductId()
  @ResponseContract(productSchema)
  detail(
    @Param(new ZodValidationPipe(productParamsSchema))
    params: {
      productId: string;
    },
  ) {
    return this.catalog.detail(params.productId);
  }
}

@ApiTags("catalog administration")
@ApiCookieAuth(SESSION_COOKIE_NAME)
@ApiResponse({ status: 401, description: "UNAUTHENTICATED", schema: error })
@ApiResponse({
  status: 403,
  description: "FORBIDDEN or CSRF_TOKEN_INVALID",
  schema: error,
})
@ApiResponse({ status: 422, description: "VALIDATION_FAILED", schema: error })
@ApiResponse({ status: 404, description: "NOT_FOUND", schema: error })
@Roles("administrator")
@Controller("admin/catalog/products")
export class AdminCatalogController {
  constructor(private readonly catalog: CatalogService) {}
  @Get()
  @ListQuery(true)
  @ResponseContract(catalogResponseSchema)
  list(
    @Query(new ZodValidationPipe(adminCatalogQuerySchema))
    query: AdminCatalogQuery,
  ) {
    return this.catalog.list(query, true);
  }

  @Get(":productId")
  @ProductId()
  @ResponseContract(productSchema)
  detail(
    @Param(new ZodValidationPipe(productParamsSchema))
    params: {
      productId: string;
    },
  ) {
    return this.catalog.detail(params.productId, true);
  }

  @Post()
  @Mutation(createProductSchema)
  @ResponseContract(productSchema, 201)
  create(
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProduct,
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.catalog.createProduct(body, auth);
  }

  @Patch(":productId")
  @ProductId()
  @Mutation(updateProductSchema)
  @ResponseContract(productSchema)
  update(
    @Param(new ZodValidationPipe(productParamsSchema))
    params: { productId: string },
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProduct,
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.catalog.updateProduct(params.productId, body, auth);
  }

  @Post(":productId/variants")
  @ProductId()
  @Mutation(createVariantSchema)
  @ResponseContract(variantSchema, 201)
  @ApiResponse({
    status: 409,
    description: "SKU_ALREADY_EXISTS",
    schema: error,
  })
  createVariant(
    @Param(new ZodValidationPipe(productParamsSchema))
    params: { productId: string },
    @Body(new ZodValidationPipe(createVariantSchema)) body: CreateVariant,
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.catalog.createVariant(params.productId, body, auth);
  }

  @Patch(":productId/variants/:variantId")
  @ProductId()
  @ApiParam({ name: "variantId", format: "uuid" })
  @Mutation(updateVariantSchema)
  @ResponseContract(variantSchema)
  updateVariant(
    @Param(new ZodValidationPipe(variantParamsSchema))
    params: { productId: string; variantId: string },
    @Body(new ZodValidationPipe(updateVariantSchema)) body: UpdateVariant,
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.catalog.updateVariant(
      params.productId,
      params.variantId,
      body,
      auth,
    );
  }
}
