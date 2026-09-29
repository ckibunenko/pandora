import { z } from "zod";

export const healthStatusSchema = z.enum(["ok", "unavailable"]);

export const healthResponseSchema = z.object({
  status: healthStatusSchema,
  checks: z.object({
    database: healthStatusSchema,
  }).optional(),
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
