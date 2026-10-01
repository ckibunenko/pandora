import { Injectable } from "@nestjs/common";
import { NOTIFICATION_MAX_ATTEMPTS, type NotificationEventType } from "@pandora/contracts";
import { Clock } from "../../common/clock/clock.js";
import { currentCorrelationId } from "../../common/request-context/request-context.js";
import type { Prisma } from "../../generated/prisma/client.js";

export interface OrderRef {
  readonly id: string;
  readonly number: string;
  readonly organizationId: string;
  readonly organizationName: string;
}

type Quantities = Readonly<Record<string, number>>;

/** Business events that notify someone; recipients, dedup key, and wording all follow from the event. */
export type NotificationEvent =
  | { type: "order.submitted"; order: OrderRef; lineCount: number; totalMinor: number }
  | { type: "order.confirmed"; order: OrderRef }
  | { type: "order.rejected"; order: OrderRef; reason: string }
  | { type: "shipment.recorded"; order: OrderRef; shipmentId: string; shipmentNumber: string; items: Quantities }
  | { type: "cancellation.requested"; order: OrderRef; requestId: string; items: Quantities; reason: string | null }
  | { type: "cancellation.decided"; order: OrderRef; requestId: string; approved: boolean; items: Quantities; reason: string | null }
  | { type: "return.requested"; order: OrderRef; returnId: string; returnNumber: string; items: Quantities; reason: string }
  | { type: "return.decided"; order: OrderRef; returnId: string; returnNumber: string; approved: boolean; reason: string | null }
  | { type: "return.received"; order: OrderRef; returnId: string; returnNumber: string; sellable: Quantities; damaged: Quantities; discrepancyReason: string | null };

const STAFF_EVENTS: readonly NotificationEventType[] = ["order.submitted", "cancellation.requested", "return.requested"];
const MAX_BODY = 3_800;

const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR" });
const list = (items: Quantities) =>
  Object.entries(items)
    .map(([sku, quantity]) => `- ${sku} × ${quantity}`)
    .join("\n");

/** Identity of the business event; with the recipient it is unique, so an event never notifies anyone twice. */
function eventKey(event: NotificationEvent): string {
  switch (event.type) {
    case "order.submitted":
    case "order.confirmed":
    case "order.rejected":
      return `${event.type}:${event.order.id}`;
    case "shipment.recorded":
      return `${event.type}:${event.shipmentId}`;
    case "cancellation.requested":
    case "cancellation.decided":
      return `${event.type}:${event.requestId}`;
    case "return.requested":
    case "return.decided":
    case "return.received":
      return `${event.type}:${event.returnId}`;
  }
}

function render(event: NotificationEvent): { subject: string; body: string } {
  const { number, organizationName } = event.order;
  switch (event.type) {
    case "order.submitted":
      return {
        subject: `${number} submitted by ${organizationName}`,
        body: `${organizationName} submitted order ${number}: ${event.lineCount} ${event.lineCount === 1 ? "line" : "lines"}, ${money.format(event.totalMinor / 100)}.\nIt is waiting for confirmation in the processing queue. No stock is reserved yet.`,
      };
    case "order.confirmed":
      return { subject: `${number} confirmed`, body: `Your order ${number} was confirmed. Stock is reserved for every line.` };
    case "order.rejected":
      return { subject: `${number} rejected`, body: `Your order ${number} was rejected.\nReason: ${event.reason}` };
    case "shipment.recorded":
      return {
        subject: `${event.shipmentNumber} shipped for ${number}`,
        body: `Shipment ${event.shipmentNumber} for order ${number} was dispatched:\n${list(event.items)}`,
      };
    case "cancellation.requested":
      return {
        subject: `Cancellation requested for ${number}`,
        body: `${organizationName} asked to cancel unshipped units of ${number}:\n${list(event.items)}${event.reason ? `\nReason: ${event.reason}` : ""}`,
      };
    case "cancellation.decided":
      return event.approved
        ? { subject: `Cancellation approved for ${number}`, body: `Your cancellation request for ${number} was approved. Cancelled:\n${list(event.items)}` }
        : { subject: `Cancellation rejected for ${number}`, body: `Your cancellation request for ${number} was rejected.\nReason: ${event.reason ?? ""}` };
    case "return.requested":
      return {
        subject: `Return ${event.returnNumber} requested for ${number}`,
        body: `${organizationName} asked to return units of ${number} (${event.returnNumber}):\n${list(event.items)}\nReason: ${event.reason}`,
      };
    case "return.decided":
      return event.approved
        ? { subject: `Return ${event.returnNumber} approved`, body: `Your return ${event.returnNumber} for ${number} was approved. Send the goods back; they are inspected on arrival.` }
        : { subject: `Return ${event.returnNumber} rejected`, body: `Your return ${event.returnNumber} for ${number} was rejected.\nReason: ${event.reason ?? ""}` };
    case "return.received":
      return {
        subject: `Return ${event.returnNumber} received`,
        body: `Return ${event.returnNumber} for ${number} was received and inspected.\nSellable:\n${list(event.sellable)}\nDamaged:\n${list(event.damaged)}${event.discrepancyReason ? `\nDiscrepancy: ${event.discrepancyReason}` : ""}`,
      };
  }
}

/**
 * Writes notification jobs into the outbox inside the caller's transaction (overview §7): they commit or roll back
 * with the business change, and the worker delivers them later. Never sends anything itself.
 */
@Injectable()
export class NotificationOutbox {
  constructor(private readonly clock: Clock) {}

  async enqueue(tx: Prisma.TransactionClient, event: NotificationEvent): Promise<number> {
    const correlationId = currentCorrelationId();
    if (!correlationId) {
      throw new Error("Notifications require request context.");
    }
    const recipients = await tx.user.findMany({
      where: STAFF_EVENTS.includes(event.type)
        ? { role: { in: ["OPERATOR", "ADMINISTRATOR"] }, isActive: true, organization: { type: "DISTRIBUTOR", isActive: true } }
        : { organizationId: event.order.organizationId, role: "RETAILER", isActive: true, organization: { isActive: true } },
      select: { id: true, email: true, displayName: true },
      orderBy: { id: "asc" },
    });
    if (recipients.length === 0) return 0;
    const { subject, body } = render(event);
    const now = this.clock.now();
    const text = (name: string) => {
      const full = `Hello ${name},\n\n${body}\n\n— Pandora Distribution`;
      return full.length > MAX_BODY ? `${full.slice(0, MAX_BODY - 1)}…` : full;
    };
    const created = await tx.notificationJob.createMany({
      data: recipients.map((recipient) => ({
        eventType: event.type,
        eventKey: eventKey(event),
        orderId: event.order.id,
        recipientUserId: recipient.id,
        recipientEmail: recipient.email,
        subject: subject.slice(0, 200),
        body: text(recipient.displayName),
        status: "PENDING",
        maxAttempts: NOTIFICATION_MAX_ATTEMPTS,
        nextAttemptAt: now,
        correlationId,
        createdAt: now,
      })),
      skipDuplicates: true,
    });
    return created.count;
  }
}
