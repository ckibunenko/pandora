import { Inject, Injectable } from "@nestjs/common";
import {
  catalogLanguageSchema,
  orderSchema,
  type CancelOrder,
  type CreateOrder,
  type ErrorDetail,
  type Order,
  type OrderLine,
  type OrderListResponse,
  type OrderQuery,
  type OrderStatus,
  type ConfirmOrder,
  type RejectOrder,
  type SaveOrderLines,
  type SubmitOrder,
} from "@pandora/contracts";
import { recordAudit } from "../../common/audit/audit.js";
import { Clock } from "../../common/clock/clock.js";
import { APP_CONFIG, type AppConfig } from "../../common/config/app-config.js";
import { ApiException } from "../../common/errors/api-exception.js";
import { IdempotencyService } from "../../common/idempotency/idempotency.service.js";
import { currentCorrelationId } from "../../common/request-context/request-context.js";
import { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { runSerializable } from "../../infrastructure/prisma/serializable.js";
import type { AuthContext } from "../auth/auth-context.js";

const ACTOR_SELECT = { select: { id: true, displayName: true } } as const;

const LINE_SELECT = {
  id: true,
  variantId: true,
  quantity: true,
  sku: true,
  productName: true,
  language: true,
  edition: true,
  unitPriceMinor: true,
  lineTotalMinor: true,
  reservation: { select: { quantityReserved: true, quantityConsumed: true, quantityReleased: true } },
  variant: {
    select: {
      sku: true,
      language: true,
      edition: true,
      unitPriceMinor: true,
      isActive: true,
      product: { select: { name: true, isActive: true } },
      inventory: { select: { sellable: true, reserved: true } },
    },
  },
} satisfies Prisma.OrderLineSelect;

const ORDER_SELECT = {
  id: true,
  number: true,
  status: true,
  version: true,
  totalMinor: true,
  createdAt: true,
  updatedAt: true,
  submittedAt: true,
  cancelledAt: true,
  cancellationReason: true,
  confirmedAt: true,
  rejectedAt: true,
  rejectionReason: true,
  organization: { select: { id: true, name: true } },
  createdBy: ACTOR_SELECT,
  submittedBy: ACTOR_SELECT,
  cancelledBy: ACTOR_SELECT,
  confirmedBy: ACTOR_SELECT,
  rejectedBy: ACTOR_SELECT,
  lines: { select: LINE_SELECT },
} satisfies Prisma.OrderSelect;

type OrderRecord = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;
type LineRecord = OrderRecord["lines"][number];
type DbStatus = OrderRecord["status"];

const STATUS: Record<DbStatus, OrderStatus> = {
  DRAFT: "draft",
  SUBMITTED: "submitted",
  CANCELLED: "cancelled",
  CONFIRMED: "confirmed",
  REJECTED: "rejected",
};
const DB_STATUS: Record<OrderStatus, DbStatus> = {
  draft: "DRAFT",
  submitted: "SUBMITTED",
  cancelled: "CANCELLED",
  confirmed: "CONFIRMED",
  rejected: "REJECTED",
};

const isVisible = (line: LineRecord) => line.variant.isActive && line.variant.product.isActive;
const currentAvailable = (line: LineRecord) =>
  line.variant.inventory ? line.variant.inventory.sellable - line.variant.inventory.reserved : 0;

function lineDto(line: LineRecord, status: DbStatus): OrderLine {
  const reservation = line.reservation;
  const reservedQuantity = reservation
    ? reservation.quantityReserved - reservation.quantityConsumed - reservation.quantityReleased
    : null;
  // Frozen snapshot columns are set together at submission (enforced by a CHECK constraint).
  if (line.sku !== null && line.productName !== null && line.language !== null && line.edition !== null
    && line.unitPriceMinor !== null && line.lineTotalMinor !== null) {
    return {
      id: line.id,
      variantId: line.variantId,
      sku: line.sku,
      productName: line.productName,
      language: catalogLanguageSchema.parse(line.language),
      edition: line.edition,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      lineTotalMinor: Number(line.lineTotalMinor),
      isAvailable: true,
      // Staff decide on submitted orders against current stock.
      availableQuantity: status === "SUBMITTED" ? currentAvailable(line) : null,
      reservedQuantity,
    };
  }
  return {
    id: line.id,
    variantId: line.variantId,
    sku: line.variant.sku,
    productName: line.variant.product.name,
    language: catalogLanguageSchema.parse(line.variant.language),
    edition: line.variant.edition,
    quantity: line.quantity,
    unitPriceMinor: line.variant.unitPriceMinor,
    lineTotalMinor: line.variant.unitPriceMinor * line.quantity,
    isAvailable: isVisible(line),
    availableQuantity: currentAvailable(line),
    reservedQuantity,
  };
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly idempotency: IdempotencyService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Retailers only ever see their own organization's orders; staff see all. */
  private scope(auth: AuthContext): Prisma.OrderWhereInput {
    return auth.user.role === "retailer" ? { organizationId: auth.user.organization.id } : {};
  }

  private orderDto(order: OrderRecord): Order {
    const lines = order.lines
      .map((line) => lineDto(line, order.status))
      .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
    const frozen = order.totalMinor !== null;
    return {
      id: order.id,
      number: order.number,
      status: STATUS[order.status],
      version: order.version,
      organization: order.organization,
      currency: this.config.catalogCurrency,
      priceStatus: frozen ? "frozen" : "provisional",
      totalMinor: frozen ? Number(order.totalMinor) : lines.reduce((sum, line) => sum + line.lineTotalMinor, 0),
      lines,
      createdBy: order.createdBy,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      submittedBy: order.submittedBy,
      submittedAt: order.submittedAt?.toISOString() ?? null,
      cancelledBy: order.cancelledBy,
      cancelledAt: order.cancelledAt?.toISOString() ?? null,
      cancellationReason: order.cancellationReason,
      confirmedBy: order.confirmedBy,
      confirmedAt: order.confirmedAt?.toISOString() ?? null,
      rejectedBy: order.rejectedBy,
      rejectedAt: order.rejectedAt?.toISOString() ?? null,
      rejectionReason: order.rejectionReason,
    };
  }

  private async findScoped(tx: Prisma.TransactionClient, orderId: string, auth: AuthContext): Promise<OrderRecord> {
    const order = await tx.order.findFirst({ where: { id: orderId, ...this.scope(auth) }, select: ORDER_SELECT });
    if (!order) {
      throw ApiException.notFound("Order not found.");
    }
    return order;
  }

  async list(query: OrderQuery, auth: AuthContext): Promise<OrderListResponse> {
    const where: Prisma.OrderWhereInput = {
      ...this.scope(auth),
      ...(query.status ? { status: DB_STATUS[query.status] } : {}),
    };
    // Both queries observe the same snapshot so the total matches the page.
    const [total, orders] = await this.prisma.$transaction(
      [
        this.prisma.order.count({ where }),
        this.prisma.order.findMany({
          where,
          select: ORDER_SELECT,
          orderBy:
            query.sort === "submitted_asc"
              ? [{ submittedAt: { sort: "asc", nulls: "last" } }, { id: "asc" }]
              : [{ createdAt: "desc" }, { id: "desc" }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return {
      items: orders.map((order) => {
        const dto = this.orderDto(order);
        return {
          id: dto.id,
          number: dto.number,
          status: dto.status,
          version: dto.version,
          organization: dto.organization,
          currency: dto.currency,
          priceStatus: dto.priceStatus,
          totalMinor: dto.totalMinor,
          createdAt: dto.createdAt,
          updatedAt: dto.updatedAt,
          submittedAt: dto.submittedAt,
          lineCount: dto.lines.length,
        };
      }),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async detail(orderId: string, auth: AuthContext): Promise<Order> {
    return this.orderDto(await this.findScoped(this.prisma, orderId, auth));
  }

  /** Newly added variants must be visible in the catalog; variants already in the draft may stay. */
  private async validateLines(
    tx: Prisma.TransactionClient,
    lines: CreateOrder["lines"],
    alreadyInDraft: ReadonlySet<string>,
  ): Promise<void> {
    const variants = await tx.productVariant.findMany({
      where: { id: { in: lines.map((line) => line.variantId) } },
      select: { id: true, isActive: true, product: { select: { isActive: true } } },
    });
    const byId = new Map(variants.map((variant) => [variant.id, variant]));
    const details: ErrorDetail[] = [];
    lines.forEach((line, index) => {
      const variant = byId.get(line.variantId);
      if (!variant) {
        details.push({ field: `lines.${index}.variantId`, message: "Unknown catalog item." });
      } else if (!alreadyInDraft.has(line.variantId) && !(variant.isActive && variant.product.isActive)) {
        details.push({ field: `lines.${index}.variantId`, message: "This item is not available in the catalog." });
      }
    });
    if (details.length > 0) {
      throw ApiException.validationFailed(details);
    }
  }

  private assertStatus(order: OrderRecord, allowed: readonly OrderRecord["status"][], message: string): void {
    if (!allowed.includes(order.status)) {
      throw ApiException.invalidOrderTransition(message);
    }
  }

  private assertVersion(order: OrderRecord, version: number): void {
    if (order.version !== version) {
      throw ApiException.versionConflict(order.version);
    }
  }

  private async bumpVersion(
    tx: Prisma.TransactionClient,
    order: OrderRecord,
    data: Prisma.OrderUncheckedUpdateManyInput,
  ): Promise<void> {
    // The version guard makes a concurrent writer that slipped past the check fail instead of overwriting.
    const updated = await tx.order.updateMany({
      where: { id: order.id, version: order.version },
      data: { ...data, version: order.version + 1, updatedAt: this.clock.now() },
    });
    if (updated.count !== 1) {
      throw ApiException.versionConflict(order.version + 1);
    }
  }

  create(input: CreateOrder, auth: AuthContext, key: string): Promise<Order> {
    return this.idempotency.execute(
      { organizationId: auth.user.organization.id, actorId: auth.user.id, operation: "order.create", target: "", key },
      input,
      orderSchema,
      async (tx) => {
        await this.validateLines(tx, input.lines, new Set());
        const now = this.clock.now();
        const created = await tx.order.create({
          data: {
            organizationId: auth.user.organization.id,
            status: "DRAFT",
            currency: this.config.catalogCurrency,
            createdById: auth.user.id,
            createdAt: now,
            updatedAt: now,
            lines: { create: input.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })) },
          },
          select: { id: true, number: true },
        });
        await recordAudit(tx, this.clock, auth, {
          entityType: "order",
          entityId: created.id,
          action: "created",
          before: null,
          after: { number: created.number, status: "DRAFT", version: 1, lineCount: input.lines.length },
        });
        return this.orderDto(await this.findScoped(tx, created.id, auth));
      },
    );
  }

  saveLines(orderId: string, input: SaveOrderLines, auth: AuthContext): Promise<Order> {
    return runSerializable(this.prisma, async (tx) => {
      const order = await this.findScoped(tx, orderId, auth);
      this.assertStatus(order, ["DRAFT"], "Only draft orders can be edited.");
      this.assertVersion(order, input.version);
      const existing = new Set(order.lines.map((line) => line.variantId));
      await this.validateLines(tx, input.lines, existing);

      const kept = new Set(input.lines.map((line) => line.variantId));
      await tx.orderLine.deleteMany({ where: { orderId, variantId: { notIn: [...kept] } } });
      for (const line of input.lines) {
        await tx.orderLine.upsert({
          where: { orderId_variantId: { orderId, variantId: line.variantId } },
          create: { orderId, variantId: line.variantId, quantity: line.quantity },
          update: { quantity: line.quantity },
        });
      }
      await this.bumpVersion(tx, order, {});
      await recordAudit(tx, this.clock, auth, {
        entityType: "order",
        entityId: orderId,
        action: "lines_updated",
        before: { version: order.version, lineCount: order.lines.length },
        after: { version: order.version + 1, lineCount: input.lines.length },
      });
      return this.orderDto(await this.findScoped(tx, orderId, auth));
    });
  }

  submit(orderId: string, input: SubmitOrder, auth: AuthContext, key: string): Promise<Order> {
    return this.idempotency.execute(
      { organizationId: auth.user.organization.id, actorId: auth.user.id, operation: "order.submit", target: orderId, key },
      input,
      orderSchema,
      async (tx) => {
        const order = await this.findScoped(tx, orderId, auth);
        this.assertStatus(order, ["DRAFT"], "Only draft orders can be submitted.");
        this.assertVersion(order, input.version);
        if (order.lines.length === 0) {
          throw ApiException.validationFailed([{ field: "lines", message: "Add at least one item before submitting." }]);
        }
        const reviewed = new Map(input.reviewedPrices.map((price) => [price.variantId, price.unitPriceMinor]));
        const lineVariants = new Set(order.lines.map((line) => line.variantId));
        if (reviewed.size !== input.reviewedPrices.length || reviewed.size !== lineVariants.size || [...reviewed.keys()].some((id) => !lineVariants.has(id))) {
          throw ApiException.validationFailed([{ field: "reviewedPrices", message: "Review the price of every item exactly once." }]);
        }
        const unavailable = order.lines.filter((line) => !isVisible(line));
        if (unavailable.length > 0) {
          throw ApiException.variantUnavailable(
            unavailable.map((line) => ({ field: `lines.${line.variant.sku}`, message: "No longer available. Remove it to submit." })),
          );
        }
        const drifted = order.lines.filter((line) => reviewed.get(line.variantId) !== line.variant.unitPriceMinor);
        if (drifted.length > 0) {
          throw ApiException.priceChanged(
            drifted.map((line) => ({
              field: `lines.${line.variant.sku}`,
              message: `Price changed from ${reviewed.get(line.variantId)} to ${line.variant.unitPriceMinor} (minor units).`,
            })),
          );
        }

        let total = 0n;
        for (const line of order.lines) {
          const lineTotal = BigInt(line.variant.unitPriceMinor) * BigInt(line.quantity);
          total += lineTotal;
          await tx.orderLine.update({
            where: { id: line.id },
            data: {
              sku: line.variant.sku,
              productName: line.variant.product.name,
              language: line.variant.language,
              edition: line.variant.edition,
              unitPriceMinor: line.variant.unitPriceMinor,
              lineTotalMinor: lineTotal,
            },
          });
        }
        await this.bumpVersion(tx, order, { status: "SUBMITTED", submittedAt: this.clock.now(), submittedById: auth.user.id, totalMinor: total });
        await recordAudit(tx, this.clock, auth, {
          entityType: "order",
          entityId: orderId,
          action: "submitted",
          before: { status: "DRAFT", version: order.version },
          after: { status: "SUBMITTED", version: order.version + 1, lineCount: order.lines.length, totalMinor: Number(total) },
        });
        return this.orderDto(await this.findScoped(tx, orderId, auth));
      },
      200,
    );
  }

  cancel(orderId: string, input: CancelOrder, auth: AuthContext, key: string): Promise<Order> {
    return this.idempotency.execute(
      { organizationId: auth.user.organization.id, actorId: auth.user.id, operation: "order.cancel", target: orderId, key },
      input,
      orderSchema,
      async (tx) => {
        const order = await this.findScoped(tx, orderId, auth);
        this.assertStatus(
          order,
          ["DRAFT", "SUBMITTED"],
          order.status === "CONFIRMED"
            ? "Confirmed orders cannot be cancelled here yet."
            : "This order can no longer be cancelled.",
        );
        this.assertVersion(order, input.version);
        await this.bumpVersion(tx, order, {
          status: "CANCELLED",
          cancelledAt: this.clock.now(),
          cancelledById: auth.user.id,
          cancellationReason: input.reason ?? null,
        });
        await recordAudit(tx, this.clock, auth, {
          entityType: "order",
          entityId: orderId,
          action: "cancelled",
          before: { status: order.status, version: order.version },
          after: { status: "CANCELLED", version: order.version + 1, reason: input.reason ?? null },
        });
        return this.orderDto(await this.findScoped(tx, orderId, auth));
      },
      200,
    );
  }

  /** Reserves stock for every line in one transaction, or reserves nothing and reports each shortage. */
  confirm(orderId: string, input: ConfirmOrder, auth: AuthContext, key: string): Promise<Order> {
    return this.idempotency.execute(
      { organizationId: auth.user.organization.id, actorId: auth.user.id, operation: "order.confirm", target: orderId, key },
      input,
      orderSchema,
      async (tx) => {
        const order = await this.findScoped(tx, orderId, auth);
        this.assertStatus(order, ["SUBMITTED"], "Only submitted orders can be confirmed.");
        this.assertVersion(order, input.version);
        const correlationId = currentCorrelationId();
        if (!correlationId) {
          throw new Error("Order confirmation requires request context.");
        }

        const items = await tx.inventoryItem.findMany({
          where: { variantId: { in: order.lines.map((line) => line.variantId) } },
          select: { variantId: true, sellable: true, reserved: true },
        });
        const stock = new Map(items.map((item) => [item.variantId, item]));
        const shortages: ErrorDetail[] = [];
        for (const line of order.lines) {
          const item = stock.get(line.variantId);
          const available = item ? item.sellable - item.reserved : 0;
          if (line.quantity > available) {
            shortages.push({ field: `lines.${line.sku ?? line.variant.sku}`, message: `Needs ${line.quantity}, only ${available} available.` });
          }
        }
        if (shortages.length > 0) {
          throw ApiException.insufficientStock(shortages);
        }

        const now = this.clock.now();
        const reserved: Record<string, number> = {};
        for (const line of order.lines) {
          const reservation = await tx.stockReservation.create({
            data: { orderLineId: line.id, variantId: line.variantId, quantityReserved: line.quantity, createdAt: now },
            select: { id: true },
          });
          const item = await tx.inventoryItem.update({
            where: { variantId: line.variantId },
            data: { reserved: { increment: line.quantity }, updatedAt: now },
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
              reference: order.number,
              reservationId: reservation.id,
              actorId: auth.user.id,
              organizationId: auth.user.organization.id,
              correlationId,
              occurredAt: now,
            },
          });
          reserved[line.sku ?? line.variant.sku] = line.quantity;
        }
        await this.bumpVersion(tx, order, { status: "CONFIRMED", confirmedAt: now, confirmedById: auth.user.id });
        await recordAudit(tx, this.clock, auth, {
          entityType: "order",
          entityId: orderId,
          action: "confirmed",
          before: { status: "SUBMITTED", version: order.version },
          after: { status: "CONFIRMED", version: order.version + 1, reserved },
        });
        return this.orderDto(await this.findScoped(tx, orderId, auth));
      },
      200,
    );
  }

  reject(orderId: string, input: RejectOrder, auth: AuthContext, key: string): Promise<Order> {
    return this.idempotency.execute(
      { organizationId: auth.user.organization.id, actorId: auth.user.id, operation: "order.reject", target: orderId, key },
      input,
      orderSchema,
      async (tx) => {
        const order = await this.findScoped(tx, orderId, auth);
        this.assertStatus(order, ["SUBMITTED"], "Only submitted orders can be rejected.");
        this.assertVersion(order, input.version);
        await this.bumpVersion(tx, order, {
          status: "REJECTED",
          rejectedAt: this.clock.now(),
          rejectedById: auth.user.id,
          rejectionReason: input.reason,
        });
        await recordAudit(tx, this.clock, auth, {
          entityType: "order",
          entityId: orderId,
          action: "rejected",
          before: { status: "SUBMITTED", version: order.version },
          after: { status: "REJECTED", version: order.version + 1, reason: input.reason },
        });
        return this.orderDto(await this.findScoped(tx, orderId, auth));
      },
      200,
    );
  }
}
