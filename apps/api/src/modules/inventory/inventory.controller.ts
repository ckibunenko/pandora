import { applyDecorators, Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { ApiBody, ApiCookieAuth, ApiHeader, ApiParam, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  adjustmentRequestSchema,
  errorEnvelopeSchema,
  inventoryItemSchema,
  inventoryListResponseSchema,
  inventoryParamsSchema,
  inventoryQuerySchema,
  movementListResponseSchema,
  movementsQuerySchema,
  receiptRequestSchema,
  stockChangeResponseSchema,
  type AdjustmentRequest,
  type InventoryItem,
  type InventoryListResponse,
  type InventoryQuery,
  type MovementListResponse,
  type MovementsQuery,
  type ReceiptRequest,
  type StockChangeResponse,
} from "@pandora/contracts";
import type { z } from "zod";
import { IDEMPOTENCY_KEY_HEADER, IdempotencyKey } from "../../common/idempotency/idempotency-key.decorator.js";
import { openApiSchema } from "../../common/openapi/zod-openapi.js";
import { ZodValidationPipe } from "../../common/validation/zod-validation.pipe.js";
import type { AuthContext } from "../auth/auth-context.js";
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from "../auth/auth.constants.js";
import { CurrentAuth, Roles } from "../auth/decorators.js";
import { InventoryService } from "./inventory.service.js";

const ERROR_SCHEMA = openApiSchema(errorEnvelopeSchema);

function queryParams(schema: z.ZodType) {
  const properties = openApiSchema(schema, "input").properties ?? {};
  return applyDecorators(
    ...Object.entries(properties).map(([name, property]) => ApiQuery({ name, required: false, schema: property })),
  );
}

function stockChange(schema: z.ZodType) {
  return applyDecorators(
    ApiHeader({ name: CSRF_HEADER_NAME, required: true }),
    ApiHeader({ name: IDEMPOTENCY_KEY_HEADER, required: true, description: "1–255 printable ASCII characters." }),
    ApiBody({ schema: openApiSchema(schema, "input") }),
    ApiResponse({ status: 201, description: "Change recorded, or the original response replayed.", schema: openApiSchema(stockChangeResponseSchema) }),
    ApiResponse({ status: 400, description: "MALFORMED_REQUEST or IDEMPOTENCY_KEY_REQUIRED", schema: ERROR_SCHEMA }),
    ApiResponse({
      status: 409,
      description: "INSUFFICIENT_STOCK, IDEMPOTENCY_KEY_REUSED, REQUEST_IN_PROGRESS, or CONCURRENT_MODIFICATION",
      schema: ERROR_SCHEMA,
    }),
  );
}

type VariantParams = z.infer<typeof inventoryParamsSchema>;

@ApiTags("inventory")
@ApiCookieAuth(SESSION_COOKIE_NAME)
@ApiResponse({ status: 401, description: "UNAUTHENTICATED", schema: ERROR_SCHEMA })
@ApiResponse({ status: 403, description: "FORBIDDEN or CSRF_TOKEN_INVALID", schema: ERROR_SCHEMA })
@ApiResponse({ status: 404, description: "NOT_FOUND", schema: ERROR_SCHEMA })
@ApiResponse({ status: 422, description: "VALIDATION_FAILED", schema: ERROR_SCHEMA })
@Roles("operator", "administrator")
@Controller("inventory")
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @queryParams(inventoryQuerySchema)
  @ApiResponse({ status: 200, schema: openApiSchema(inventoryListResponseSchema) })
  list(@Query(new ZodValidationPipe(inventoryQuerySchema)) query: InventoryQuery): Promise<InventoryListResponse> {
    return this.inventory.list(query);
  }

  @Get(":variantId")
  @ApiParam({ name: "variantId", format: "uuid" })
  @ApiResponse({ status: 200, schema: openApiSchema(inventoryItemSchema) })
  detail(@Param(new ZodValidationPipe(inventoryParamsSchema)) params: VariantParams): Promise<InventoryItem> {
    return this.inventory.detail(params.variantId);
  }

  @Get(":variantId/movements")
  @ApiParam({ name: "variantId", format: "uuid" })
  @queryParams(movementsQuerySchema)
  @ApiResponse({ status: 200, schema: openApiSchema(movementListResponseSchema) })
  movements(
    @Param(new ZodValidationPipe(inventoryParamsSchema)) params: VariantParams,
    @Query(new ZodValidationPipe(movementsQuerySchema)) query: MovementsQuery,
  ): Promise<MovementListResponse> {
    return this.inventory.movements(params.variantId, query);
  }

  @Post(":variantId/receipts")
  @HttpCode(HttpStatus.CREATED)
  @ApiParam({ name: "variantId", format: "uuid" })
  @stockChange(receiptRequestSchema)
  receive(
    @Param(new ZodValidationPipe(inventoryParamsSchema)) params: VariantParams,
    @Body(new ZodValidationPipe(receiptRequestSchema)) body: ReceiptRequest,
    @IdempotencyKey() key: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<StockChangeResponse> {
    return this.inventory.receive(params.variantId, body, auth, key);
  }

  @Post(":variantId/adjustments")
  @HttpCode(HttpStatus.CREATED)
  @ApiParam({ name: "variantId", format: "uuid" })
  @stockChange(adjustmentRequestSchema)
  adjust(
    @Param(new ZodValidationPipe(inventoryParamsSchema)) params: VariantParams,
    @Body(new ZodValidationPipe(adjustmentRequestSchema)) body: AdjustmentRequest,
    @IdempotencyKey() key: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<StockChangeResponse> {
    return this.inventory.adjust(params.variantId, body, auth, key);
  }
}
