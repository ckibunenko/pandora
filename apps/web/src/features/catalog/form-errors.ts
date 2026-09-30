import { ApiError } from "../../lib/api-client";

export function errorFields(error: unknown): Record<string, string> {
  return error instanceof ApiError
    ? Object.fromEntries(
        error.details.map((detail) => [detail.field, detail.message]),
      )
    : {};
}
export function mutationMessage(error: unknown): string {
  if (error instanceof ApiError)
    return error.status === 422
      ? "Please correct the highlighted fields."
      : error.message;
  return "Could not confirm the save. Check the catalog before trying again.";
}
