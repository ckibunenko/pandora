import { notificationListResponseSchema, notificationSchema, type NotificationEventType, type NotificationStatus } from "@pandora/contracts";
import { useQuery } from "@tanstack/react-query";
import { request } from "../../lib/api-client";
import { useSession } from "../auth/session";
import { useExpiredSession } from "../catalog/catalog-api";

export const NOTIFICATIONS_QUERY_KEY = ["notifications"] as const;

const IN_FLIGHT_REFRESH_MS = 2_000;
const inFlight = (status: NotificationStatus) => status === "pending" || status === "sending";

function useNotificationsQuery<T>(key: readonly unknown[], queryFn: () => Promise<T>, busy: (data: T) => boolean) {
  const session = useSession();
  const role = session.data?.user.role;
  const result = useQuery({
    queryKey: [...NOTIFICATIONS_QUERY_KEY, session.data?.user.id, ...key],
    queryFn,
    retry: false,
    enabled: role === "operator" || role === "administrator",
    // The worker changes jobs outside this session; refresh while any shown job is still being delivered.
    refetchInterval: (query) => (query.state.data !== undefined && busy(query.state.data) ? IN_FLIGHT_REFRESH_MS : false),
  });
  useExpiredSession(result.error);
  return result;
}

const parseNotification = (body: unknown) => notificationSchema.parse(body);

export const useNotifications = (query: string) =>
  useNotificationsQuery(
    ["list", query],
    () => request(`/notifications?${query}`, { parse: (body) => notificationListResponseSchema.parse(body) }),
    (data) => data.items.some((job) => inFlight(job.status)),
  );
export const useNotification = (notificationId: string) =>
  useNotificationsQuery(
    ["detail", notificationId],
    () => request(`/notifications/${notificationId}`, { parse: parseNotification }),
    (job) => inFlight(job.status),
  );
export const retryNotification = (notificationId: string, idempotencyKey: string) =>
  request(`/notifications/${notificationId}/retry`, {
    method: "POST",
    body: {},
    headers: { "Idempotency-Key": idempotencyKey },
    parse: parseNotification,
  });

export const STATUS_LABELS: Record<NotificationStatus, string> = {
  pending: "Pending",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
};

export const EVENT_LABELS: Record<NotificationEventType, string> = {
  "order.submitted": "Order submitted",
  "order.confirmed": "Order confirmed",
  "order.rejected": "Order rejected",
  "shipment.recorded": "Shipment recorded",
  "cancellation.requested": "Cancellation requested",
  "cancellation.decided": "Cancellation decided",
  "return.requested": "Return requested",
  "return.decided": "Return decided",
  "return.received": "Return received",
};

export const notificationDate = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/Belgrade" });
