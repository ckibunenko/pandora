-- Return numbers start above the range reserved for seed returns.
CREATE SEQUENCE "returns_number_seq" START WITH 1001;

-- CreateEnum
CREATE TYPE "ReturnRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED');

-- CreateTable
CREATE TABLE "return_requests" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "number" VARCHAR(20) NOT NULL DEFAULT ('RT-'::text || lpad((nextval('returns_number_seq'::regclass))::text, 6, '0'::text)),
    "order_id" UUID NOT NULL,
    "status" "ReturnRequestStatus" NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_reason" VARCHAR(500),
    "received_by_id" UUID,
    "received_at" TIMESTAMPTZ(3),
    "discrepancy_reason" VARCHAR(500),

    CONSTRAINT "return_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_request_items" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "request_id" UUID NOT NULL,
    "shipment_item_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "received_sellable" INTEGER,
    "received_damaged" INTEGER,

    CONSTRAINT "return_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "return_requests_number_key" ON "return_requests"("number");

-- CreateIndex
CREATE INDEX "return_requests_order_id_requested_at_idx" ON "return_requests"("order_id", "requested_at");

-- CreateIndex
CREATE INDEX "return_requests_status_idx" ON "return_requests"("status");

-- CreateIndex
CREATE INDEX "return_request_items_shipment_item_id_idx" ON "return_request_items"("shipment_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "return_request_items_request_id_shipment_item_id_key" ON "return_request_items"("request_id", "shipment_item_id");

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_received_by_id_fkey" FOREIGN KEY ("received_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_request_items" ADD CONSTRAINT "return_request_items_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "return_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_request_items" ADD CONSTRAINT "return_request_items_shipment_item_id_fkey" FOREIGN KEY ("shipment_item_id") REFERENCES "shipment_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER SEQUENCE "returns_number_seq" OWNED BY "return_requests"."number";

-- Hand-written invariants that the Prisma schema cannot express.

ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_reason" CHECK (length(btrim("reason")) >= 3);

-- Each status carries exactly the decision and receipt data it implies.
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_status_data" CHECK (
  ("status" = 'PENDING' AND "decided_at" IS NULL AND "decided_by_id" IS NULL AND "decision_reason" IS NULL
    AND "received_at" IS NULL AND "received_by_id" IS NULL AND "discrepancy_reason" IS NULL)
  OR ("status" = 'APPROVED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL AND "decision_reason" IS NULL
    AND "received_at" IS NULL AND "received_by_id" IS NULL AND "discrepancy_reason" IS NULL)
  OR ("status" = 'REJECTED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
    AND "decision_reason" IS NOT NULL AND length(btrim("decision_reason")) >= 3
    AND "received_at" IS NULL AND "received_by_id" IS NULL AND "discrepancy_reason" IS NULL)
  OR ("status" = 'COMPLETED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL AND "decision_reason" IS NULL
    AND "received_at" IS NOT NULL AND "received_by_id" IS NOT NULL
    AND ("discrepancy_reason" IS NULL OR length(btrim("discrepancy_reason")) >= 3))
);

-- Received units are recorded together, once, and never exceed the approved quantity.
ALTER TABLE "return_request_items" ADD CONSTRAINT "return_request_items_quantities" CHECK (
  "quantity" > 0
  AND ("received_sellable" IS NULL) = ("received_damaged" IS NULL)
  AND ("received_sellable" IS NULL
    OR ("received_sellable" >= 0 AND "received_damaged" >= 0 AND "received_sellable" + "received_damaged" <= "quantity"))
);

-- Items are written with their pending request and reference a shipment of the same order.
CREATE FUNCTION enforce_return_item_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM return_requests r
    JOIN shipments s ON s.order_id = r.order_id
    JOIN shipment_items si ON si.shipment_id = s.id
    WHERE r.id = NEW.request_id AND r.status = 'PENDING' AND si.id = NEW.shipment_item_id
  ) THEN
    RAISE EXCEPTION 'Return items reference a shipment of the same order and are added only to a pending request'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER return_request_items_insert BEFORE INSERT ON "return_request_items"
  FOR EACH ROW EXECUTE FUNCTION enforce_return_item_insert();

