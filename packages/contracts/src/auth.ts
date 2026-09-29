import { z } from "zod";

export const userRoleSchema = z.enum(["retailer", "operator", "administrator"]);
export const organizationTypeSchema = z.enum(["distributor", "retailer"]);

export const loginRequestSchema = z.strictObject({
  email: z.email().max(254),
  // Upper bound keeps password hashing cost bounded for oversized input.
  password: z.string().min(1).max(256),
});

export const sessionUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  displayName: z.string(),
  role: userRoleSchema,
  organization: z.object({
    id: z.uuid(),
    name: z.string(),
    type: organizationTypeSchema,
  }),
});

export const sessionResponseSchema = z.object({
  user: sessionUserSchema,
  csrfToken: z.string(),
});

export type UserRole = z.infer<typeof userRoleSchema>;
export type OrganizationType = z.infer<typeof organizationTypeSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type SessionUser = z.infer<typeof sessionUserSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
