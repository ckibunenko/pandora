import { z } from "zod";
import { pageSchema, pageSizeSchema, paginatedResponseSchema } from "./pagination.js";

export const auditEntityTypeSchema = z.enum(["product", "variant", "inventory_item", "order", "organization", "user"]);

export const auditQuerySchema = z.strictObject({
  page: pageSchema,
  pageSize: pageSizeSchema,
  entityType: auditEntityTypeSchema.optional(),
  entityId: z.uuid().optional(),
  action: z.string().trim().min(1).max(80).optional(),
  actorId: z.uuid().optional(),
  organizationId: z.uuid().optional(),
  correlationId: z.string().trim().min(1).max(64).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
}).superRefine((query, ctx) => {
  if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) {
    ctx.addIssue({ code: "custom", path: ["to"], message: "End must be at or after start." });
  }
});

export const auditParamsSchema = z.object({ eventId: z.uuid() });

export const auditEventSummarySchema = z.object({
  id: z.uuid(),
  entityType: z.string(),
  entityId: z.uuid(),
  action: z.string(),
  occurredAt: z.iso.datetime(),
  correlationId: z.string(),
  actor: z.object({ id: z.uuid(), displayName: z.string().nullable() }),
  organization: z.object({ id: z.uuid(), name: z.string().nullable() }),
});

export const auditEventSchema = auditEventSummarySchema.extend({
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()),
});
export const auditListResponseSchema = paginatedResponseSchema(auditEventSummarySchema);

export type AuditQuery = z.infer<typeof auditQuerySchema>;
export type AuditEventSummary = z.infer<typeof auditEventSummarySchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditListResponse = z.infer<typeof auditListResponseSchema>;
