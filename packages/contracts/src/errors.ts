import { z } from "zod";

export const ERROR_CODES = {
  skuAlreadyExists: "SKU_ALREADY_EXISTS",
  malformedRequest: "MALFORMED_REQUEST",
  validationFailed: "VALIDATION_FAILED",
  unauthenticated: "UNAUTHENTICATED",
  invalidCredentials: "INVALID_CREDENTIALS",
  forbidden: "FORBIDDEN",
  csrfTokenInvalid: "CSRF_TOKEN_INVALID",
  notFound: "NOT_FOUND",
  internalError: "INTERNAL_ERROR",
  insufficientStock: "INSUFFICIENT_STOCK",
  idempotencyKeyRequired: "IDEMPOTENCY_KEY_REQUIRED",
  idempotencyKeyReused: "IDEMPOTENCY_KEY_REUSED",
  requestInProgress: "REQUEST_IN_PROGRESS",
  concurrentModification: "CONCURRENT_MODIFICATION",
  versionConflict: "VERSION_CONFLICT",
  priceChanged: "PRICE_CHANGED",
  invalidOrderTransition: "INVALID_ORDER_TRANSITION",
  variantUnavailable: "VARIANT_UNAVAILABLE",
} as const;

export const errorDetailSchema = z.object({
  field: z.string(),
  message: z.string(),
});

export const errorEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string(),
  correlation_id: z.string(),
  details: z.array(errorDetailSchema).optional(),
});

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
export type ErrorDetail = z.infer<typeof errorDetailSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
