import { Injectable } from "@nestjs/common";
import {
  catalogLanguageSchema,
  stockChangeResponseSchema,
  type AdjustmentRequest,
  type InventoryItem,
  type InventoryListResponse,
  type InventoryMovement,
  type InventoryQuery,
  type MovementListResponse,
  type MovementsQuery,
  type MovementBucket,
  type MovementType,
  type ReceiptRequest,
  type StockChangeResponse,
} from "@pandora/contracts";
import { recordAudit } from "../../common/audit/audit.js";
import { Clock } from "../../common/clock/clock.js";
import { ApiException } from "../../common/errors/api-exception.js";
import { IdempotencyService } from "../../common/idempotency/idempotency.service.js";
import { currentCorrelationId } from "../../common/request-context/request-context.js";
import { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import type { AuthContext } from "../auth/auth-context.js";

const INT_MAX = 2_147_483_647;

const ITEM_SELECT = {
  variantId: true,
  sellable: true,
  reserved: true,
  damaged: true,
  variant: {
    select: {
      sku: true,
      language: true,
      edition: true,
      isActive: true,
      product: { select: { id: true, name: true, isActive: true } },
    },
  },
} satisfies Prisma.InventoryItemSelect;

const MOVEMENT_SELECT = {
  id: true,
  variantId: true,
  type: true,
  bucket: true,
  delta: true,
  sellableAfter: true,
  reservedAfter: true,
  damagedAfter: true,
  reference: true,
  note: true,
  reason: true,
  occurredAt: true,
  actor: { select: { id: true, displayName: true } },
} satisfies Prisma.InventoryMovementSelect;

type ItemRecord = Prisma.InventoryItemGetPayload<{ select: typeof ITEM_SELECT }>;
type MovementRecord = Prisma.InventoryMovementGetPayload<{ select: typeof MOVEMENT_SELECT }>;

type StockChange =
  | { kind: "receipt"; input: ReceiptRequest }
  | { kind: "adjustment"; input: AdjustmentRequest };

const MOVEMENT_TYPES: Record<MovementRecord["type"], MovementType> = {
  OPENING_BALANCE: "opening_balance",
  RECEIPT: "receipt",
  ADJUSTMENT: "adjustment",
  RESERVATION: "reservation",
  SHIPMENT: "shipment",
  RELEASE: "release",
  RETURN: "return",
};
const BUCKETS: Record<MovementRecord["bucket"], MovementBucket> = {
  SELLABLE: "sellable",
  DAMAGED: "damaged",
  RESERVED: "reserved",
};

// Prisma's contains filter uses LIKE patterns; escape them for a literal substring search.
const literalSearch = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`);

function itemDto(item: ItemRecord): InventoryItem {
  return {
    variantId: item.variantId,
    sku: item.variant.sku,
    language: catalogLanguageSchema.parse(item.variant.language),
    edition: item.variant.edition,
    variantIsActive: item.variant.isActive,
    product: item.variant.product,
    sellable: item.sellable,
    reserved: item.reserved,
    damaged: item.damaged,
    available: item.sellable - item.reserved,
  };
}

function movementDto(movement: MovementRecord): InventoryMovement {
  return {
    id: movement.id,
    variantId: movement.variantId,
    type: MOVEMENT_TYPES[movement.type],
    bucket: BUCKETS[movement.bucket],
    delta: movement.delta,
    sellableAfter: movement.sellableAfter,
    reservedAfter: movement.reservedAfter,
    damagedAfter: movement.damagedAfter,
    reference: movement.reference,
    note: movement.note,
    reason: movement.reason,
    actor: movement.actor,
    occurredAt: movement.occurredAt.toISOString(),
  };
}

const quantities = (item: { sellable: number; reserved: number; damaged: number }) => ({
  sellable: item.sellable,
  reserved: item.reserved,
  damaged: item.damaged,
});

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly idempotency: IdempotencyService,
  ) {}

  async list(query: InventoryQuery): Promise<InventoryListResponse> {
    const fields = this.prisma.inventoryItem.fields;
    const search = query.q ? literalSearch(query.q) : undefined;
    const where: Prisma.InventoryItemWhereInput = {
      ...(query.stock === "available" ? { sellable: { gt: fields.reserved } } : {}),
      ...(query.stock === "unavailable" ? { sellable: { lte: fields.reserved } } : {}),
      ...(search
        ? {
            variant: {
              OR: [
                { sku: { contains: search, mode: "insensitive" } },
                { product: { name: { contains: search, mode: "insensitive" } } },
              ],
            },
          }
        : {}),
    };
    // Both queries observe the same snapshot so the total matches the page.
    const [total, items] = await this.prisma.$transaction(
      [
        this.prisma.inventoryItem.count({ where }),
        this.prisma.inventoryItem.findMany({
          where,
          select: ITEM_SELECT,
          orderBy: [{ variant: { product: { name: "asc" } } }, { variant: { sku: "asc" } }, { variantId: "asc" }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { items: items.map(itemDto), page: query.page, pageSize: query.pageSize, total };
  }

  async detail(variantId: string): Promise<InventoryItem> {
    const item = await this.prisma.inventoryItem.findUnique({ where: { variantId }, select: ITEM_SELECT });
    if (!item) {
      throw ApiException.notFound("Inventory item not found.");
    }
    return itemDto(item);
  }

  async movements(variantId: string, query: MovementsQuery): Promise<MovementListResponse> {
    const where = { variantId };
    const [exists, total, movements] = await this.prisma.$transaction(
      [
        this.prisma.inventoryItem.count({ where }),
        this.prisma.inventoryMovement.count({ where }),
        this.prisma.inventoryMovement.findMany({
          where,
          select: MOVEMENT_SELECT,
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    if (exists === 0) {
      throw ApiException.notFound("Inventory item not found.");
    }
    return { items: movements.map(movementDto), page: query.page, pageSize: query.pageSize, total };
  }

  receive(variantId: string, input: ReceiptRequest, auth: AuthContext, key: string): Promise<StockChangeResponse> {
    return this.change(variantId, { kind: "receipt", input }, auth, key);
  }

  adjust(variantId: string, input: AdjustmentRequest, auth: AuthContext, key: string): Promise<StockChangeResponse> {
    return this.change(variantId, { kind: "adjustment", input }, auth, key);
  }

  private change(variantId: string, change: StockChange, auth: AuthContext, key: string): Promise<StockChangeResponse> {
    return this.idempotency.execute(
      {
        organizationId: auth.user.organization.id,
        actorId: auth.user.id,
        operation: `inventory.${change.kind}`,
        target: variantId,
        key,
      },
      change.input,
      stockChangeResponseSchema,
      (tx) => this.applyChange(tx, variantId, change, auth),
    );
  }

  private async applyChange(
    tx: Prisma.TransactionClient,
    variantId: string,
    change: StockChange,
    auth: AuthContext,
  ): Promise<StockChangeResponse> {
    const correlationId = currentCorrelationId();
    if (!correlationId) {
      throw new Error("Stock changes require request context.");
    }
    const before = await tx.inventoryItem.findUnique({ where: { variantId }, select: ITEM_SELECT });
    if (!before) {
      throw ApiException.notFound("Inventory item not found.");
    }

    const next = quantities(before);
    let bucket: "SELLABLE" | "DAMAGED";
    let delta: number;
    if (change.kind === "receipt") {
      bucket = "SELLABLE";
      delta = change.input.quantity;
      next.sellable += delta;
      if (next.sellable > INT_MAX) {
        throw ApiException.validationFailed([{ field: "quantity", message: "Stock would exceed the supported maximum." }]);
      }
    } else {
      bucket = change.input.bucket === "sellable" ? "SELLABLE" : "DAMAGED";
      delta = change.input.delta;
      const field = change.input.bucket;
      next[field] += delta;
      if (next[field] > INT_MAX) {
        throw ApiException.validationFailed([{ field: "delta", message: "Stock would exceed the supported maximum." }]);
      }
      if (next.damaged < 0) {
        throw ApiException.insufficientStock([
          { field: "delta", message: `Only ${before.damaged} damaged units can be removed.` },
        ]);
      }
      if (next.sellable < next.reserved) {
        throw ApiException.insufficientStock([
          { field: "delta", message: `Only ${before.sellable - before.reserved} unreserved sellable units can be removed.` },
        ]);
      }
    }

    const occurredAt = this.clock.now();
    const updated = await tx.inventoryItem.update({
      where: { variantId },
      data: { sellable: next.sellable, damaged: next.damaged, updatedAt: occurredAt },
      select: ITEM_SELECT,
    });
    const movement = await tx.inventoryMovement.create({
      data: {
        variantId,
        type: change.kind === "receipt" ? "RECEIPT" : "ADJUSTMENT",
        bucket,
        delta,
        sellableAfter: updated.sellable,
        reservedAfter: updated.reserved,
        damagedAfter: updated.damaged,
        reference: change.kind === "receipt" ? (change.input.reference ?? null) : null,
        note: change.kind === "receipt" ? (change.input.note ?? null) : null,
        reason: change.kind === "adjustment" ? change.input.reason : null,
        actorId: auth.user.id,
        organizationId: auth.user.organization.id,
        correlationId,
        occurredAt,
      },
      select: MOVEMENT_SELECT,
    });
    await recordAudit(tx, this.clock, auth, {
      entityType: "inventory_item",
      entityId: variantId,
      action: change.kind === "receipt" ? "received" : "adjusted",
      before: quantities(before),
      after: { ...quantities(updated), movementId: movement.id },
    });
    return { movement: movementDto(movement), item: itemDto(updated) };
  }
}
