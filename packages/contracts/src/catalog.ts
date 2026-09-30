import { z } from "zod";

export const productTypeSchema = z.enum(["base_game", "expansion"]);
export const catalogLanguageSchema = z.enum(["en", "sr"]);
export const catalogCurrencySchema = z.literal("EUR");
const text = (max: number) => z.string().trim().min(1).max(max);
const priceSchema = z.number().int().min(0).max(2_147_483_647);
const skuSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(3)
  .max(40)
  .regex(/^[A-Z0-9][A-Z0-9-]*[A-Z0-9]$/);
const editableProductFields = {
  name: text(120),
  publisher: text(120),
  description: text(2000),
  isActive: z.boolean(),
};
const editableVariantFields = {
  language: catalogLanguageSchema,
  edition: text(80),
  unitPriceMinor: priceSchema,
  isActive: z.boolean(),
};

export const createProductSchema = z
  .strictObject({
    ...editableProductFields,
    isActive: z.boolean().default(true),
    type: productTypeSchema,
    baseProductId: z.uuid().nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if ((value.type === "expansion") !== (value.baseProductId !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["baseProductId"],
        message: "Only expansions must reference a base game.",
      });
    }
  });
export const updateProductSchema = z
  .strictObject(editableProductFields)
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Provide at least one editable field.",
  );
export const createVariantSchema = z.strictObject({
  ...editableVariantFields,
  isActive: z.boolean().default(true),
  sku: skuSchema,
});
export const updateVariantSchema = z
  .strictObject(editableVariantFields)
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Provide at least one editable field.",
  );
export const productParamsSchema = z.object({ productId: z.uuid() });
export const variantParamsSchema = productParamsSchema.extend({
  variantId: z.uuid(),
});

// Query strings are parsed strictly before coercion: no exponent, decimal, or empty numeric values.
const pageSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .default("1")
  .transform(Number)
  .pipe(z.number().int().max(2_147_483_647));
const pageSizeSchema = z
  .enum(["20", "50", "100"])
  .default("20")
  .transform((value): 20 | 50 | 100 =>
    value === "20" ? 20 : value === "50" ? 50 : 100,
  );
export const catalogQuerySchema = z.strictObject({
  page: pageSchema,
  pageSize: pageSizeSchema,
  q: z.string().trim().max(120).optional(),
  type: productTypeSchema.optional(),
  language: catalogLanguageSchema.optional(),
});
export const adminCatalogQuerySchema = catalogQuerySchema.extend({
  status: z.enum(["all", "active", "inactive"]).default("all"),
});
export const variantSchema = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  sku: z.string(),
  language: catalogLanguageSchema,
  edition: z.string(),
  unitPriceMinor: priceSchema,
  currency: catalogCurrencySchema,
  isActive: z.boolean(),
});
export const productSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  publisher: z.string(),
  description: z.string(),
  type: productTypeSchema,
  baseProduct: z
    .object({ id: z.uuid(), name: z.string(), isVisible: z.boolean() })
    .nullable(),
  isActive: z.boolean(),
  variants: z.array(variantSchema),
});
export const catalogResponseSchema = z.object({
  items: z.array(productSchema),
  page: z.number().int().positive(),
  pageSize: z.union([z.literal(20), z.literal(50), z.literal(100)]),
  total: z.number().int().nonnegative(),
});
export type CatalogProduct = z.infer<typeof productSchema>;
export type CatalogVariant = z.infer<typeof variantSchema>;
export type CatalogResponse = z.infer<typeof catalogResponseSchema>;
export type CatalogQuery = z.infer<typeof catalogQuerySchema>;
export type AdminCatalogQuery = z.infer<typeof adminCatalogQuerySchema>;
export type CreateProduct = z.infer<typeof createProductSchema>;
export type UpdateProduct = z.infer<typeof updateProductSchema>;
export type CreateVariant = z.infer<typeof createVariantSchema>;
export type UpdateVariant = z.infer<typeof updateVariantSchema>;
