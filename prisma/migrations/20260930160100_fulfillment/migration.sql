-- Shipment numbers below SH-001001 are reserved for deterministic seed shipments.
CREATE SEQUENCE "shipments_number_seq" START WITH 1001;

-- CreateEnum
CREATE TYPE "CancellationRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.



-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.



-- AlterTable
ALTER TABLE "order_lines" ADD COLUMN     "cancelled_quantity" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "shipped_quantity" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "number" VARCHAR(20) NOT NULL DEFAULT ('SH-'::text || lpad((nextval('shipments_number_seq'::regclass))::text, 6, '0'::text)),
    "order_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_items" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "shipment_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "shipment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancellation_requests" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_id" UUID NOT NULL,
    "status" "CancellationRequestStatus" NOT NULL,
    "reason" VARCHAR(500),
    "requested_by_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_reason" VARCHAR(500),

    CONSTRAINT "cancellation_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancellation_request_items" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "request_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "cancellation_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipments_number_key" ON "shipments"("number");

-- CreateIndex
CREATE INDEX "shipments_order_id_created_at_idx" ON "shipments"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_items_shipment_id_order_line_id_key" ON "shipment_items"("shipment_id", "order_line_id");

-- CreateIndex
CREATE INDEX "cancellation_requests_order_id_requested_at_idx" ON "cancellation_requests"("order_id", "requested_at");

-- CreateIndex
CREATE UNIQUE INDEX "cancellation_request_items_request_id_order_line_id_key" ON "cancellation_request_items"("request_id", "order_line_id");

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellation_requests" ADD CONSTRAINT "cancellation_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellation_requests" ADD CONSTRAINT "cancellation_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellation_requests" ADD CONSTRAINT "cancellation_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellation_request_items" ADD CONSTRAINT "cancellation_request_items_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "cancellation_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellation_request_items" ADD CONSTRAINT "cancellation_request_items_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written invariants that the Prisma schema cannot express.

ALTER SEQUENCE "shipments_number_seq" OWNED BY "shipments"."number";
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_number_format" CHECK ("number" ~ '^SH-[0-9]{6}$');
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "cancellation_request_items" ADD CONSTRAINT "cancellation_request_items_quantity_positive" CHECK ("quantity" > 0);

-- Shipped plus cancelled never exceeds the ordered quantity.
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_fulfillment_quantities" CHECK (
  "shipped_quantity" >= 0 AND "cancelled_quantity" >= 0 AND "shipped_quantity" + "cancelled_quantity" <= "quantity"
);

ALTER TABLE "cancellation_requests" ADD CONSTRAINT "cancellation_requests_decision_data" CHECK (
  ("status" = 'PENDING' AND "decided_at" IS NULL AND "decided_by_id" IS NULL AND "decision_reason" IS NULL)
  OR ("status" = 'APPROVED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL AND "decision_reason" IS NULL)
  OR ("status" = 'REJECTED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
    AND "decision_reason" IS NOT NULL AND length(btrim("decision_reason")) >= 3)
);
CREATE UNIQUE INDEX "cancellation_requests_one_pending" ON "cancellation_requests"("order_id") WHERE "status" = 'PENDING';

-- Each status carries exactly the lifecycle data it implies.
ALTER TABLE "orders" DROP CONSTRAINT "orders_status_data";
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_data" CHECK (
  ("status" = 'DRAFT' AND "submitted_at" IS NULL AND "submitted_by_id" IS NULL AND "total_minor" IS NULL
    AND "cancelled_at" IS NULL AND "cancelled_by_id" IS NULL AND "cancellation_reason" IS NULL
    AND "confirmed_at" IS NULL AND "confirmed_by_id" IS NULL
    AND "rejected_at" IS NULL AND "rejected_by_id" IS NULL AND "rejection_reason" IS NULL)
  OR ("status" = 'SUBMITTED' AND "submitted_at" IS NOT NULL AND "submitted_by_id" IS NOT NULL AND "total_minor" IS NOT NULL
    AND "cancelled_at" IS NULL AND "cancelled_by_id" IS NULL
    AND "confirmed_at" IS NULL AND "confirmed_by_id" IS NULL
    AND "rejected_at" IS NULL AND "rejected_by_id" IS NULL AND "rejection_reason" IS NULL)
  OR ("status" IN ('CONFIRMED', 'PARTIALLY_SHIPPED', 'SHIPPED', 'CLOSED_PARTIAL')
    AND "submitted_at" IS NOT NULL AND "submitted_by_id" IS NOT NULL AND "total_minor" IS NOT NULL
    AND "confirmed_at" IS NOT NULL AND "confirmed_by_id" IS NOT NULL
    AND "cancelled_at" IS NULL AND "cancelled_by_id" IS NULL
    AND "rejected_at" IS NULL AND "rejected_by_id" IS NULL AND "rejection_reason" IS NULL)
  OR ("status" = 'REJECTED' AND "submitted_at" IS NOT NULL AND "submitted_by_id" IS NOT NULL AND "total_minor" IS NOT NULL
    AND "rejected_at" IS NOT NULL AND "rejected_by_id" IS NOT NULL
    AND "rejection_reason" IS NOT NULL AND length(btrim("rejection_reason")) >= 3
    AND "cancelled_at" IS NULL AND "cancelled_by_id" IS NULL
    AND "confirmed_at" IS NULL AND "confirmed_by_id" IS NULL)
  -- Cancelled before submission, after submission, or (via an approved request) after confirmation.
  OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "cancelled_by_id" IS NOT NULL
    AND ("submitted_at" IS NULL) = ("total_minor" IS NULL)
    AND ("confirmed_at" IS NULL OR "submitted_at" IS NOT NULL)
    AND "rejected_at" IS NULL AND "rejected_by_id" IS NULL AND "rejection_reason" IS NULL)
);

