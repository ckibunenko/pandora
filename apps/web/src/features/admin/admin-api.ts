import {
  adminOrganizationSchema,
  adminUserSchema,
  organizationListResponseSchema,
  userListResponseSchema,
  type CreateOrganization,
  type CreateUser,
  type ResetPassword,
  type UpdateOrganization,
  type UpdateUser,
} from "@pandora/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { ApiError, request } from "../../lib/api-client";
import { SESSION_QUERY_KEY, useSession } from "../auth/session";

export const ADMIN_QUERY_KEY = ["admin"] as const;

export const fetchOrganizations = (query: string) =>
  request(`/admin/organizations?${query}`, { parse: (body) => organizationListResponseSchema.parse(body) });
export const fetchOrganization = (id: string) =>
  request(`/admin/organizations/${id}`, { parse: (body) => adminOrganizationSchema.parse(body) });
export const createOrganization = (body: CreateOrganization) =>
  request("/admin/organizations", { method: "POST", body, parse: (value) => adminOrganizationSchema.parse(value) });
export const updateOrganization = (id: string, body: UpdateOrganization) =>
  request(`/admin/organizations/${id}`, { method: "PATCH", body, parse: (value) => adminOrganizationSchema.parse(value) });

export const fetchUsers = (query: string) =>
  request(`/admin/users?${query}`, { parse: (body) => userListResponseSchema.parse(body) });
export const fetchUser = (id: string) => request(`/admin/users/${id}`, { parse: (body) => adminUserSchema.parse(body) });
export const createUser = (body: CreateUser) =>
  request("/admin/users", { method: "POST", body, parse: (value) => adminUserSchema.parse(value) });
export const updateUser = (id: string, body: UpdateUser) =>
  request(`/admin/users/${id}`, { method: "PATCH", body, parse: (value) => adminUserSchema.parse(value) });
export const resetPassword = (id: string, body: ResetPassword) =>
  request(`/admin/users/${id}/password`, { method: "POST", body, parse: (value) => adminUserSchema.parse(value) });

/** An ended session (for example after administrators change their own account) returns the user to sign-in. */
export function useAdminExpiredSession(error: unknown) {
  const client = useQueryClient();
  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) {
      client.removeQueries({ queryKey: ADMIN_QUERY_KEY });
      void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    }
  }, [client, error]);
}

function useAdminQuery<T>(key: readonly unknown[], queryFn: () => Promise<T>, enabled = true) {
  const session = useSession();
  const result = useQuery({
    queryKey: [...ADMIN_QUERY_KEY, session.data?.user.id, ...key],
    queryFn,
    retry: false,
    enabled: enabled && session.data?.user.role === "administrator",
  });
  useAdminExpiredSession(result.error);
  return result;
}

export const useOrganizations = (query: string) => useAdminQuery(["organizations", query], () => fetchOrganizations(query));
export const useOrganization = (id: string) => useAdminQuery(["organization", id], () => fetchOrganization(id), !!id);
export const useUsers = (query: string, enabled = true) => useAdminQuery(["users", query], () => fetchUsers(query), enabled);
export const useUser = (id: string) => useAdminQuery(["user", id], () => fetchUser(id), !!id);

/** Refreshes admin lists and, when administrators edit themselves, the signed-in header. */
export function useAdminRefresh() {
  const client = useQueryClient();
  return async () => {
    await client.invalidateQueries({ queryKey: ADMIN_QUERY_KEY });
    await client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  };
}

export const organizationTypeLabel = (type: "distributor" | "retailer") => (type === "distributor" ? "Distributor" : "Retailer");
