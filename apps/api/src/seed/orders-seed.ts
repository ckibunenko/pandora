import type { Prisma } from "../generated/prisma/client.js";

const orderId = (n: number) => `01920000-0000-7000-8000-${String(3000 + n).padStart(12, "0")}`;

type SeedStatus = "DRAFT" | "SUBMITTED" | "CANCELLED" | "CONFIRMED" | "REJECTED" | "PARTIALLY_SHIPPED";

interface SeedOrder {
  n: number;
  number: string;
  organization: "tabletopLantern" | "cardboardKeep";
  status: SeedStatus;
  createdAt: string;
  lines: readonly { sku: string; quantity: number }[];
  rejectionReason?: string;
  /** Shipped after confirmation, as one shipment with a fixed number. */
  shipment?: { number: string; quantities: Record<string, number> };
  /** A retailer cancellation request left pending after confirmation. */
  pendingCancellationReason?: string;
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
  {
    // Cannot be confirmed: CWO-EN-DLX has no stock.
    n: 5,
    number: "PO-000005",
    organization: "cardboardKeep",
    status: "SUBMITTED",
    createdAt: "2026-01-14T09:00:00.000Z",
    lines: [
      { sku: "CWO-EN-DLX", quantity: 2 },
      { sku: "LOV-SR-STD", quantity: 1 },
    ],
  },
  {
    n: 6,
    number: "PO-000006",
    organization: "tabletopLantern",
    status: "CONFIRMED",
    createdAt: "2026-01-15T09:00:00.000Z",
    lines: [{ sku: "LOV-SR-STD", quantity: 2 }],
  },
  {
    n: 7,
    number: "PO-000007",
    organization: "cardboardKeep",
    status: "REJECTED",
    createdAt: "2026-01-16T09:00:00.000Z",
    lines: [{ sku: "TKC-EN-STD", quantity: 5 }],
    rejectionReason: "Duplicate of an earlier order",
  },
  {
    n: 8,
    number: "PO-000008",
    organization: "tabletopLantern",
    status: "PARTIALLY_SHIPPED",
    createdAt: "2026-01-17T09:00:00.000Z",
    lines: [{ sku: "LOV-EN-STD", quantity: 5 }],
    shipment: { number: "SH-000001", quantities: { "LOV-EN-STD": 2 } },
  },
  {
    n: 9,
    number: "PO-000009",
    organization: "cardboardKeep",
    status: "CONFIRMED",
    createdAt: "2026-01-18T09:00:00.000Z",
    lines: [{ sku: "MBM-SR-STD", quantity: 2 }],
    pendingCancellationReason: "Store event was postponed",
  },
];

export interface SeedActor {
  readonly organizationId: string;
  readonly userId: string;
}

/**
 * Creates the demo orders only when they are missing, so reseeding never overwrites orders users changed.
 * Every order follows the same path as the API (draft → submitted → decision), so database triggers apply.
 */