-- Documented transitions only; after confirmation the status must match the line quantities (overview §5).
CREATE OR REPLACE FUNCTION enforce_order_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  totals RECORD;
  derived "OrderStatus";
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = NEW.organization_id AND type = 'RETAILER') THEN
    RAISE EXCEPTION 'Orders belong to retailer organizations' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.number IS DISTINCT FROM OLD.number
      OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id
      OR NEW.currency IS DISTINCT FROM OLD.currency THEN
      RAISE EXCEPTION 'Order identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.total_minor IS NOT NULL AND NEW.total_minor IS DISTINCT FROM OLD.total_minor THEN
      RAISE EXCEPTION 'A submitted order total is frozen' USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('CANCELLED', 'REJECTED', 'SHIPPED', 'CLOSED_PARTIAL') THEN
      RAISE EXCEPTION 'A % order cannot change', lower(OLD.status::text) USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
      (OLD.status = 'DRAFT' AND NEW.status IN ('SUBMITTED', 'CANCELLED'))
      OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('CONFIRMED', 'REJECTED', 'CANCELLED'))
      OR (OLD.status = 'CONFIRMED' AND NEW.status IN ('PARTIALLY_SHIPPED', 'SHIPPED', 'CANCELLED', 'CLOSED_PARTIAL'))
      OR (OLD.status = 'PARTIALLY_SHIPPED' AND NEW.status IN ('SHIPPED', 'CLOSED_PARTIAL'))
    ) THEN
      RAISE EXCEPTION 'Unsupported order transition % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'SUBMITTED' AND OLD.status = 'DRAFT' THEN
      IF NOT EXISTS (SELECT 1 FROM order_lines WHERE order_id = NEW.id) THEN
        RAISE EXCEPTION 'An order needs at least one line to be submitted' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (SELECT 1 FROM order_lines WHERE order_id = NEW.id AND sku IS NULL) THEN
        RAISE EXCEPTION 'Every line needs a frozen snapshot before submission' USING ERRCODE = '23514';
      END IF;
      IF NEW.total_minor <> (SELECT sum(line_total_minor) FROM order_lines WHERE order_id = NEW.id) THEN
        RAISE EXCEPTION 'The order total must equal its line totals' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.status = 'CONFIRMED' AND OLD.status = 'SUBMITTED' THEN
      IF EXISTS (
        SELECT 1 FROM order_lines l LEFT JOIN stock_reservations r ON r.order_line_id = l.id
        WHERE l.order_id = NEW.id AND r.id IS NULL
      ) THEN
        RAISE EXCEPTION 'Every line must be reserved before confirmation' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.confirmed_at IS NOT NULL AND NEW.status IN ('CONFIRMED', 'PARTIALLY_SHIPPED', 'SHIPPED', 'CANCELLED', 'CLOSED_PARTIAL') THEN
      SELECT sum(quantity) AS ordered, sum(shipped_quantity) AS shipped, sum(cancelled_quantity) AS cancelled
        INTO totals FROM order_lines WHERE order_id = NEW.id;
      derived := CASE
        WHEN totals.ordered - totals.shipped - totals.cancelled > 0 AND totals.shipped = 0 THEN 'CONFIRMED'
        WHEN totals.ordered - totals.shipped - totals.cancelled > 0 THEN 'PARTIALLY_SHIPPED'
        WHEN totals.cancelled = 0 THEN 'SHIPPED'
        WHEN totals.shipped = 0 THEN 'CANCELLED'
        ELSE 'CLOSED_PARTIAL'
      END;
      IF NEW.status <> derived THEN
        RAISE EXCEPTION 'Order status % does not match its quantities (expected %)', NEW.status, derived USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Lines change freely only in drafts; afterwards only shipped/cancelled totals grow, while fulfillment is open.
