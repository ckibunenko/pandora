import { z } from "zod";

// Query strings are parsed strictly before coercion: no exponent, decimal, or empty numeric values.
export const pageSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .default("1")
  .transform(Number)
  .pipe(z.number().int().max(2_147_483_647));

export const pageSizeSchema = z
  .enum(["20", "50", "100"])
  .default("20")
  .transform((value): 20 | 50 | 100 =>
    value === "20" ? 20 : value === "50" ? 50 : 100,
  );

export function paginatedResponseSchema<TItem extends z.ZodType>(item: TItem) {
  return z.object({
    items: z.array(item),
    page: z.number().int().positive(),
    pageSize: z.union([z.literal(20), z.literal(50), z.literal(100)]),
    total: z.number().int().nonnegative(),
  });
}
