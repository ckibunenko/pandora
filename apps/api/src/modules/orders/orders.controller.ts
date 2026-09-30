import { applyDecorators, Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from "@nestjs/common";
import { ApiBody, ApiCookieAuth, ApiHeader, ApiParam, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  cancelOrderSchema,
  createOrderSchema,
  errorEnvelopeSchema,
  orderListResponseSchema,
  orderParamsSchema,
  orderQuerySchema,
  orderSchema,
  saveOrderLinesSchema,
  submitOrderSchema,
  type CancelOrder,
  type CreateOrder,
  type Order,
  type OrderListResponse,
  type OrderQuery,
  type SaveOrderLines,
  type SubmitOrder,
} from "@pandora/contracts";
import type { z } from "zod";
import { IDEMPOTENCY_KEY_HEADER, IdempotencyKey } from "../../common/idempotency/idempotency-key.decorator.js";
import { openApiSchema } from "../../common/openapi/zod-openapi.js";
import { ZodValidationPipe } from "../../common/validation/zod-validation.pipe.js";
import type { AuthContext } from "../auth/auth-context.js";
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from "../auth/auth.constants.js";
import { CurrentAuth, Roles } from "../auth/decorators.js";
import { OrdersService } from "./orders.service.js";

const ERROR_SCHEMA = openApiSchema(errorEnvelopeSchema);
const ORDER_SCHEMA = openApiSchema(orderSchema);

type OrderParams = z.infer<typeof orderParamsSchema>;

function queryParams(schema: z.ZodType) {
  const properties = openApiSchema(schema, "input").properties ?? {};
  return applyDecorators(
    ...Object.entries(properties).map(([name, property]) => ApiQuery({ name, required: false, schema: property })),
  );
}

function orderMutation(schema: z.ZodType, status: number, conflicts: string, idempotent: boolean) {
  return applyDecorators(
    Roles("retailer"),
    ApiHeader({ name: CSRF_HEADER_NAME, required: true }),
    ...(idempotent
      ? [ApiHeader({ name: IDEMPOTENCY_KEY_HEADER, required: true, description: "1–255 printable ASCII characters." })]
      : []),
    ApiBody({ schema: openApiSchema(schema, "input") }),
    ApiResponse({ status, description: idempotent ? "Applied, or the original response replayed." : "Applied.", schema: ORDER_SCHEMA }),
    ApiResponse({ status: 409, description: conflicts, schema: ERROR_SCHEMA }),
  );
}

@ApiTags("orders")
@ApiCookieAuth(SESSION_COOKIE_NAME)
@ApiResponse({ status: 400, description: "MALFORMED_REQUEST or IDEMPOTENCY_KEY_REQUIRED", schema: ERROR_SCHEMA })
@ApiResponse({ status: 401, description: "UNAUTHENTICATED", schema: ERROR_SCHEMA })
@ApiResponse({ status: 403, description: "FORBIDDEN or CSRF_TOKEN_INVALID", schema: ERROR_SCHEMA })
@ApiResponse({ status: 404, description: "NOT_FOUND (also for another organization's order)", schema: ERROR_SCHEMA })
@ApiResponse({ status: 422, description: "VALIDATION_FAILED", schema: ERROR_SCHEMA })
@Controller("orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @queryParams(orderQuerySchema)
  @ApiResponse({ status: 200, schema: openApiSchema(orderListResponseSchema) })
  list(
    @Query(new ZodValidationPipe(orderQuerySchema)) query: OrderQuery,
    @CurrentAuth() auth: AuthContext,
  ): Promise<OrderListResponse> {
    return this.orders.list(query, auth);
  }

  @Get(":orderId")
  @ApiParam({ name: "orderId", format: "uuid" })
  @ApiResponse({ status: 200, schema: ORDER_SCHEMA })
  detail(@Param(new ZodValidationPipe(orderParamsSchema)) params: OrderParams, @CurrentAuth() auth: AuthContext): Promise<Order> {
    return this.orders.detail(params.orderId, auth);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @orderMutation(createOrderSchema, 201, "IDEMPOTENCY_KEY_REUSED, REQUEST_IN_PROGRESS, or CONCURRENT_MODIFICATION", true)
  create(
    @Body(new ZodValidationPipe(createOrderSchema)) body: CreateOrder,
    @IdempotencyKey() key: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<Order> {
    return this.orders.create(body, auth, key);
  }

  @Put(":orderId/lines")
  @ApiParam({ name: "orderId", format: "uuid" })
  @orderMutation(saveOrderLinesSchema, 200, "VERSION_CONFLICT, INVALID_ORDER_TRANSITION, or CONCURRENT_MODIFICATION", false)
  saveLines(
    @Param(new ZodValidationPipe(orderParamsSchema)) params: OrderParams,
    @Body(new ZodValidationPipe(saveOrderLinesSchema)) body: SaveOrderLines,
    @CurrentAuth() auth: AuthContext,
  ): Promise<Order> {
    return this.orders.saveLines(params.orderId, body, auth);
  }

  @Post(":orderId/submit")
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: "orderId", format: "uuid" })
  @orderMutation(
    submitOrderSchema,
    200,
    "VERSION_CONFLICT, INVALID_ORDER_TRANSITION, VARIANT_UNAVAILABLE, PRICE_CHANGED, IDEMPOTENCY_KEY_REUSED, REQUEST_IN_PROGRESS, or CONCURRENT_MODIFICATION",
    true,
  )
  submit(
    @Param(new ZodValidationPipe(orderParamsSchema)) params: OrderParams,
    @Body(new ZodValidationPipe(submitOrderSchema)) body: SubmitOrder,
    @IdempotencyKey() key: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<Order> {
    return this.orders.submit(params.orderId, body, auth, key);
  }

  @Post(":orderId/cancel")
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: "orderId", format: "uuid" })
  @orderMutation(
    cancelOrderSchema,
    200,
    "VERSION_CONFLICT, INVALID_ORDER_TRANSITION, IDEMPOTENCY_KEY_REUSED, REQUEST_IN_PROGRESS, or CONCURRENT_MODIFICATION",
    true,
  )
  cancel(
    @Param(new ZodValidationPipe(orderParamsSchema)) params: OrderParams,
    @Body(new ZodValidationPipe(cancelOrderSchema)) body: CancelOrder,
    @IdempotencyKey() key: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<Order> {
    return this.orders.cancel(params.orderId, body, auth, key);
  }
}