CREATE OR REPLACE FUNCTION enforce_order_line_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_order UUID := COALESCE(NEW.order_id, OLD.order_id);
  order_status "OrderStatus";
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.variant_id IS DISTINCT FROM OLD.variant_id) THEN
    RAISE EXCEPTION 'Order line identity is immutable' USING ERRCODE = '23514';
  END IF;
  SELECT status INTO order_status FROM orders WHERE id = target_order;
  IF order_status = 'DRAFT' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND order_status IN ('CONFIRMED', 'PARTIALLY_SHIPPED')
    AND NEW.quantity = OLD.quantity AND NEW.sku IS NOT DISTINCT FROM OLD.sku
    AND NEW.product_name IS NOT DISTINCT FROM OLD.product_name AND NEW.language IS NOT DISTINCT FROM OLD.language
    AND NEW.edition IS NOT DISTINCT FROM OLD.edition AND NEW.unit_price_minor IS NOT DISTINCT FROM OLD.unit_price_minor
    AND NEW.line_total_minor IS NOT DISTINCT FROM OLD.line_total_minor
    AND NEW.shipped_quantity >= OLD.shipped_quantity AND NEW.cancelled_quantity >= OLD.cancelled_quantity THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Only draft order lines can change, and fulfilled quantities only grow' USING ERRCODE = '23514';
END;
$$;

-- Generic guard for append-only records.
CREATE FUNCTION reject_append_only_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER shipments_append_only BEFORE UPDATE OR DELETE ON "shipments"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER shipment_items_append_only BEFORE UPDATE OR DELETE ON "shipment_items"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER cancellation_request_items_append_only BEFORE UPDATE OR DELETE ON "cancellation_request_items"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
-- Replaces the earlier reservation delete guard, which reported an inventory-movement message.
DROP TRIGGER "stock_reservations_no_delete" ON "stock_reservations";
CREATE TRIGGER stock_reservations_no_delete BEFORE DELETE ON "stock_reservations"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- Items must belong to lines of the same order as their shipment or request.
CREATE FUNCTION enforce_fulfillment_item_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_order UUID;
BEGIN
  IF TG_TABLE_NAME = 'shipment_items' THEN
    SELECT order_id INTO parent_order FROM shipments WHERE id = NEW.shipment_id;
  ELSE
    SELECT order_id INTO parent_order FROM cancellation_requests WHERE id = NEW.request_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM order_lines WHERE id = NEW.order_line_id AND order_id = parent_order) THEN
    RAISE EXCEPTION 'Item line belongs to another order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shipment_items_same_order BEFORE INSERT ON "shipment_items"
  FOR EACH ROW EXECUTE FUNCTION enforce_fulfillment_item_order();
CREATE TRIGGER cancellation_request_items_same_order BEFORE INSERT ON "cancellation_request_items"
  FOR EACH ROW EXECUTE FUNCTION enforce_fulfillment_item_order();

-- Requests are decided once; nothing else about them changes, and they are never deleted.
CREATE FUNCTION enforce_cancellation_request_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cancellation requests are never deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'PENDING' OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.requested_by_id IS DISTINCT FROM OLD.requested_by_id OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'Only a pending cancellation request can be decided, once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cancellation_requests_rules BEFORE UPDATE OR DELETE ON "cancellation_requests"
  FOR EACH ROW EXECUTE FUNCTION enforce_cancellation_request_rules();

-- Shipments consume sellable and reserved stock equally; releases return reserved stock to availability.
ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_type_rules";
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_type_rules" CHECK (
  ("type" = 'OPENING_BALANCE' AND "delta" > 0 AND "bucket" IN ('SELLABLE', 'DAMAGED') AND "reservation_id" IS NULL)
  OR ("type" = 'RECEIPT' AND "delta" > 0 AND "bucket" = 'SELLABLE' AND "reservation_id" IS NULL)
  OR ("type" = 'ADJUSTMENT' AND "bucket" IN ('SELLABLE', 'DAMAGED') AND "reservation_id" IS NULL
    AND "reason" IS NOT NULL AND length(btrim("reason")) >= 3)
  OR ("type" = 'RESERVATION' AND "bucket" = 'RESERVED' AND "delta" > 0 AND "reservation_id" IS NOT NULL)
  OR ("type" = 'SHIPMENT' AND "bucket" IN ('SELLABLE', 'RESERVED') AND "delta" < 0 AND "reservation_id" IS NOT NULL)
  OR ("type" = 'RELEASE' AND "bucket" = 'RESERVED' AND "delta" < 0 AND "reservation_id" IS NOT NULL)
);
