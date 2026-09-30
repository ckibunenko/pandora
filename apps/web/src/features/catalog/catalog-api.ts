import {
  catalogResponseSchema,
  productSchema,
  variantSchema,
  type CreateProduct,
  type CreateVariant,
  type UpdateProduct,
  type UpdateVariant,
} from "@pandora/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { ApiError, request } from "../../lib/api-client";
import { SESSION_QUERY_KEY, useSession } from "../auth/session";

const path = (admin: boolean) =>
  admin ? "/admin/catalog/products" : "/catalog/products";
export const fetchCatalog = (query: string, admin = false) =>
  request(`${path(admin)}?${query}`, {
    parse: (body) => catalogResponseSchema.parse(body),
  });
export const fetchProduct = (id: string, admin = false) =>
  request(`${path(admin)}/${id}`, {
    parse: (body) => productSchema.parse(body),
  });
export const createProduct = (body: CreateProduct) =>
  request(path(true), {
    method: "POST",
    body,
    parse: (value) => productSchema.parse(value),
  });
export const updateProduct = (id: string, body: UpdateProduct) =>
  request(`${path(true)}/${id}`, {
    method: "PATCH",
    body,
    parse: (value) => productSchema.parse(value),
  });
export const createVariant = (id: string, body: CreateVariant) =>
  request(`${path(true)}/${id}/variants`, {
    method: "POST",
    body,
    parse: (value) => variantSchema.parse(value),
  });
export const updateVariant = (
  productId: string,
  id: string,
  body: UpdateVariant,
) =>
  request(`${path(true)}/${productId}/variants/${id}`, {
    method: "PATCH",
    body,
    parse: (value) => variantSchema.parse(value),
  });

export function useCatalog(query: string, admin = false) {
  const session = useSession();
  const result = useQuery({
    queryKey: [
      "catalog",
      session.data?.user.id,
      session.data?.user.organization.id,
      admin,
      "list",
      query,
    ],
    queryFn: () => fetchCatalog(query, admin),
    retry: false,
    enabled:
      !!session.data && (!admin || session.data.user.role === "administrator"),
  });
  useExpiredSession(result.error);
  return result;
}
export function useProduct(id: string, admin = false) {
  const session = useSession();
  const result = useQuery({
    queryKey: [
      "catalog",
      session.data?.user.id,
      session.data?.user.organization.id,
      admin,
      "product",
      id,
    ],
    queryFn: () => fetchProduct(id, admin),
    retry: false,
    enabled:
      !!id &&
      !!session.data &&
      (!admin || session.data.user.role === "administrator"),
  });
  useExpiredSession(result.error);
  return result;
}
export function useExpiredSession(error: unknown) {
  const client = useQueryClient();
  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) {
      client.removeQueries({ queryKey: ["catalog"] });
      void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    }
  }, [client, error]);
}
export function formatPrice(minor: number): string {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
  }).format(minor / 100);
}
export function priceInput(minor: number): string {
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}
export function parsePrice(value: string): number | undefined {
  if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(value)) return undefined;
  const [whole = "", fraction = ""] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(result) && result <= 2_147_483_647
    ? result
    : undefined;
}
export const languageLabel = (language: string) =>
  language === "sr" ? "Serbian" : "English";
