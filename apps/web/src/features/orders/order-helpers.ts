import { ERROR_CODES, type Order } from "@pandora/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../lib/api-client";
import { useSession } from "../auth/session";
import { ORDERS_QUERY_KEY } from "./orders-api";

export const formatDate = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/Belgrade" });
export const skusFrom = (error: ApiError) => error.details.map((detail) => detail.field.replace(/^lines\./, "")).join(", ");

export function mutationMessage(error: unknown, lostResponse: string): string {
  if (!(error instanceof ApiError)) return lostResponse;
  switch (error.code) {
    case ERROR_CODES.versionConflict:
      return "Someone else changed this draft. Your edits are still shown; reload to see the latest version.";
    case ERROR_CODES.priceChanged:
      return `Prices changed for ${skusFrom(error)}. The latest prices are shown now; review them and submit again.`;
    case ERROR_CODES.variantUnavailable:
      return `No longer available: ${skusFrom(error)}. Remove these items to submit.`;
    case ERROR_CODES.insufficientStock:
      return `Not enough stock to confirm: ${error.details.map((detail) => `${detail.field.replace(/^lines\./, "")} (${detail.message.replace(/\.$/, "")})`).join("; ")}. Nothing was reserved.`;
    case ERROR_CODES.shipmentQuantityExceeded:
      return `Too many units: ${error.details.map((detail) => `${detail.field.replace(/^lines\./, "")} (${detail.message.replace(/\.$/, "")})`).join("; ")}. Nothing was shipped.`;
    case ERROR_CODES.cancellationRequestPending:
      return "A cancellation request for this order is already waiting for a decision.";
    case ERROR_CODES.cancellationQuantityExceeded:
      return `Too many units: ${error.details.map((detail) => `${detail.field.replace(/^lines\./, "")} (${detail.message.replace(/\.$/, "")})`).join("; ")}. Nothing was requested.`;
    case ERROR_CODES.returnQuantityExceeded:
      return `Too many units: ${error.details.map((detail) => `${detail.field.replace(/^shipments\./, "").replace(".", " · ")} (${detail.message.replace(/\.$/, "")})`).join("; ")}. Nothing was recorded.`;
    case ERROR_CODES.invalidReturnTransition:
      return `${error.message} Reload the order to see its current state.`;
    case ERROR_CODES.cancellationConflict:
      return `Items shipped after this request was made (${error.details.map((detail) => detail.field.replace(/^lines\./, "")).join(", ")}). Reject it so the retailer can request again. Nothing was released.`;
    case ERROR_CODES.validationFailed:
      return "Please correct the highlighted fields.";
    default:
      return error.message;
  }
}

export function useOrderCacheUpdate() {
  const client = useQueryClient();
  const session = useSession();
  return async (order: Order) => {
    client.setQueryData([...ORDERS_QUERY_KEY, session.data?.user.id, "order", order.id], order);
    await Promise.all([
      client.invalidateQueries({ queryKey: [...ORDERS_QUERY_KEY, session.data?.user.id, "list"] }),
      client.invalidateQueries({ queryKey: ["catalog"] }),
      client.invalidateQueries({ queryKey: ["inventory"] }),
    ]);
  };
}
