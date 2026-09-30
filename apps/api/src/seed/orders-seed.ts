import type { Prisma } from "../generated/prisma/client.js";

const orderId = (n: number) => `01920000-0000-7000-8000-${String(3000 + n).padStart(12, "0")}`;

interface SeedOrder {
  n: number;
  number: string;
  organization: "tabletopLantern" | "cardboardKeep";
  status: "DRAFT" | "SUBMITTED" | "CANCELLED";
  createdAt: string;
  lines: readonly { sku: string; quantity: number }[];
}

const ORDERS: readonly SeedOrder[] = [
  {
    n: 1,
    number: "PO-000001",
    organization: "tabletopLantern",
    status: "DRAFT",
    createdAt: "2026-01-10T09:00:00.000Z",
    lines: [
      { sku: "LOV-EN-STD", quantity: 4 },
      { sku: "SWA-GI-EN", quantity: 2 },
    ],
  },
  {
    n: 2,
    number: "PO-000002",
    organization: "tabletopLantern",
    status: "SUBMITTED",
    createdAt: "2026-01-11T09:00:00.000Z",
    lines: [
      { sku: "CWO-EN-STD", quantity: 3 },
      { sku: "TKC-EN-STD", quantity: 10 },
    ],
  },
  {
    n: 3,
    number: "PO-000003",
    organization: "tabletopLantern",
    status: "CANCELLED",
    createdAt: "2026-01-12T09:00:00.000Z",
    lines: [{ sku: "MBM-SR-STD", quantity: 1 }],
  },
  {
    n: 4,
    number: "PO-000004",
    organization: "cardboardKeep",
    status: "DRAFT",
    createdAt: "2026-01-13T09:00:00.000Z",
    lines: [{ sku: "LOV-SR-STD", quantity: 6 }],
  },
];

export interface SeedRetailer {
  readonly organizationId: string;
  readonly userId: string;
}

/**
 * Creates the demo orders only when they are missing, so reseeding never overwrites orders users changed.
 * Submitted and cancelled orders follow the same draft-first path as the API, so database triggers apply.
 */
export async function seedOrders(
  tx: Prisma.TransactionClient,
  retailers: Record<SeedOrder["organization"], SeedRetailer>,
): Promise<number> {
  let created = 0;
  for (const fixture of ORDERS) {
    const id = orderId(fixture.n);
    if (await tx.order.findUnique({ where: { id }, select: { id: true } })) {
      continue;
    }
    const retailer = retailers[fixture.organization];
    const at = new Date(fixture.createdAt);
    const variants = await tx.productVariant.findMany({
      where: { sku: { in: fixture.lines.map((line) => line.sku) } },
      select: { id: true, sku: true, language: true, edition: true, unitPriceMinor: true, product: { select: { name: true } } },
    });
    const bySku = new Map(variants.map((variant) => [variant.sku, variant]));
    const frozen = fixture.status === "SUBMITTED";
    let total = 0n;

    await tx.order.create({
      data: {
        id,
        number: fixture.number,
        organizationId: retailer.organizationId,
        status: "DRAFT",
        currency: "EUR",
        createdById: retailer.userId,
        createdAt: at,
        updatedAt: at,
        lines: {
          create: fixture.lines.map((line) => {
            const variant = bySku.get(line.sku);
            if (!variant) {
              throw new Error(`Seed order ${fixture.number} references unknown SKU ${line.sku}.`);
            }
            const lineTotal = BigInt(variant.unitPriceMinor) * BigInt(line.quantity);
            total += lineTotal;
            return {
              variantId: variant.id,
              quantity: line.quantity,
              ...(frozen
                ? {
                    sku: variant.sku,
                    productName: variant.product.name,
                    language: variant.language,
                    edition: variant.edition,
                    unitPriceMinor: variant.unitPriceMinor,
                    lineTotalMinor: lineTotal,
                  }
                : {}),
            };
          }),
        },
      },
    });

    const later = new Date(at.getTime() + 60 * 60 * 1000);
    if (fixture.status === "SUBMITTED") {
      await tx.order.update({
        where: { id },
        data: { status: "SUBMITTED", version: 2, submittedAt: later, submittedById: retailer.userId, totalMinor: total, updatedAt: later },
      });
    } else if (fixture.status === "CANCELLED") {
      await tx.order.update({
        where: { id },
        data: { status: "CANCELLED", version: 2, cancelledAt: later, cancelledById: retailer.userId, updatedAt: later },
      });
    }
    created += 1;
  }
  return created;
}
