import { Injectable } from "@nestjs/common";
import {
  orderSchema,
  type ApproveReturn,
  type ErrorDetail,
  type Order,
  type ReceiveReturn,
  type RejectReturn,
  type RequestReturn,
} from "@pandora/contracts";
import { recordAudit } from "../../common/audit/audit.js";
import { Clock } from "../../common/clock/clock.js";
import { ApiException } from "../../common/errors/api-exception.js";
import { IdempotencyService } from "../../common/idempotency/idempotency.service.js";
import { currentCorrelationId } from "../../common/request-context/request-context.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { AuthContext } from "../auth/auth-context.js";
import { NotificationOutbox } from "../notifications/notification-outbox.js";
import { OrdersService, orderRef, returnableQuantity, type OrderRecord } from "./orders.service.js";

/** Orders with at least one shipment; returns never change their fulfillment status (overview §5–§6). */
const RETURNABLE: readonly OrderRecord["status"][] = ["PARTIALLY_SHIPPED", "SHIPPED", "CLOSED_PARTIAL"];

type ReturnRecord = OrderRecord["returnRequests"][number];

const itemField = (item: ReturnRecord["items"][number]) =>
  `shipments.${item.shipmentItem.shipment.number}.${item.shipmentItem.orderLine.sku ?? ""}`;

