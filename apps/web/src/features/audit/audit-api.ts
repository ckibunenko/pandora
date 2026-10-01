import { auditEventSchema, auditListResponseSchema } from "@pandora/contracts";
import { useQuery } from "@tanstack/react-query";
import { request } from "../../lib/api-client";
import { useSession } from "../auth/session";
import { useExpiredSession } from "../catalog/catalog-api";

function useAuditQuery<T>(key: readonly unknown[], queryFn: () => Promise<T>) {
  const session = useSession();
  const role = session.data?.user.role;
  const result = useQuery({
    queryKey: ["audit", session.data?.user.id, ...key], queryFn, retry: false,
    enabled: role === "operator" || role === "administrator",
  });
  useExpiredSession(result.error);
  return result;
}

export const useAuditEvents = (query: string) => useAuditQuery(["list", query], () =>
  request(`/audit-events?${query}`, { parse: (body) => auditListResponseSchema.parse(body) }));
export const useAuditEvent = (eventId: string) => useAuditQuery(["event", eventId], () =>
  request(`/audit-events/${eventId}`, { parse: (body) => auditEventSchema.parse(body) }));

export const auditDate = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/Belgrade" });
