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
  type ApproveCancellation,
  type ConfirmOrder,
  type RejectCancellation,
  type RejectOrder,
  type RequestCancellation,
  type ShipOrder,
  type SaveOrderLines,
  type SubmitOrder,
} from "@pandora/contracts";
import { recordAudit } from "../../common/audit/audit.js";
import { BugLab } from "../../common/bug-lab/bug-lab.js";
import { Clock } from "../../common/clock/clock.js";
import { APP_CONFIG, type AppConfig } from "../../common/config/app-config.js";
import { ApiException } from "../../common/errors/api-exception.js";
import { IdempotencyService } from "../../common/idempotency/idempotency.service.js";
import { currentCorrelationId } from "../../common/request-context/request-context.js";
import { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { runSerializable } from "../../infrastructure/prisma/serializable.js";
import type { AuthContext } from "../auth/auth-context.js";
import { NotificationOutbox, type OrderRef } from "../notifications/notification-outbox.js";

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
  shippedQuantity: true,
  cancelledQuantity: true,
  reservation: { select: { id: true, quantityReserved: true, quantityConsumed: true, quantityReleased: true } },
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
  shipments: {
    select: {
      id: true,
      number: true,
      createdAt: true,
      createdBy: ACTOR_SELECT,
      items: {
        select: {
          id: true,
          orderLineId: true,
          quantity: true,
          orderLine: { select: { sku: true } },
          returnItems: { select: { quantity: true, receivedSellable: true, receivedDamaged: true, request: { select: { status: true } } } },
        },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
  cancellationRequests: {
    select: {
      id: true,
      status: true,
      reason: true,
      requestedAt: true,
      decidedAt: true,
      decisionReason: true,
      requestedBy: ACTOR_SELECT,
      decidedBy: ACTOR_SELECT,
      items: { select: { orderLineId: true, quantity: true, orderLine: { select: { sku: true } } } },
    },
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
  },
  returnRequests: {
    select: {
      id: true,
      number: true,
      status: true,
      reason: true,
      requestedAt: true,
      decidedAt: true,
      decisionReason: true,
      receivedAt: true,
      discrepancyReason: true,
      requestedBy: ACTOR_SELECT,
      decidedBy: ACTOR_SELECT,
      receivedBy: ACTOR_SELECT,
      items: {
        select: {
          id: true,
          shipmentItemId: true,
          quantity: true,
          receivedSellable: true,
          receivedDamaged: true,
          shipmentItem: { select: { orderLineId: true, shipment: { select: { number: true } }, orderLine: { select: { sku: true, variantId: true } } } },
        },
        orderBy: { id: "asc" },
      },
    },
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.OrderSelect;

export type OrderRecord = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;
type LineRecord = OrderRecord["lines"][number];
type DbStatus = OrderRecord["status"];

const STATUS: Record<DbStatus, OrderStatus> = {
  DRAFT: "draft",
  SUBMITTED: "submitted",
  CANCELLED: "cancelled",
  CONFIRMED: "confirmed",
  REJECTED: "rejected",
  PARTIALLY_SHIPPED: "partially_shipped",
  SHIPPED: "shipped",
  CLOSED_PARTIAL: "closed_partial",
};
const DB_STATUS: Record<OrderStatus, DbStatus> = {
  draft: "DRAFT",
  submitted: "SUBMITTED",
  cancelled: "CANCELLED",
  confirmed: "CONFIRMED",
  rejected: "REJECTED",
  partially_shipped: "PARTIALLY_SHIPPED",
  shipped: "SHIPPED",
  closed_partial: "CLOSED_PARTIAL",
};
const REQUEST_STATUS = { PENDING: "pending", APPROVED: "approved", REJECTED: "rejected" } as const;
const RETURN_STATUS = { PENDING: "pending", APPROVED: "approved", REJECTED: "rejected", COMPLETED: "completed" } as const;
const OPEN_RETURN: readonly OrderRecord["returnRequests"][number]["status"][] = ["PENDING", "APPROVED"];
const OPEN_FOR_FULFILLMENT: readonly DbStatus[] = ["CONFIRMED", "PARTIALLY_SHIPPED"];

/** Units of a shipment item still free to return: rejected returns free theirs, completed ones count what arrived. */
export function returnableQuantity(item: OrderRecord["shipments"][number]["items"][number]): number {
  const claimed = item.returnItems.reduce((sum, returned) => {
    if (returned.request.status === "REJECTED") return sum;
    if (returned.request.status === "COMPLETED") return sum + (returned.receivedSellable ?? 0) + (returned.receivedDamaged ?? 0);
    return sum + returned.quantity;
  }, 0);
  return item.quantity - claimed;
}

export const orderRef = (order: OrderRecord): OrderRef => ({
  id: order.id,
  number: order.number,
  organizationId: order.organization.id,
  organizationName: order.organization.name,
});

const outstanding = (line: { quantity: number; shippedQuantity: number; cancelledQuantity: number }) =>
  line.quantity - line.shippedQuantity - line.cancelledQuantity;

/** Status after confirmation, derived from cumulative line quantities (overview §5). */
function deriveFulfillmentStatus(lines: readonly { quantity: number; shippedQuantity: number; cancelledQuantity: number }[]): DbStatus {
  const shipped = lines.reduce((sum, line) => sum + line.shippedQuantity, 0);
  const cancelled = lines.reduce((sum, line) => sum + line.cancelledQuantity, 0);
  const open = lines.reduce((sum, line) => sum + outstanding(line), 0);
  if (open > 0) return shipped === 0 ? "CONFIRMED" : "PARTIALLY_SHIPPED";
  if (cancelled === 0) return "SHIPPED";
  return shipped === 0 ? "CANCELLED" : "CLOSED_PARTIAL";
}

const isVisible = (line: LineRecord) => line.variant.isActive && line.variant.product.isActive;
const currentAvailable = (line: LineRecord) =>
  line.variant.inventory ? line.variant.inventory.sellable - line.variant.inventory.reserved : 0;

function lineDto(line: LineRecord, status: DbStatus, bugLab: BugLab): OrderLine {
  const reservation = line.reservation;
  const reservedQuantity = reservation
    ? reservation.quantityReserved - reservation.quantityConsumed - reservation.quantityReleased
    : null;
  // Frozen snapshot columns are set together at submission (enforced by a CHECK constraint).
  if (line.sku !== null && line.productName !== null && line.language !== null && line.edition !== null
    && line.unitPriceMinor !== null && line.lineTotalMinor !== null) {
    // Bug Lab BUG-003: show the current catalog price instead of the frozen snapshot (Standard: always the snapshot).
    const bug003 = bugLab.has("BUG-003");
    return {
      id: line.id,
      variantId: line.variantId,
      sku: line.sku,
      productName: line.productName,
      language: catalogLanguageSchema.parse(line.language),
      edition: line.edition,
      quantity: line.quantity,
      unitPriceMinor: bug003 ? line.variant.unitPriceMinor : line.unitPriceMinor,
      lineTotalMinor: bug003 ? line.variant.unitPriceMinor * line.quantity : Number(line.lineTotalMinor),
      isAvailable: true,
      // Staff decide on submitted orders against current stock.
      availableQuantity: status === "SUBMITTED" ? currentAvailable(line) : null,
      reservedQuantity,
      shippedQuantity: line.shippedQuantity,
      cancelledQuantity: line.cancelledQuantity,
      outstandingQuantity: outstanding(line),
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
    shippedQuantity: line.shippedQuantity,
    cancelledQuantity: line.cancelledQuantity,
    outstandingQuantity: outstanding(line),
  };
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly idempotency: IdempotencyService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly bugLab: BugLab,
    private readonly outbox: NotificationOutbox,
  ) {}

  /** Retailers only ever see their own organization's orders; staff see all. */
  private scope(auth: AuthContext): Prisma.OrderWhereInput {
    return auth.user.role === "retailer" ? { organizationId: auth.user.organization.id } : {};
  }

  orderDto(order: OrderRecord): Order {
    const lines = order.lines
      .map((line) => lineDto(line, order.status, this.bugLab))
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
      shipments: order.shipments.map((shipment) => ({
        id: shipment.id,
        number: shipment.number,
        createdAt: shipment.createdAt.toISOString(),
        createdBy: shipment.createdBy,
        items: shipment.items.map((item) => ({
          id: item.id,
          orderLineId: item.orderLineId,
          sku: item.orderLine.sku ?? "",
          quantity: item.quantity,
          returnableQuantity: returnableQuantity(item),
        })),
      })),
      cancellationRequests: order.cancellationRequests.map((request) => ({
        id: request.id,
        status: REQUEST_STATUS[request.status],
        reason: request.reason,
        requestedBy: request.requestedBy,
        requestedAt: request.requestedAt.toISOString(),
        decidedBy: request.decidedBy,
        decidedAt: request.decidedAt?.toISOString() ?? null,
        decisionReason: request.decisionReason,
        items: request.items.map((item) => ({ orderLineId: item.orderLineId, sku: item.orderLine.sku ?? "", quantity: item.quantity })),
      })),
      returns: order.returnRequests.map((request) => ({
        id: request.id,
        number: request.number,
        status: RETURN_STATUS[request.status],
        reason: request.reason,
        requestedBy: request.requestedBy,
        requestedAt: request.requestedAt.toISOString(),
        decidedBy: request.decidedBy,
        decidedAt: request.decidedAt?.toISOString() ?? null,
        decisionReason: request.decisionReason,
        receivedBy: request.receivedBy,
        receivedAt: request.receivedAt?.toISOString() ?? null,
        discrepancyReason: request.discrepancyReason,
        items: request.items.map((item) => ({
          id: item.id,
          shipmentItemId: item.shipmentItemId,
          shipmentNumber: item.shipmentItem.shipment.number,
          orderLineId: item.shipmentItem.orderLineId,
          sku: item.shipmentItem.orderLine.sku ?? "",
          quantity: item.quantity,
          receivedSellable: item.receivedSellable,
          receivedDamaged: item.receivedDamaged,
        })),
      })),
    };
  }

  async findScoped(tx: Prisma.TransactionClient, orderId: string, auth: AuthContext): Promise<OrderRecord> {
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
      ...(query.returns === "open" ? { returnRequests: { some: { status: { in: [...OPEN_RETURN] } } } } : {}),
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
          // Bug Lab BUG-002: page 2 onward starts one row early (Standard: exact page boundaries).
          skip: (query.page - 1) * query.pageSize - (this.bugLab.has("BUG-002") && query.page > 1 ? 1 : 0),
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
          openReturnCount: order.returnRequests.filter((request) => OPEN_RETURN.includes(request.status)).length,
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
        await this.outbox.enqueue(tx, { type: "order.submitted", order: orderRef(order), lineCount: order.lines.length, totalMinor: Number(total) });
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
          OPEN_FOR_FULFILLMENT.includes(order.status)
            ? "Confirmed orders are cancelled through a cancellation request."
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
        await this.outbox.enqueue(tx, { type: "order.confirmed", order: orderRef(order) });
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
        await this.outbox.enqueue(tx, { type: "order.rejected", order: orderRef(order), reason: input.reason });
        return this.orderDto(await this.findScoped(tx, orderId, auth));
      },
      200,
    );
  }

  private correlationId(): string {
    const correlationId = currentCorrelationId();
    if (!correlationId) {
      throw new Error("Order fulfillment requires request context.");
    }
    return correlationId;
  }

  /** Records staff-chosen quantities as one immutable shipment; each unit consumes its reservation and sellable stock. */
  ship(orderId: string, input: ShipOrder, auth: AuthContext, key: string): Promise<Order> {
    return this.idempotency.execute(
      { organizationId: auth.user.organization.id, actorId: auth.user.id, operation: "order.ship", target: orderId, key },
      input,
      orderSchema,
      async (tx) => {
        const order = await this.findScoped(tx, orderId, auth);
        this.assertStatus(order, OPEN_FOR_FULFILLMENT, "Only confirmed or partially shipped orders can be shipped.");
        this.assertVersion(order, input.version);
        const lines = new Map(order.lines.map((line) => [line.id, line]));
        const unknown = input.items.flatMap((item, index) =>
          lines.has(item.orderLineId) ? [] : [{ field: `items.${index}.orderLineId`, message: "Not a line of this order." }],
        );
        if (unknown.length > 0) {
          throw ApiException.validationFailed(unknown);
        }
        const exceeded = input.items.flatMap((item) => {
          const line = lines.get(item.orderLineId);
          return line && item.quantity > outstanding(line)
            ? [{ field: `lines.${line.sku ?? line.variant.sku}`, message: `Only ${outstanding(line)} left to ship.` }]
            : [];
        });
        if (exceeded.length > 0) {
          throw ApiException.shipmentQuantityExceeded(exceeded);
        }

        const now = this.clock.now();
        const correlationId = this.correlationId();
        const shipment = await tx.shipment.create({
          data: {
            orderId,
            createdById: auth.user.id,
            createdAt: now,
            items: { create: input.items.map((item) => ({ orderLineId: item.orderLineId, quantity: item.quantity })) },
          },
          select: { id: true, number: true },
        });
        const shippedBySku: Record<string, number> = {};
        for (const item of input.items) {
          const line = lines.get(item.orderLineId);
          if (!line?.reservation) {
            throw new Error(`Line ${item.orderLineId} of a confirmed order has no reservation.`);
          }
          await tx.orderLine.update({ where: { id: line.id }, data: { shippedQuantity: { increment: item.quantity } } });
          await tx.stockReservation.update({ where: { id: line.reservation.id }, data: { quantityConsumed: { increment: item.quantity } } });
          // Sellable and reserved drop together, so availability is unchanged by shipping.
          const stock = await tx.inventoryItem.update({
            where: { variantId: line.variantId },
            data: { sellable: { decrement: item.quantity }, reserved: { decrement: item.quantity }, updatedAt: now },
            select: { sellable: true, reserved: true, damaged: true },
          });
          for (const bucket of ["SELLABLE", "RESERVED"] as const) {
            await tx.inventoryMovement.create({
              data: {
                variantId: line.variantId,
                type: "SHIPMENT",
                bucket,
                delta: -item.quantity,
                sellableAfter: stock.sellable,
                reservedAfter: stock.reserved,
                damagedAfter: stock.damaged,
                reference: shipment.number,
                reservationId: line.reservation.id,
                actorId: auth.user.id,
                organizationId: auth.user.organization.id,
                correlationId,
                occurredAt: now,
              },
            });
          }
          shippedBySku[line.sku ?? line.variant.sku] = item.quantity;
        }
        const shippedQuantities = new Map(input.items.map((item) => [item.orderLineId, item.quantity]));
        const derived = deriveFulfillmentStatus(
          order.lines.map((line) => ({ ...line, shippedQuantity: line.shippedQuantity + (shippedQuantities.get(line.id) ?? 0) })),
        );
        // Bug Lab BUG-001: the final shipment of an already partially shipped order keeps it partially_shipped
        // (Standard: shipped). Only a database marked for BUG-001 accepts that state.
        const status = this.bugLab.has("BUG-001") && order.status === "PARTIALLY_SHIPPED" && derived === "SHIPPED" ? "PARTIALLY_SHIPPED" : derived;
        await this.bumpVersion(tx, order, { status });
        await recordAudit(tx, this.clock, auth, {
          entityType: "order",
          entityId: orderId,
          action: "shipped",
          before: { status: order.status, version: order.version },
          after: { status, version: order.version + 1, shipment: shipment.number, shipped: shippedBySku },
        });
        await this.outbox.enqueue(tx, {
          type: "shipment.recorded",
          order: orderRef(order),
          shipmentId: shipment.id,
          shipmentNumber: shipment.number,
          items: shippedBySku,
        });
        return this.orderDto(await this.findScoped(tx, orderId, auth));
      },
      200,
    );
  }

  /** Retailer asks to cancel selected unshipped units (or all of them); nothing is released until staff approve. */
  async requestCancellation(orderId: string, input: RequestCancellation, auth: AuthContext, key: string): Promise<Order> {
    try {
      return await this.idempotency.execute(
        { organizationId: auth.user.organization.id, actorId: auth.user.id, operation: "order.cancellation_request", target: orderId, key },
        input,
        orderSchema,
        async (tx) => {
          const order = await this.findScoped(tx, orderId, auth);
          this.assertStatus(order, OPEN_FOR_FULFILLMENT, "Only confirmed or partially shipped orders accept cancellation requests.");
          this.assertVersion(order, input.version);
          const lines = new Map(order.lines.map((line) => [line.id, line]));
          const unknown = (input.items ?? []).flatMap((item, index) =>
            lines.has(item.orderLineId) ? [] : [{ field: `items.${index}.orderLineId`, message: "Not a line of this order." }],
          );
          if (unknown.length > 0) {
            throw ApiException.validationFailed(unknown);
          }
          if (order.cancellationRequests.some((request) => request.status === "PENDING")) {
            throw ApiException.cancellationRequestPending();
          }
          const requested = input.items
            ? input.items.flatMap((item) => {
                const line = lines.get(item.orderLineId);
                return line ? [{ line, quantity: item.quantity }] : [];
              })
            : order.lines.filter((line) => outstanding(line) > 0).map((line) => ({ line, quantity: outstanding(line) }));
          if (requested.length === 0) {
            throw ApiException.invalidOrderTransition("Nothing is left to cancel.");
          }
          const exceeded = requested.flatMap(({ line, quantity }) =>
            quantity > outstanding(line)
              ? [{ field: `lines.${line.sku ?? line.variant.sku}`, message: `Only ${outstanding(line)} left to cancel.` }]
              : [],
          );
          if (exceeded.length > 0) {
            throw ApiException.cancellationQuantityExceeded(exceeded);
          }
          const created = await tx.cancellationRequest.create({
            select: { id: true },
            data: {
              orderId,
              status: "PENDING",
              reason: input.reason ?? null,
              requestedById: auth.user.id,
              requestedAt: this.clock.now(),
              items: { create: requested.map(({ line, quantity }) => ({ orderLineId: line.id, quantity })) },
            },
          });
          await this.bumpVersion(tx, order, {});
          await recordAudit(tx, this.clock, auth, {
            entityType: "order",
            entityId: orderId,
            action: "cancellation_requested",
            before: { version: order.version },
            after: {
              version: order.version + 1,
              reason: input.reason ?? null,
              scope: input.items ? "selected" : "all_remaining",
              requested: Object.fromEntries(requested.map(({ line, quantity }) => [line.sku ?? line.variant.sku, quantity])),
            },
          });
          await this.outbox.enqueue(tx, {
            type: "cancellation.requested",
            order: orderRef(order),
            requestId: created.id,
            items: Object.fromEntries(requested.map(({ line, quantity }) => [line.sku ?? line.variant.sku, quantity])),
            reason: input.reason ?? null,
          });
          return this.orderDto(await this.findScoped(tx, orderId, auth));
        },
        200,
      );
    } catch (error: unknown) {
      // The one-pending-request index can fire when two requests race past the check above.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw ApiException.cancellationRequestPending();
      }
      throw error;
    }
  }

  private pendingRequest(order: OrderRecord, requestId: string) {
    const request = order.cancellationRequests.find((candidate) => candidate.id === requestId);
    if (!request) {
      throw ApiException.notFound("Cancellation request not found.");
    }
    this.assertStatus(order, OPEN_FOR_FULFILLMENT, "This order is closed; its cancellation request can no longer be decided.");
    if (request.status !== "PENDING") {
      throw ApiException.invalidOrderTransition("This cancellation request was already decided.");
    }
    return request;
  }

  /** Approves the whole request after rechecking it against current outstanding quantities. */
  approveCancellation(orderId: string, requestId: string, input: ApproveCancellation, auth: AuthContext, key: string): Promise<Order> {
    return this.idempotency.execute(
      { organizationId: auth.user.organization.id, actorId: auth.user.id, operation: "order.cancellation_approve", target: requestId, key },
      input,
      orderSchema,
      async (tx) => {
        const order = await this.findScoped(tx, orderId, auth);
        const request = this.pendingRequest(order, requestId);
        this.assertVersion(order, input.version);
        const lines = new Map(order.lines.map((line) => [line.id, line]));
        const conflicts = request.items.flatMap((item) => {
          const line = lines.get(item.orderLineId);
          return line && item.quantity > outstanding(line)
            ? [{ field: `lines.${line.sku ?? line.variant.sku}`, message: `Requested ${item.quantity}, only ${outstanding(line)} still outstanding.` }]
            : [];
        });
        if (conflicts.length > 0) {
          throw ApiException.cancellationConflict(conflicts);
        }

        const now = this.clock.now();
        const correlationId = this.correlationId();
        const released: Record<string, number> = {};
        for (const item of request.items) {
          const line = lines.get(item.orderLineId);
          if (!line?.reservation) {
            throw new Error(`Line ${item.orderLineId} of a confirmed order has no reservation.`);
          }
          await tx.orderLine.update({ where: { id: line.id }, data: { cancelledQuantity: { increment: item.quantity } } });
          await tx.stockReservation.update({ where: { id: line.reservation.id }, data: { quantityReleased: { increment: item.quantity } } });
          const stock = await tx.inventoryItem.update({
            where: { variantId: line.variantId },
            data: { reserved: { decrement: item.quantity }, updatedAt: now },
            select: { sellable: true, reserved: true, damaged: true },
          });
          await tx.inventoryMovement.create({
            data: {
              variantId: line.variantId,
              type: "RELEASE",
              bucket: "RESERVED",
              delta: -item.quantity,
              sellableAfter: stock.sellable,
              reservedAfter: stock.reserved,
              damagedAfter: stock.damaged,
              reference: order.number,
              reservationId: line.reservation.id,
              actorId: auth.user.id,
              organizationId: auth.user.organization.id,
              correlationId,
              occurredAt: now,
            },
          });
          released[line.sku ?? line.variant.sku] = item.quantity;
        }
        await tx.cancellationRequest.update({
          where: { id: requestId },
          data: { status: "APPROVED", decidedAt: now, decidedById: auth.user.id },
        });
        const cancelledQuantities = new Map(request.items.map((item) => [item.orderLineId, item.quantity]));
        const status = deriveFulfillmentStatus(
          order.lines.map((line) => ({ ...line, cancelledQuantity: line.cancelledQuantity + (cancelledQuantities.get(line.id) ?? 0) })),
        );
        await this.bumpVersion(tx, order, {
          status,
          ...(status === "CANCELLED" ? { cancelledAt: now, cancelledById: auth.user.id, cancellationReason: request.reason } : {}),
        });
        await recordAudit(tx, this.clock, auth, {
          entityType: "order",
          entityId: orderId,
          action: "cancellation_approved",
          before: { status: order.status, version: order.version },
          after: { status, version: order.version + 1, requestId, released },
        });
        await this.outbox.enqueue(tx, { type: "cancellation.decided", order: orderRef(order), requestId, approved: true, items: released, reason: null });
        return this.orderDto(await this.findScoped(tx, orderId, auth));
      },
      200,
    );
  }

  rejectCancellation(orderId: string, requestId: string, input: RejectCancellation, auth: AuthContext, key: string): Promise<Order> {
    return this.idempotency.execute(
      { organizationId: auth.user.organization.id, actorId: auth.user.id, operation: "order.cancellation_reject", target: requestId, key },
      input,
      orderSchema,
      async (tx) => {
        const order = await this.findScoped(tx, orderId, auth);
        this.pendingRequest(order, requestId);
        this.assertVersion(order, input.version);
        await tx.cancellationRequest.update({
          where: { id: requestId },
          data: { status: "REJECTED", decidedAt: this.clock.now(), decidedById: auth.user.id, decisionReason: input.reason },
        });
        await this.bumpVersion(tx, order, {});
        await recordAudit(tx, this.clock, auth, {
          entityType: "order",
          entityId: orderId,
          action: "cancellation_rejected",
          before: { version: order.version },
          after: { version: order.version + 1, requestId, reason: input.reason },
        });
        await this.outbox.enqueue(tx, { type: "cancellation.decided", order: orderRef(order), requestId, approved: false, items: {}, reason: input.reason });
        return this.orderDto(await this.findScoped(tx, orderId, auth));
      },
      200,
    );
  }
}