/**
 * Return requests, decisions, and the single receipt with inspection. The order row itself is never written:
 * concurrency is guarded by the return's status, Serializable transactions, and the database entitlement trigger.
 */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly orders: OrdersService,
    private readonly clock: Clock,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: NotificationOutbox,
  ) {}

  private async reload(tx: Prisma.TransactionClient, orderId: string, auth: AuthContext): Promise<Order> {
    return this.orders.orderDto(await this.orders.findScoped(tx, orderId, auth));
  }

  private findReturn(order: OrderRecord, returnId: string): ReturnRecord {
    const request = order.returnRequests.find((candidate) => candidate.id === returnId);
    if (!request) {
      throw ApiException.notFound("Return not found.");
    }
    return request;
  }

  /** Moves a return from `from` to its next status; a concurrent decision makes the guarded update miss. */
  private async transition(
    tx: Prisma.TransactionClient,
    request: ReturnRecord,
    from: ReturnRecord["status"],
    data: Prisma.ReturnRequestUncheckedUpdateManyInput,
  ): Promise<void> {
    const updated = await tx.returnRequest.updateMany({ where: { id: request.id, status: from }, data });
    if (updated.count !== 1) {
      throw ApiException.invalidReturnTransition("This return changed in the meantime. Reload the order.");
    }
  }

  /** Retailer asks to send shipped units back; entitlement is checked against every open or completed return. */
  request(orderId: string, input: RequestReturn, auth: AuthContext, key: string): Promise<Order> {
    return this.idempotency.execute(
      { organizationId: auth.user.organization.id, actorId: auth.user.id, operation: "order.return_request", target: orderId, key },
      input,
      orderSchema,
      async (tx) => {
        const order = await this.orders.findScoped(tx, orderId, auth);
        if (!RETURNABLE.includes(order.status)) {
          throw ApiException.invalidOrderTransition("Only orders with shipments accept returns.");
        }
        const shipped = new Map(
          order.shipments.flatMap((shipment) => shipment.items.map((item) => [item.id, { item, shipment: shipment.number }] as const)),
        );
        const unknown = input.items.flatMap((item, index) =>
          shipped.has(item.shipmentItemId) ? [] : [{ field: `items.${index}.shipmentItemId`, message: "Not a shipped item of this order." }],
        );
        if (unknown.length > 0) {
          throw ApiException.validationFailed(unknown);
        }
        const requested = input.items.flatMap((item) => {
          const entry = shipped.get(item.shipmentItemId);
          return entry ? [{ ...entry, quantity: item.quantity, label: `${entry.shipment}.${entry.item.orderLine.sku ?? ""}` }] : [];
        });
        const exceeded: ErrorDetail[] = requested.flatMap(({ item, quantity, label }) =>
          quantity > returnableQuantity(item) ? [{ field: `shipments.${label}`, message: `Only ${returnableQuantity(item)} left to return.` }] : [],
        );
        if (exceeded.length > 0) {
          throw ApiException.returnQuantityExceeded(exceeded);
        }

        const created = await tx.returnRequest.create({
          data: {
            orderId,
            status: "PENDING",
            reason: input.reason,
            requestedById: auth.user.id,
            requestedAt: this.clock.now(),
            items: { create: requested.map(({ item, quantity }) => ({ shipmentItemId: item.id, quantity })) },
          },
          select: { id: true, number: true },
        });
        await recordAudit(tx, this.clock, auth, {
          entityType: "order",
          entityId: orderId,
          action: "return_requested",
          before: null,
          after: {
            returnId: created.id,
            return: created.number,
            reason: input.reason,
            requested: Object.fromEntries(requested.map(({ quantity, label }) => [label, quantity])),
          },
        });
        await this.outbox.enqueue(tx, {
          type: "return.requested",
          order: orderRef(order),
          returnId: created.id,
          returnNumber: created.number,
          items: Object.fromEntries(requested.map(({ quantity, label }) => [label.replace(".", " · "), quantity])),
          reason: input.reason,
        });
        return this.reload(tx, orderId, auth);
      },
      200,
    );
  }

  approve(orderId: string, returnId: string, input: ApproveReturn, auth: AuthContext, key: string): Promise<Order> {
    return this.idempotency.execute(
      { organizationId: auth.user.organization.id, actorId: auth.user.id, operation: "order.return_approve", target: returnId, key },
      input,
      orderSchema,
      async (tx) => {
        const order = await this.orders.findScoped(tx, orderId, auth);
        const request = this.findReturn(order, returnId);
        if (request.status !== "PENDING") {
          throw ApiException.invalidReturnTransition("This return was already decided.");
        }
        await this.transition(tx, request, "PENDING", { status: "APPROVED", decidedAt: this.clock.now(), decidedById: auth.user.id });
        await recordAudit(tx, this.clock, auth, {
          entityType: "order",
          entityId: orderId,
          action: "return_approved",
          before: { returnId, status: "pending" },
          after: { returnId, return: request.number, status: "approved" },
        });
        await this.outbox.enqueue(tx, { type: "return.decided", order: orderRef(order), returnId, returnNumber: request.number, approved: true, reason: null });
        return this.reload(tx, orderId, auth);
      },
      200,
    );
  }

  reject(orderId: string, returnId: string, input: RejectReturn, auth: AuthContext, key: string): Promise<Order> {
    return this.idempotency.execute(
      { organizationId: auth.user.organization.id, actorId: auth.user.id, operation: "order.return_reject", target: returnId, key },
      input,
      orderSchema,
      async (tx) => {
        const order = await this.orders.findScoped(tx, orderId, auth);
        const request = this.findReturn(order, returnId);
        if (request.status !== "PENDING") {
          throw ApiException.invalidReturnTransition("This return was already decided.");
        }
        await this.transition(tx, request, "PENDING", {
          status: "REJECTED",
          decidedAt: this.clock.now(),
          decidedById: auth.user.id,
          decisionReason: input.reason,
        });
        await recordAudit(tx, this.clock, auth, {
          entityType: "order",
          entityId: orderId,
          action: "return_rejected",
          before: { returnId, status: "pending" },
          after: { returnId, return: request.number, status: "rejected", reason: input.reason },
        });
        await this.outbox.enqueue(tx, {
          type: "return.decided",
          order: orderRef(order),
          returnId,
          returnNumber: request.number,
          approved: false,
          reason: input.reason,
        });
        return this.reload(tx, orderId, auth);
      },
      200,
    );
  }

  /** The one receipt of an approved return: inspected units go to sellable or damaged stock. */
  receive(orderId: string, returnId: string, input: ReceiveReturn, auth: AuthContext, key: string): Promise<Order> {
    return this.idempotency.execute(
      { organizationId: auth.user.organization.id, actorId: auth.user.id, operation: "order.return_receive", target: returnId, key },
      input,
      orderSchema,
      async (tx) => {
        const order = await this.orders.findScoped(tx, orderId, auth);
        const request = this.findReturn(order, returnId);
        if (request.status !== "APPROVED") {
          throw ApiException.invalidReturnTransition(
            request.status === "PENDING"
              ? "Approve this return before receiving it."
              : request.status === "COMPLETED"
                ? "This return was already received."
                : "A rejected return cannot be received.",
          );
        }
        const items = new Map(request.items.map((item) => [item.id, item]));
        const invalid: ErrorDetail[] = input.items.flatMap((entry, index) =>
          items.has(entry.returnItemId) ? [] : [{ field: `items.${index}.returnItemId`, message: "Not an item of this return." }],
        );
        const listed = new Set(input.items.map((entry) => entry.returnItemId));
        const missing = request.items.filter((item) => !listed.has(item.id));
        if (missing.length > 0) {
          invalid.push({ field: "items", message: `Inspect every item of this return: ${missing.map(itemField).join(", ")}.` });
        }
        if (invalid.length > 0) {
          throw ApiException.validationFailed(invalid);
        }
        const received = input.items.flatMap((entry) => {
          const item = items.get(entry.returnItemId);
          return item ? [{ item, sellable: entry.sellableQuantity, damaged: entry.damagedQuantity }] : [];
        });
        const exceeded: ErrorDetail[] = received.flatMap(({ item, sellable, damaged }) =>
          sellable + damaged > item.quantity
            ? [{ field: itemField(item), message: `Approved ${item.quantity}, received ${sellable + damaged}.` }]
            : [],
        );
        if (exceeded.length > 0) {
          throw ApiException.returnQuantityExceeded(exceeded);
        }
        const short = received.some(({ item, sellable, damaged }) => sellable + damaged < item.quantity);
        if (short && !input.discrepancyReason) {
          throw ApiException.validationFailed([
            { field: "discrepancyReason", message: "Explain why fewer units arrived than were approved." },
          ]);
        }

        const now = this.clock.now();
        const correlationId = currentCorrelationId();
        if (!correlationId) {
          throw new Error("Return receipts require request context.");
        }
        const sellableBySku: Record<string, number> = {};
        const damagedBySku: Record<string, number> = {};
        for (const { item, sellable, damaged } of received) {
          await tx.returnRequestItem.update({ where: { id: item.id }, data: { receivedSellable: sellable, receivedDamaged: damaged } });
          const sku = item.shipmentItem.orderLine.sku ?? "";
          sellableBySku[sku] = (sellableBySku[sku] ?? 0) + sellable;
          damagedBySku[sku] = (damagedBySku[sku] ?? 0) + damaged;
          for (const [bucket, quantity] of [["SELLABLE", sellable], ["DAMAGED", damaged]] as const) {
            if (quantity === 0) continue;
            const stock = await tx.inventoryItem.update({
              where: { variantId: item.shipmentItem.orderLine.variantId },
              data: { [bucket === "SELLABLE" ? "sellable" : "damaged"]: { increment: quantity }, updatedAt: now },
              select: { sellable: true, reserved: true, damaged: true },
            });
            await tx.inventoryMovement.create({
              data: {
                variantId: item.shipmentItem.orderLine.variantId,
                type: "RETURN",
                bucket,
                delta: quantity,
                sellableAfter: stock.sellable,
                reservedAfter: stock.reserved,
                damagedAfter: stock.damaged,
                reference: request.number,
                actorId: auth.user.id,
                organizationId: auth.user.organization.id,
                correlationId,
                occurredAt: now,
              },
            });
          }
        }
        await this.transition(tx, request, "APPROVED", {
          status: "COMPLETED",
          receivedAt: now,
          receivedById: auth.user.id,
          discrepancyReason: input.discrepancyReason ?? null,
        });
        await recordAudit(tx, this.clock, auth, {
          entityType: "order",
          entityId: orderId,
          action: "return_received",
          before: { returnId, status: "approved" },
          after: {
            returnId,
            return: request.number,
            status: "completed",
            sellable: sellableBySku,
            damaged: damagedBySku,
            discrepancyReason: input.discrepancyReason ?? null,
          },
        });
        await this.outbox.enqueue(tx, {
          type: "return.received",
          order: orderRef(order),
          returnId,
          returnNumber: request.number,
          sellable: sellableBySku,
          damaged: damagedBySku,
          discrepancyReason: input.discrepancyReason ?? null,
        });
        return this.reload(tx, orderId, auth);
      },
      200,
    );
  }
}
