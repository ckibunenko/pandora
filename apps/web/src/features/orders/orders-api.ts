import {
  orderListResponseSchema,
  orderSchema,
  type ApproveCancellation,
  type ApproveReturn,
  type CancelOrder,
  type ConfirmOrder,
  type CreateOrder,
  type OrderStatus,
  type ReceiveReturn,
  type RejectCancellation,
  type RejectOrder,
  type RejectReturn,
  type RequestCancellation,
  type RequestReturn,
  type ShipOrder,
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
export const shipOrder = (orderId: string, body: ShipOrder, idempotencyKey: string) =>
  request(`/orders/${orderId}/shipments`, { method: "POST", body, headers: withKey(idempotencyKey), parse: parseOrder });
export const requestCancellation = (orderId: string, body: RequestCancellation, idempotencyKey: string) =>
  request(`/orders/${orderId}/cancellation-requests`, { method: "POST", body, headers: withKey(idempotencyKey), parse: parseOrder });
export const approveCancellation = (orderId: string, requestId: string, body: ApproveCancellation, idempotencyKey: string) =>
  request(`/orders/${orderId}/cancellation-requests/${requestId}/approve`, {
    method: "POST",
    body,
    headers: withKey(idempotencyKey),
    parse: parseOrder,
  });
export const rejectCancellation = (orderId: string, requestId: string, body: RejectCancellation, idempotencyKey: string) =>
  request(`/orders/${orderId}/cancellation-requests/${requestId}/reject`, {
    method: "POST",
    body,
    headers: withKey(idempotencyKey),
    parse: parseOrder,
  });

export const requestReturn = (orderId: string, body: RequestReturn, idempotencyKey: string) =>
  request(`/orders/${orderId}/returns`, { method: "POST", body, headers: withKey(idempotencyKey), parse: parseOrder });
const returnAction =
  <T,>(action: "approve" | "reject" | "receive") =>
  (orderId: string, returnId: string, body: T, idempotencyKey: string) =>
    request(`/orders/${orderId}/returns/${returnId}/${action}`, { method: "POST", body, headers: withKey(idempotencyKey), parse: parseOrder });
export const approveReturn = returnAction<ApproveReturn>("approve");
export const rejectReturn = returnAction<RejectReturn>("reject");
export const receiveReturn = returnAction<ReceiveReturn>("receive");

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
  partially_shipped: "Partially shipped",
  shipped: "Shipped",
  closed_partial: "Closed (partly cancelled)",
};
