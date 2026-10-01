import { z } from "zod";
import { catalogCurrencySchema, catalogLanguageSchema } from "./catalog.js";
import { pageSchema, pageSizeSchema, paginatedResponseSchema } from "./pagination.js";

export const MAX_ORDER_LINES = 100;
export const MAX_LINE_QUANTITY = 10_000;

export const orderStatusSchema = z.enum([
  "draft",
  "submitted",
  "cancelled",
  "confirmed",
  "rejected",
  "partially_shipped",
  "shipped",
  "closed_partial",
]);
export const cancellationRequestStatusSchema = z.enum(["pending", "approved", "rejected"]);
export const priceStatusSchema = z.enum(["provisional", "frozen"]);

const versionSchema = z.number().int().min(1);
const priceSchema = z.number().int().min(0).max(2_147_483_647);

const lineInputSchema = z.strictObject({
  variantId: z.uuid(),
  quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
});

const linesInputSchema = z
  .array(lineInputSchema)
  .max(MAX_ORDER_LINES)
  .superRefine((lines, ctx) => {
    const seen = new Set<string>();
    lines.forEach((line, index) => {
      if (seen.has(line.variantId)) {
        ctx.addIssue({ code: "custom", path: [index, "variantId"], message: "Each variant can appear only once." });
      }
      seen.add(line.variantId);
    });
  });

export const createOrderSchema = z.strictObject({ lines: linesInputSchema.default([]) });

export const saveOrderLinesSchema = z.strictObject({ version: versionSchema, lines: linesInputSchema });

export const submitOrderSchema = z.strictObject({
  version: versionSchema,
  /** The unit price the retailer reviewed for every line; any drift blocks submission. */
  reviewedPrices: z
    .array(z.strictObject({ variantId: z.uuid(), unitPriceMinor: priceSchema }))
    .max(MAX_ORDER_LINES),
});

export const cancelOrderSchema = z.strictObject({
  version: versionSchema,
  reason: z.string().trim().min(1).max(500).optional(),
});

export const confirmOrderSchema = z.strictObject({ version: versionSchema });

export const rejectOrderSchema = z.strictObject({
  version: versionSchema,
  reason: z.string().trim().min(3).max(500),
});

const fulfillmentItemsInputSchema = z
  .array(z.strictObject({ orderLineId: z.uuid(), quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY) }))
  .min(1)
  .max(MAX_ORDER_LINES)
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.orderLineId)) {
        ctx.addIssue({ code: "custom", path: [index, "orderLineId"], message: "Each line can appear only once." });
      }
      seen.add(item.orderLineId);
    });
  });

export const shipOrderSchema = z.strictObject({ version: versionSchema, items: fulfillmentItemsInputSchema });

export const requestCancellationSchema = z.strictObject({
  version: versionSchema,
  reason: z.string().trim().min(1).max(500).optional(),
  /** Unshipped quantities to cancel; omitted means every outstanding unit. */
  items: fulfillmentItemsInputSchema.optional(),
});

export const approveCancellationSchema = z.strictObject({ version: versionSchema });

export const rejectCancellationSchema = z.strictObject({
  version: versionSchema,
  reason: z.string().trim().min(3).max(500),
});

export const orderParamsSchema = z.object({ orderId: z.uuid() });
export const cancellationRequestParamsSchema = z.object({ orderId: z.uuid(), requestId: z.uuid() });

export const orderQuerySchema = z.strictObject({
  page: pageSchema,
  pageSize: pageSizeSchema,
  status: orderStatusSchema.optional(),
  /** `submitted_asc` lists the processing queue oldest submission first. */
  sort: z.enum(["created_desc", "submitted_asc"]).default("created_desc"),
});

const actorSchema = z.object({ id: z.uuid(), displayName: z.string() });

