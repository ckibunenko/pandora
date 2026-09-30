import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import {
  catalogLanguageSchema,
  type CatalogProduct,
  type CatalogQuery,
  type CatalogResponse,
  type CatalogVariant,
  type AdminCatalogQuery,
  type CreateProduct,
  type CreateVariant,
  type UpdateProduct,
  type UpdateVariant,
} from "@pandora/contracts";
import { Clock } from "../../common/clock/clock.js";
import { APP_CONFIG, type AppConfig } from "../../common/config/app-config.js";
import { ApiException } from "../../common/errors/api-exception.js";
import { currentCorrelationId } from "../../common/request-context/request-context.js";
import {
  Prisma,
  type Product,
  type ProductVariant,
} from "../../generated/prisma/client.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import type { AuthContext } from "../auth/auth-context.js";

const VARIANT_SELECT = {
  id: true,
  productId: true,
  sku: true,
  language: true,
  edition: true,
  unitPriceMinor: true,
  isActive: true,
} satisfies Prisma.ProductVariantSelect;
const PRODUCT_SELECT = {
  id: true,
  name: true,
  publisher: true,
  description: true,
  type: true,
  baseProductId: true,
  isActive: true,
} satisfies Prisma.ProductSelect;
function productSelection(admin: boolean) {
  return {
    ...PRODUCT_SELECT,
    baseProduct: {
      select: {
        id: true,
        name: true,
        isActive: true,
        variants: { where: { isActive: true }, take: 1, select: { id: true } },
      },
    },
    variants: {
      where: admin ? {} : { isActive: true },
      orderBy: [{ sku: "asc" }, { id: "asc" }],
      select: VARIANT_SELECT,
    },
  } satisfies Prisma.ProductSelect;
}
type ProductRecord = Prisma.ProductGetPayload<{
  select: ReturnType<typeof productSelection>;
}>;
type VariantRecord = Pick<ProductVariant, keyof typeof VARIANT_SELECT>;
const notFound = () =>
  new ApiException(
    HttpStatus.NOT_FOUND,
    "NOT_FOUND",
    "Catalog record not found.",
  );
// Prisma's PostgreSQL contains filter uses LIKE patterns. Escape them for literal substring search.
const literalSearch = (value: string) =>
  value.replace(/[\\%_]/g, (character) => `\\${character}`);