-- Items are never deleted; only the receipt fills in received quantities, once, while the request is approved.
CREATE FUNCTION enforce_return_item_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Return items are never deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.shipment_item_id IS DISTINCT FROM OLD.shipment_item_id OR NEW.quantity IS DISTINCT FROM OLD.quantity
    OR OLD.received_sellable IS NOT NULL OR NEW.received_sellable IS NULL
    OR NOT EXISTS (SELECT 1 FROM return_requests WHERE id = NEW.request_id AND status = 'APPROVED') THEN
    RAISE EXCEPTION 'Only an approved return records its received quantities, once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER return_request_items_change BEFORE UPDATE OR DELETE ON "return_request_items"
  FOR EACH ROW EXECUTE FUNCTION enforce_return_item_change();

-- Requests move pending → approved | rejected and approved → completed; completion needs a full inspection.
CREATE FUNCTION enforce_return_request_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Return requests are never deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.number IS DISTINCT FROM OLD.number OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.requested_by_id IS DISTINCT FROM OLD.requested_by_id
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'Return request identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD.status = 'PENDING' AND NEW.status IN ('APPROVED', 'REJECTED'))
    OR (OLD.status = 'APPROVED' AND NEW.status = 'COMPLETED'
      AND NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at AND NEW.decided_by_id IS NOT DISTINCT FROM OLD.decided_by_id)
  ) THEN
    RAISE EXCEPTION 'Unsupported return transition % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'COMPLETED' THEN
    IF EXISTS (SELECT 1 FROM return_request_items WHERE request_id = NEW.id AND received_sellable IS NULL) THEN
      RAISE EXCEPTION 'Every return item must be inspected before completion' USING ERRCODE = '23514';
    END IF;
    IF NEW.discrepancy_reason IS NULL AND EXISTS (
      SELECT 1 FROM return_request_items WHERE request_id = NEW.id AND received_sellable + received_damaged < quantity
    ) THEN
      RAISE EXCEPTION 'A short return receipt needs a discrepancy reason' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER return_requests_rules BEFORE UPDATE OR DELETE ON "return_requests"
  FOR EACH ROW EXECUTE FUNCTION enforce_return_request_rules();

-- Per shipment item: pending and approved quantities plus received units of completed returns never exceed
-- the shipped quantity (overview §6). Only new items can raise a claim; receipts never exceed approved quantities.
CREATE FUNCTION enforce_return_entitlement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  shipped INTEGER;
  claimed BIGINT;
BEGIN
  SELECT quantity INTO shipped FROM shipment_items WHERE id = NEW.shipment_item_id;
  SELECT COALESCE(sum(CASE WHEN r.status = 'COMPLETED' THEN i.received_sellable + i.received_damaged ELSE i.quantity END), 0)
    INTO claimed
    FROM return_request_items i JOIN return_requests r ON r.id = i.request_id
    WHERE i.shipment_item_id = NEW.shipment_item_id AND r.status <> 'REJECTED';
  IF claimed > shipped THEN
    RAISE EXCEPTION 'Returned quantities exceed the shipped quantity' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER return_request_items_entitlement AFTER INSERT ON "return_request_items"
  FOR EACH ROW EXECUTE FUNCTION enforce_return_entitlement();

-- Inspected returns add sellable or damaged stock; they never touch reservations.
ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_type_rules";
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_type_rules" CHECK (
  ("type" = 'OPENING_BALANCE' AND "delta" > 0 AND "bucket" IN ('SELLABLE', 'DAMAGED') AND "reservation_id" IS NULL)
  OR ("type" = 'RECEIPT' AND "delta" > 0 AND "bucket" = 'SELLABLE' AND "reservation_id" IS NULL)
  OR ("type" = 'ADJUSTMENT' AND "bucket" IN ('SELLABLE', 'DAMAGED') AND "reservation_id" IS NULL
    AND "reason" IS NOT NULL AND length(btrim("reason")) >= 3)
  OR ("type" = 'RESERVATION' AND "bucket" = 'RESERVED' AND "delta" > 0 AND "reservation_id" IS NOT NULL)
  OR ("type" = 'SHIPMENT' AND "bucket" IN ('SELLABLE', 'RESERVED') AND "delta" < 0 AND "reservation_id" IS NOT NULL)
  OR ("type" = 'RELEASE' AND "bucket" = 'RESERVED' AND "delta" < 0 AND "reservation_id" IS NOT NULL)
  OR ("type" = 'RETURN' AND "bucket" IN ('SELLABLE', 'DAMAGED') AND "delta" > 0 AND "reservation_id" IS NULL)
);