export const orderLineSchema = z.object({
  id: z.uuid(),
  variantId: z.uuid(),
  sku: z.string(),
  productName: z.string(),
  language: catalogLanguageSchema,
  edition: z.string(),
  quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
  unitPriceMinor: priceSchema,
  lineTotalMinor: z.number().int().nonnegative(),
  /** Drafts: whether the variant is still visible in the catalog. Frozen lines are always true. */
  isAvailable: z.boolean(),
  /** Current available stock while the order awaits a decision (informational, not reserved); otherwise null. */
  availableQuantity: z.number().int().nonnegative().nullable(),
  /** Units held for this line once the order is confirmed; null before that. */
  reservedQuantity: z.number().int().nonnegative().nullable(),
  shippedQuantity: z.number().int().nonnegative(),
  cancelledQuantity: z.number().int().nonnegative(),
  /** ordered − shipped − cancelled */
  outstandingQuantity: z.number().int().nonnegative(),
});

const fulfillmentItemSchema = z.object({ orderLineId: z.uuid(), sku: z.string(), quantity: z.number().int().positive() });

export const shipmentSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  createdAt: z.iso.datetime(),
  createdBy: z.object({ id: z.uuid(), displayName: z.string() }),
  items: z.array(fulfillmentItemSchema),
});

export const cancellationRequestSchema = z.object({
  id: z.uuid(),
  status: cancellationRequestStatusSchema,
  reason: z.string().nullable(),
  requestedBy: z.object({ id: z.uuid(), displayName: z.string() }),
  requestedAt: z.iso.datetime(),
  decidedBy: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  decidedAt: z.iso.datetime().nullable(),
  decisionReason: z.string().nullable(),
  items: z.array(fulfillmentItemSchema),
});

const orderFields = {
  id: z.uuid(),
  number: z.string(),
  status: orderStatusSchema,
  version: versionSchema,
  organization: z.object({ id: z.uuid(), name: z.string() }),
  currency: catalogCurrencySchema,
  priceStatus: priceStatusSchema,
  totalMinor: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  submittedAt: z.iso.datetime().nullable(),
};

export const orderSummarySchema = z.object({ ...orderFields, lineCount: z.number().int().nonnegative() });

export const orderSchema = z.object({
  ...orderFields,
  lines: z.array(orderLineSchema),
  createdBy: actorSchema,
  submittedBy: actorSchema.nullable(),
  cancelledBy: actorSchema.nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  cancellationReason: z.string().nullable(),
  confirmedBy: actorSchema.nullable(),
  confirmedAt: z.iso.datetime().nullable(),
  rejectedBy: actorSchema.nullable(),
  rejectedAt: z.iso.datetime().nullable(),
  rejectionReason: z.string().nullable(),
  shipments: z.array(shipmentSchema),
  cancellationRequests: z.array(cancellationRequestSchema),
});

export const orderListResponseSchema = paginatedResponseSchema(orderSummarySchema);

export type OrderStatus = z.infer<typeof orderStatusSchema>;
export type CreateOrder = z.infer<typeof createOrderSchema>;
export type SaveOrderLines = z.infer<typeof saveOrderLinesSchema>;
export type SubmitOrder = z.infer<typeof submitOrderSchema>;
export type CancelOrder = z.infer<typeof cancelOrderSchema>;
export type ConfirmOrder = z.infer<typeof confirmOrderSchema>;
export type RejectOrder = z.infer<typeof rejectOrderSchema>;
export type ShipOrder = z.infer<typeof shipOrderSchema>;
export type RequestCancellation = z.infer<typeof requestCancellationSchema>;
export type ApproveCancellation = z.infer<typeof approveCancellationSchema>;
export type RejectCancellation = z.infer<typeof rejectCancellationSchema>;
export type Shipment = z.infer<typeof shipmentSchema>;
export type CancellationRequest = z.infer<typeof cancellationRequestSchema>;
export type OrderQuery = z.infer<typeof orderQuerySchema>;
export type OrderLine = z.infer<typeof orderLineSchema>;
export type Order = z.infer<typeof orderSchema>;
export type OrderSummary = z.infer<typeof orderSummarySchema>;
export type OrderListResponse = z.infer<typeof orderListResponseSchema>;
