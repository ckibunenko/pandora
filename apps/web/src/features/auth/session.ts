import { useQuery } from "@tanstack/react-query";
import type { UserRole } from "@pandora/contracts";
import { fetchSession } from "../../lib/api-client";

export const SESSION_QUERY_KEY = ["auth", "session"] as const;

export function useSession() {
  return useQuery({ queryKey: SESSION_QUERY_KEY, queryFn: fetchSession, retry: false });
}

const ROLE_LABELS: Record<UserRole, string> = {
  retailer: "Retailer",
  operator: "Distributor operator",
  administrator: "Administrator",
};

export function roleLabel(role: UserRole): string {
  return ROLE_LABELS[role];
}