export async function seedOrders(
  tx: Prisma.TransactionClient,
  retailers: Record<SeedOrder["organization"], SeedActor>,
  operator: SeedActor,
): Promise<number> {
  let created = 0;
  for (const fixture of ORDERS) {
    const id = orderId(fixture.n);
    if (await tx.order.findUnique({ where: { id }, select: { id: true } })) {
      continue;
    }
    const retailer = retailers[fixture.organization];
    const at = new Date(fixture.createdAt);
    const hour = (n: number) => new Date(at.getTime() + n * 60 * 60 * 1000);
    const variants = await tx.productVariant.findMany({
      where: { sku: { in: fixture.lines.map((line) => line.sku) } },
      select: { id: true, sku: true, language: true, edition: true, unitPriceMinor: true, product: { select: { name: true } } },
    });
    const bySku = new Map(variants.map((variant) => [variant.sku, variant]));
    const submitted = fixture.status !== "DRAFT" && fixture.status !== "CANCELLED";
    const confirmed = fixture.status === "CONFIRMED" || fixture.status === "PARTIALLY_SHIPPED";
    let total = 0n;

    const order = await tx.order.create({
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
              ...(submitted
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
      select: { lines: { select: { id: true, variantId: true, quantity: true, sku: true } } },
    });

    if (fixture.status === "CANCELLED") {
      await tx.order.update({
        where: { id },
        data: { status: "CANCELLED", version: 2, cancelledAt: hour(1), cancelledById: retailer.userId, updatedAt: hour(1) },
      });
    }
    if (submitted) {
      await tx.order.update({
        where: { id },
        data: { status: "SUBMITTED", version: 2, submittedAt: hour(1), submittedById: retailer.userId, totalMinor: total, updatedAt: hour(1) },
      });
    }
    const reservations = new Map<string, string>();
    if (confirmed) {
      for (const line of order.lines) {
        const reservation = await tx.stockReservation.create({
          data: { orderLineId: line.id, variantId: line.variantId, quantityReserved: line.quantity, createdAt: hour(2) },
          select: { id: true },
        });
        reservations.set(line.id, reservation.id);
        const item = await tx.inventoryItem.update({
          where: { variantId: line.variantId },
          data: { reserved: { increment: line.quantity }, updatedAt: hour(2) },
          select: { sellable: true, reserved: true, damaged: true },
        });
        await tx.inventoryMovement.create({
          data: {
            variantId: line.variantId,
            type: "RESERVATION",
            bucket: "RESERVED",
            delta: line.quantity,
            sellableAfter: item.sellable,
            reservedAfter: item.reserved,
            damagedAfter: item.damaged,
            reference: fixture.number,
            reservationId: reservation.id,
            actorId: operator.userId,
            organizationId: operator.organizationId,
            correlationId: `seed-${fixture.number}`,
            occurredAt: hour(2),
          },
        });
      }
      await tx.order.update({
        where: { id },
        data: { status: "CONFIRMED", version: 3, confirmedAt: hour(2), confirmedById: operator.userId, updatedAt: hour(2) },
      });
    }
    if (fixture.shipment) {
      const shipment = fixture.shipment;
      const shippedLines = order.lines.filter((line) => line.sku !== null && shipment.quantities[line.sku]);
      await tx.shipment.create({
        data: {
          number: shipment.number,
          orderId: id,
          createdById: operator.userId,
          createdAt: hour(3),
          items: { create: shippedLines.map((line) => ({ orderLineId: line.id, quantity: shipment.quantities[line.sku ?? ""] ?? 0 })) },
        },
      });
      for (const line of shippedLines) {
        const quantity = shipment.quantities[line.sku ?? ""] ?? 0;
        const reservationId = reservations.get(line.id);
        if (!reservationId) {
          throw new Error(`Seed shipment ${shipment.number} needs a reserved line.`);
        }
        await tx.orderLine.update({ where: { id: line.id }, data: { shippedQuantity: quantity } });
        await tx.stockReservation.update({ where: { id: reservationId }, data: { quantityConsumed: quantity } });
        const item = await tx.inventoryItem.update({
          where: { variantId: line.variantId },
          data: { sellable: { decrement: quantity }, reserved: { decrement: quantity }, updatedAt: hour(3) },
          select: { sellable: true, reserved: true, damaged: true },
        });
        for (const bucket of ["SELLABLE", "RESERVED"] as const) {
          await tx.inventoryMovement.create({
            data: {
              variantId: line.variantId,
              type: "SHIPMENT",
              bucket,
              delta: -quantity,
              sellableAfter: item.sellable,
              reservedAfter: item.reserved,
              damagedAfter: item.damaged,
              reference: shipment.number,
              reservationId,
              actorId: operator.userId,
              organizationId: operator.organizationId,
              correlationId: `seed-${shipment.number}`,
              occurredAt: hour(3),
            },
          });
        }
      }
      await tx.order.update({ where: { id }, data: { status: fixture.status, version: 4, updatedAt: hour(3) } });
    }
    if (fixture.pendingCancellationReason) {
      await tx.cancellationRequest.create({
        data: {
          orderId: id,
          status: "PENDING",
          reason: fixture.pendingCancellationReason,
          requestedById: retailer.userId,
          requestedAt: hour(3),
          items: { create: order.lines.map((line) => ({ orderLineId: line.id, quantity: line.quantity })) },
        },
      });
      await tx.order.update({ where: { id }, data: { version: 4, updatedAt: hour(3) } });
    }
    if (fixture.status === "REJECTED") {
      await tx.order.update({
        where: { id },
        data: {
          status: "REJECTED",
          version: 3,
          rejectedAt: hour(2),
          rejectedById: operator.userId,
          rejectionReason: fixture.rejectionReason ?? "Rejected in seed data",
          updatedAt: hour(2),
        },
      });
    }
    created += 1;
  }
  return created;
}