const productSnapshot = (p: Pick<Product, keyof typeof PRODUCT_SELECT>) => ({
  id: p.id,
  name: p.name,
  publisher: p.publisher,
  description: p.description,
  type: p.type,
  baseProductId: p.baseProductId,
  isActive: p.isActive,
});
const variantSnapshot = (v: VariantRecord) => ({
  id: v.id,
  productId: v.productId,
  sku: v.sku,
  language: v.language,
  edition: v.edition,
  unitPriceMinor: v.unitPriceMinor,
  isActive: v.isActive,
});

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private variantDto(variant: VariantRecord): CatalogVariant {
    return {
      ...variantSnapshot(variant),
      language: catalogLanguageSchema.parse(variant.language),
      currency: this.config.catalogCurrency,
    };
  }

  private productDto(product: ProductRecord): CatalogProduct {
    return {
      id: product.id,
      name: product.name,
      publisher: product.publisher,
      description: product.description,
      type: product.type === "BASE_GAME" ? "base_game" : "expansion",
      isActive: product.isActive,
      baseProduct: product.baseProduct
        ? {
            id: product.baseProduct.id,
            name: product.baseProduct.name,
            isVisible:
              product.baseProduct.isActive &&
              product.baseProduct.variants.length > 0,
          }
        : null,
      variants: product.variants.map((variant) => this.variantDto(variant)),
    };
  }

  async list(
    query: CatalogQuery | AdminCatalogQuery,
    admin = false,
  ): Promise<CatalogResponse> {
    const eligible: Prisma.ProductVariantWhereInput = admin
      ? {}
      : { isActive: true };
    const where: Prisma.ProductWhereInput = {
      ...(!admin ? { isActive: true, variants: { some: eligible } } : {}),
      ...(admin && "status" in query && query.status !== "all"
        ? { isActive: query.status === "active" }
        : {}),
      ...(query.type
        ? { type: query.type === "base_game" ? "BASE_GAME" : "EXPANSION" }
        : {}),
      AND: [
        ...(query.language
          ? [{ variants: { some: { ...eligible, language: query.language } } }]
          : []),
        ...(query.q
          ? [
              {
                OR: [
                  {
                    name: {
                      contains: literalSearch(query.q),
                      mode: "insensitive" as const,
                    },
                  },
                  {
                    publisher: {
                      contains: literalSearch(query.q),
                      mode: "insensitive" as const,
                    },
                  },
                  {
                    variants: {
                      some: {
                        ...eligible,
                        sku: {
                          contains: literalSearch(query.q),
                          mode: "insensitive" as const,
                        },
                      },
                    },
                  },
                ],
              },
            ]
          : []),
      ],
    };
    // Both queries observe the same snapshot even when catalog changes between them.
    const [total, products] = await this.prisma.$transaction(
      [
        this.prisma.product.count({ where }),
        this.prisma.product.findMany({
          where,
          select: productSelection(admin),
          orderBy: [{ name: "asc" }, { id: "asc" }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return {
      items: products.map((product) => this.productDto(product)),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async detail(
    id: string,
    admin = false,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<CatalogProduct> {
    const product = await tx.product.findFirst({
      where: {
        id,
        ...(!admin
          ? { isActive: true, variants: { some: { isActive: true } } }
          : {}),
      },
      select: productSelection(admin),
    });
    if (!product) throw notFound();
    return this.productDto(product);
  }

  private async audit(
    tx: Prisma.TransactionClient,
    auth: AuthContext,
    entityType: string,
    entityId: string,
    action: string,
    before: Prisma.InputJsonObject | null,
    after: Prisma.InputJsonObject,
  ): Promise<void> {
    const correlationId = currentCorrelationId();
    if (!correlationId)
      throw new Error("Catalog writes require request context.");
    await tx.auditEvent.create({
      data: {
        actorId: auth.user.id,
        organizationId: auth.user.organization.id,
        entityType,
        entityId,
        action,
        occurredAt: this.clock.now(),
        correlationId,
        before: before ?? Prisma.DbNull,
        after,
      },
    });
  }

  async createProduct(
    input: CreateProduct,
    auth: AuthContext,
  ): Promise<CatalogProduct> {
    return this.prisma.$transaction(async (tx) => {
      if (input.baseProductId) {
        const base = await tx.product.findUnique({
          where: { id: input.baseProductId },
          select: { type: true },
        });
        if (base?.type !== "BASE_GAME")
          throw ApiException.validationFailed([
            {
              field: "baseProductId",
              message: "Select an existing base game.",
            },
          ]);
      }
      const now = this.clock.now();
      const product = await tx.product.create({
        data: {
          ...input,
          type: input.type === "base_game" ? "BASE_GAME" : "EXPANSION",
          createdAt: now,
          updatedAt: now,
        },
        select: PRODUCT_SELECT,
      });
      await this.audit(
        tx,
        auth,
        "product",
        product.id,
        "created",
        null,
        productSnapshot(product),
      );
      return this.detail(product.id, true, tx);
    });
  }

  async updateProduct(
    id: string,
    input: UpdateProduct,
    auth: AuthContext,
  ): Promise<CatalogProduct> {
    return this.prisma.$transaction(async (tx) => {
      // Serialize edits before reading the audit's before value. This also makes concurrent no-ops harmless.
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${id}::uuid FOR UPDATE`;
      const before = await tx.product.findUnique({
        where: { id },
        select: PRODUCT_SELECT,
      });
      if (!before) throw notFound();
      if (
        Object.entries(input).some(
          ([key, value]) => before[key as keyof typeof input] !== value,
        )
      ) {
        const after = await tx.product.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.publisher !== undefined
              ? { publisher: input.publisher }
              : {}),
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
            ...(input.isActive !== undefined
              ? { isActive: input.isActive }
              : {}),
            updatedAt: this.clock.now(),
          },
          select: PRODUCT_SELECT,
        });
        await this.audit(
          tx,
          auth,
          "product",
          id,
          "updated",
          productSnapshot(before),
          productSnapshot(after),
        );
      }
      return this.detail(id, true, tx);
    });
  }

  async createVariant(
    productId: string,
    input: CreateVariant,
    auth: AuthContext,
  ): Promise<CatalogVariant> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (
          !(await tx.product.findUnique({
            where: { id: productId },
            select: { id: true },
          }))
        )
          throw notFound();
        const now = this.clock.now();
        const variant = await tx.productVariant.create({
          data: { ...input, productId, createdAt: now, updatedAt: now },
          select: VARIANT_SELECT,
        });
        await this.audit(
          tx,
          auth,
          "variant",
          variant.id,
          "created",
          null,
          variantSnapshot(variant),
        );
        return this.variantDto(variant);
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          "SKU_ALREADY_EXISTS",
          "This SKU is already in use.",
          [{ field: "sku", message: "Choose a unique SKU." }],
        );
      }
      throw error;
    }
  }

  async updateVariant(
    productId: string,
    id: string,
    input: UpdateVariant,
    auth: AuthContext,
  ): Promise<CatalogVariant> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM product_variants WHERE id = ${id}::uuid AND product_id = ${productId}::uuid FOR UPDATE`;
      const before = await tx.productVariant.findFirst({
        where: { id, productId },
        select: VARIANT_SELECT,
      });
      if (!before) throw notFound();
      if (
        !Object.entries(input).some(
          ([key, value]) => before[key as keyof typeof input] !== value,
        )
      )
        return this.variantDto(before);
      const after = await tx.productVariant.update({
        where: { id },
        data: {
          ...(input.language !== undefined ? { language: input.language } : {}),
          ...(input.edition !== undefined ? { edition: input.edition } : {}),
          ...(input.unitPriceMinor !== undefined
            ? { unitPriceMinor: input.unitPriceMinor }
            : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          updatedAt: this.clock.now(),
        },
        select: VARIANT_SELECT,
      });
      await this.audit(
        tx,
        auth,
        "variant",
        id,
        "updated",
        variantSnapshot(before),
        variantSnapshot(after),
      );
      return this.variantDto(after);
    });
  }
}
