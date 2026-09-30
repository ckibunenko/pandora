import {
  orderListResponseSchema,
  orderSchema,
  type CancelOrder,
  type ConfirmOrder,
  type CreateOrder,
  type OrderStatus,
  type RejectOrder,
  type SaveOrderLines,
  type SubmitOrder,
} from "@pandora/contracts";
import { useQuery } from "@tanstack/react-query";
import { request } from "../../lib/api-client";
import { useSession } from "../auth/session";
import { useExpiredSession } from "../catalog/catalog-api";

export const ORDERS_QUERY_KEY = ["orders"] as const;

const parseOrder = (body: unknown) => orderSchema.parse(body);
const withKey = (idempotencyKey: string) => ({ "Idempotency-Key": idempotencyKey });

export const fetchOrders = (query: string) =>
  request(`/orders?${query}`, { parse: (body) => orderListResponseSchema.parse(body) });
export const fetchOrder = (orderId: string) => request(`/orders/${orderId}`, { parse: parseOrder });
export const createOrder = (body: CreateOrder, idempotencyKey: string) =>
  request("/orders", { method: "POST", body, headers: withKey(idempotencyKey), parse: parseOrder });
export const saveOrderLines = (orderId: string, body: SaveOrderLines) =>
  request(`/orders/${orderId}/lines`, { method: "PUT", body, parse: parseOrder });
export const submitOrder = (orderId: string, body: SubmitOrder, idempotencyKey: string) =>
  request(`/orders/${orderId}/submit`, { method: "POST", body, headers: withKey(idempotencyKey), parse: parseOrder });
export const cancelOrder = (orderId: string, body: CancelOrder, idempotencyKey: string) =>
  request(`/orders/${orderId}/cancel`, { method: "POST", body, headers: withKey(idempotencyKey), parse: parseOrder });
export const confirmOrder = (orderId: string, body: ConfirmOrder, idempotencyKey: string) =>
  request(`/orders/${orderId}/confirm`, { method: "POST", body, headers: withKey(idempotencyKey), parse: parseOrder });
export const rejectOrder = (orderId: string, body: RejectOrder, idempotencyKey: string) =>
  request(`/orders/${orderId}/reject`, { method: "POST", body, headers: withKey(idempotencyKey), parse: parseOrder });

function useOrdersQuery<T>(key: readonly unknown[], queryFn: () => Promise<T>, enabled = true) {
  const session = useSession();
  const result = useQuery({
    queryKey: [...ORDERS_QUERY_KEY, session.data?.user.id, ...key],
    queryFn,
    retry: false,
    enabled: enabled && !!session.data,
  });
  useExpiredSession(result.error);
  return result;
}

export const useOrders = (query: string) => useOrdersQuery(["list", query], () => fetchOrders(query));
export const useOrder = (orderId: string) => useOrdersQuery(["order", orderId], () => fetchOrder(orderId), !!orderId);

export const STATUS_LABELS: Record<OrderStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  cancelled: "Cancelled",
  confirmed: "Confirmed",
  rejected: "Rejected",
};
