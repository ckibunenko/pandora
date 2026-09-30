import { z } from "zod";
import { organizationTypeSchema, userRoleSchema } from "./auth.js";
import { pageSchema, pageSizeSchema, paginatedResponseSchema } from "./pagination.js";

const name = z.string().trim().min(1).max(120);
/** Upper bound keeps password hashing cost bounded; the minimum matches the seeded demo accounts. */
export const adminPasswordSchema = z.string().min(12).max(256);
const statusFilter = z.enum(["all", "active", "inactive"]).default("all");

export const organizationParamsSchema = z.object({ organizationId: z.uuid() });
export const userParamsSchema = z.object({ userId: z.uuid() });

export const organizationQuerySchema = z.strictObject({
  page: pageSchema,
  pageSize: pageSizeSchema,
  q: z.string().trim().max(120).optional(),
  type: organizationTypeSchema.optional(),
  status: statusFilter,
});
export const createOrganizationSchema = z.strictObject({ name });
export const updateOrganizationSchema = z
  .strictObject({ name, isActive: z.boolean() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one editable field.");

export const adminOrganizationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: organizationTypeSchema,
  isActive: z.boolean(),
  userCount: z.number().int().nonnegative(),
  activeUserCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export const organizationListResponseSchema = paginatedResponseSchema(adminOrganizationSchema);

export const userQuerySchema = z.strictObject({
  page: pageSchema,
  pageSize: pageSizeSchema,
  q: z.string().trim().max(254).optional(),
  organizationId: z.uuid().optional(),
  role: userRoleSchema.optional(),
  status: statusFilter,
});
export const createUserSchema = z.strictObject({
  email: z.email().max(254).transform((value) => value.toLowerCase()),
  displayName: name,
  organizationId: z.uuid(),
  role: userRoleSchema,
  password: adminPasswordSchema,
});
export const updateUserSchema = z
  .strictObject({ displayName: name, role: userRoleSchema, isActive: z.boolean() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one editable field.");
export const resetPasswordSchema = z.strictObject({ password: adminPasswordSchema });

export const adminUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  displayName: z.string(),
  role: userRoleSchema,
  isActive: z.boolean(),
  organization: z.object({
    id: z.uuid(),
    name: z.string(),
    type: organizationTypeSchema,
    isActive: z.boolean(),
  }),
  createdAt: z.iso.datetime(),
});
export const userListResponseSchema = paginatedResponseSchema(adminUserSchema);

/** Staff roles belong to the distributor; retailer users belong to retailer organizations. */
export function rolesFor(type: z.infer<typeof organizationTypeSchema>): readonly z.infer<typeof userRoleSchema>[] {
  return type === "distributor" ? ["operator", "administrator"] : ["retailer"];
}

export type AdminOrganization = z.infer<typeof adminOrganizationSchema>;
export type OrganizationListResponse = z.infer<typeof organizationListResponseSchema>;
export type OrganizationQuery = z.infer<typeof organizationQuerySchema>;
export type CreateOrganization = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganization = z.infer<typeof updateOrganizationSchema>;
export type AdminUser = z.infer<typeof adminUserSchema>;
export type UserListResponse = z.infer<typeof userListResponseSchema>;
export type UserQuery = z.infer<typeof userQuerySchema>;
export type CreateUser = z.infer<typeof createUserSchema>;
export type UpdateUser = z.infer<typeof updateUserSchema>;
export type ResetPassword = z.infer<typeof resetPasswordSchema>;
