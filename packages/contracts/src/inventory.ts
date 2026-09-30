import { z } from "zod";
import { catalogLanguageSchema } from "./catalog.js";
import { pageSchema, pageSizeSchema, paginatedResponseSchema } from "./pagination.js";

export const MAX_STOCK_CHANGE = 1_000_000;

/** Buckets staff may adjust directly; reserved stock changes only through order workflows. */
export const stockBucketSchema = z.enum(["sellable", "damaged"]);
export const movementBucketSchema = z.enum(["sellable", "damaged", "reserved"]);
export const movementTypeSchema = z.enum(["opening_balance", "receipt", "adjustment", "reservation", "shipment", "release"]);

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

export const receiptRequestSchema = z.strictObject({
  quantity: z.number().int().min(1).max(MAX_STOCK_CHANGE),
  reference: optionalText(80),
  note: optionalText(500),
});

export const adjustmentRequestSchema = z.strictObject({
  bucket: stockBucketSchema,
  delta: z
    .number()
    .int()
    .min(-MAX_STOCK_CHANGE)
    .max(MAX_STOCK_CHANGE)
    .refine((value) => value !== 0, "Delta must not be zero."),
  reason: z.string().trim().min(3).max(500),
});

export const inventoryParamsSchema = z.object({ variantId: z.uuid() });

export const inventoryQuerySchema = z.strictObject({
  page: pageSchema,
  pageSize: pageSizeSchema,
  q: z.string().trim().max(120).optional(),
  stock: z.enum(["all", "available", "unavailable"]).default("all"),
});

export const movementsQuerySchema = z.strictObject({
  page: pageSchema,
  pageSize: pageSizeSchema,
});

export const inventoryItemSchema = z.object({
  variantId: z.uuid(),
  sku: z.string(),
  language: catalogLanguageSchema,
  edition: z.string(),
  variantIsActive: z.boolean(),
  product: z.object({ id: z.uuid(), name: z.string(), isActive: z.boolean() }),
  sellable: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  damaged: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
});

export const inventoryMovementSchema = z.object({
  id: z.uuid(),
  variantId: z.uuid(),
  type: movementTypeSchema,
  bucket: movementBucketSchema,
  delta: z.number().int(),
  sellableAfter: z.number().int().nonnegative(),
  reservedAfter: z.number().int().nonnegative(),
  damagedAfter: z.number().int().nonnegative(),
  reference: z.string().nullable(),
  note: z.string().nullable(),
  reason: z.string().nullable(),
  actor: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  occurredAt: z.iso.datetime(),
});

export const inventoryListResponseSchema = paginatedResponseSchema(inventoryItemSchema);
export const movementListResponseSchema = paginatedResponseSchema(inventoryMovementSchema);

export const stockChangeResponseSchema = z.object({
  movement: inventoryMovementSchema,
  item: inventoryItemSchema,
});

export type StockBucket = z.infer<typeof stockBucketSchema>;
export type MovementBucket = z.infer<typeof movementBucketSchema>;
export type MovementType = z.infer<typeof movementTypeSchema>;
export type ReceiptRequest = z.infer<typeof receiptRequestSchema>;
export type AdjustmentRequest = z.infer<typeof adjustmentRequestSchema>;
export type InventoryQuery = z.infer<typeof inventoryQuerySchema>;
export type MovementsQuery = z.infer<typeof movementsQuerySchema>;
export type InventoryItem = z.infer<typeof inventoryItemSchema>;
export type InventoryMovement = z.infer<typeof inventoryMovementSchema>;
export type InventoryListResponse = z.infer<typeof inventoryListResponseSchema>;
export type MovementListResponse = z.infer<typeof movementListResponseSchema>;
export type StockChangeResponse = z.infer<typeof stockChangeResponseSchema>;
