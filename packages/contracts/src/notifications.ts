import { z } from "zod";
import { pageSchema, pageSizeSchema, paginatedResponseSchema } from "./pagination.js";

/** Attempts per job before it fails; a manual retry grants one more. */
export const NOTIFICATION_MAX_ATTEMPTS = 5;

export const notificationEventTypeSchema = z.enum([
  "order.submitted",
  "order.confirmed",
  "order.rejected",
  "shipment.recorded",
  "cancellation.requested",
  "cancellation.decided",
  "return.requested",
  "return.decided",
  "return.received",
]);
export const notificationStatusSchema = z.enum(["pending", "sending", "sent", "failed"]);
export const notificationAttemptOutcomeSchema = z.enum(["in_progress", "sent", "failed", "ambiguous"]);

export const notificationQuerySchema = z.strictObject({
  page: pageSchema,
  pageSize: pageSizeSchema,
  status: notificationStatusSchema.optional(),
  eventType: notificationEventTypeSchema.optional(),
});

export const notificationParamsSchema = z.object({ notificationId: z.uuid() });

export const retryNotificationSchema = z.strictObject({});

export const notificationSummarySchema = z.object({
  id: z.uuid(),
  eventType: notificationEventTypeSchema,
  status: notificationStatusSchema,
  order: z.object({ id: z.uuid(), number: z.string() }),
  recipient: z.object({ id: z.uuid(), displayName: z.string() }),
  /** Administrators only; null for operators (operational scope). */
  recipientEmail: z.string().nullable(),
  subject: z.string(),
  attemptCount: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  nextAttemptAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  correlationId: z.string(),
  createdAt: z.iso.datetime(),
  sentAt: z.iso.datetime().nullable(),
});

export const notificationAttemptSchema = z.object({
  number: z.number().int().positive(),
  workerId: z.string(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  outcome: notificationAttemptOutcomeSchema,
  error: z.string().nullable(),
});

export const notificationSchema = notificationSummarySchema.extend({
  /** Administrators only; null for operators. */
  body: z.string().nullable(),
  attempts: z.array(notificationAttemptSchema),
});

export const notificationListResponseSchema = paginatedResponseSchema(notificationSummarySchema);

export type NotificationEventType = z.infer<typeof notificationEventTypeSchema>;
export type NotificationStatus = z.infer<typeof notificationStatusSchema>;
export type NotificationQuery = z.infer<typeof notificationQuerySchema>;
export type RetryNotification = z.infer<typeof retryNotificationSchema>;
export type NotificationSummary = z.infer<typeof notificationSummarySchema>;
export type NotificationAttempt = z.infer<typeof notificationAttemptSchema>;
export type Notification = z.infer<typeof notificationSchema>;
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;
