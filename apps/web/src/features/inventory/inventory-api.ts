import {
  inventoryItemSchema,
  inventoryListResponseSchema,
  movementListResponseSchema,
  stockChangeResponseSchema,
  type AdjustmentRequest,
  type ReceiptRequest,
} from "@pandora/contracts";
import { useQuery } from "@tanstack/react-query";
import { request } from "../../lib/api-client";
import { useSession } from "../auth/session";
import { useExpiredSession } from "../catalog/catalog-api";

export const INVENTORY_QUERY_KEY = ["inventory"] as const;

export const fetchInventory = (query: string) =>
  request(`/inventory?${query}`, { parse: (body) => inventoryListResponseSchema.parse(body) });
export const fetchInventoryItem = (variantId: string) =>
  request(`/inventory/${variantId}`, { parse: (body) => inventoryItemSchema.parse(body) });
export const fetchMovements = (variantId: string, page: number) =>
  request(`/inventory/${variantId}/movements?page=${page}`, {
    parse: (body) => movementListResponseSchema.parse(body),
  });

export const postReceipt = (variantId: string, body: ReceiptRequest, idempotencyKey: string) =>
  request(`/inventory/${variantId}/receipts`, {
    method: "POST",
    body,
    headers: { "Idempotency-Key": idempotencyKey },
    parse: (value) => stockChangeResponseSchema.parse(value),
  });
export const postAdjustment = (variantId: string, body: AdjustmentRequest, idempotencyKey: string) =>
  request(`/inventory/${variantId}/adjustments`, {
    method: "POST",
    body,
    headers: { "Idempotency-Key": idempotencyKey },
    parse: (value) => stockChangeResponseSchema.parse(value),
  });

function useStaffQuery<T>(key: readonly unknown[], queryFn: () => Promise<T>, enabled = true) {
  const session = useSession();
  const role = session.data?.user.role;
  const result = useQuery({
    queryKey: [...INVENTORY_QUERY_KEY, session.data?.user.id, ...key],
    queryFn,
    retry: false,
    enabled: enabled && (role === "operator" || role === "administrator"),
  });
  useExpiredSession(result.error);
  return result;
}

export const useInventory = (query: string) => useStaffQuery(["list", query], () => fetchInventory(query));
export const useInventoryItem = (variantId: string) =>
  useStaffQuery(["item", variantId], () => fetchInventoryItem(variantId), !!variantId);
export const useMovements = (variantId: string, page: number) =>
  useStaffQuery(["movements", variantId, page], () => fetchMovements(variantId, page), !!variantId);

/** Parses a signed whole number typed by staff; returns undefined for anything else. */
export function parseWholeNumber(value: string, allowNegative: boolean): number | undefined {
  const pattern = allowNegative ? /^[+-]?[0-9]+$/ : /^[0-9]+$/;
  if (!pattern.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
