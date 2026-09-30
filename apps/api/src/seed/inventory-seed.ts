import type { Prisma } from "../generated/prisma/client.js";

// A fixed timestamp keeps opening balances identical across seed runs.
const OPENING_BALANCE_AT = new Date("2026-01-01T00:00:00.000Z");

const OPENING_BALANCES: readonly { sku: string; sellable: number; damaged: number }[] = [
  { sku: "LOV-EN-STD", sellable: 40, damaged: 0 },
  { sku: "LOV-SR-STD", sellable: 12, damaged: 0 },
  { sku: "LOV-MD-EN", sellable: 3, damaged: 0 },
  { sku: "CWO-EN-STD", sellable: 25, damaged: 0 },
  { sku: "CWO-EN-DLX", sellable: 0, damaged: 0 },
  { sku: "SWA-EN-STD", sellable: 18, damaged: 2 },
  { sku: "SWA-GI-EN", sellable: 1, damaged: 0 },
  { sku: "MBM-SR-STD", sellable: 9, damaged: 0 },
  { sku: "MBM-EN-STD", sellable: 5, damaged: 0 },
  { sku: "TKC-EN-STD", sellable: 60, damaged: 0 },
  { sku: "EBW-EN-STD", sellable: 7, damaged: 0 },
];

/**
 * Writes opening balances only for variants without any movement, so reseeding never rewrites
 * stock that receipts or adjustments have since changed. Returns how many opening movements were written.
 */
export async function seedInventory(tx: Prisma.TransactionClient): Promise<number> {
  let written = 0;
  for (const balance of OPENING_BALANCES) {
    const item = await tx.inventoryItem.findFirst({
      where: { variant: { sku: balance.sku } },
      select: { variantId: true, _count: { select: { movements: true } } },
    });
    if (!item) {
      throw new Error(`Seed inventory references unknown SKU ${balance.sku}.`);
    }
    if (item._count.movements > 0) {
      continue;
    }
    await tx.inventoryItem.update({
      where: { variantId: item.variantId },
      data: { sellable: balance.sellable, damaged: balance.damaged, reserved: 0, updatedAt: OPENING_BALANCE_AT },
    });
    const opening = [
      { bucket: "SELLABLE" as const, delta: balance.sellable, damagedAfter: 0 },
      { bucket: "DAMAGED" as const, delta: balance.damaged, damagedAfter: balance.damaged },
    ].filter((movement) => movement.delta > 0);
    for (const movement of opening) {
      await tx.inventoryMovement.create({
        data: {
          variantId: item.variantId,
          type: "OPENING_BALANCE",
          bucket: movement.bucket,
          delta: movement.delta,
          sellableAfter: balance.sellable,
          reservedAfter: 0,
          damagedAfter: movement.damagedAfter,
          occurredAt: OPENING_BALANCE_AT,
        },
      });
      written += 1;
    }
  }
  return written;
}
