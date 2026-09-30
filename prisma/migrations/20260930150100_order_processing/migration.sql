-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "reservation_id" UUID;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "confirmed_at" TIMESTAMPTZ(3),
ADD COLUMN     "confirmed_by_id" UUID,
ADD COLUMN     "rejected_at" TIMESTAMPTZ(3),
ADD COLUMN     "rejected_by_id" UUID,
ADD COLUMN     "rejection_reason" VARCHAR(500);

-- CreateTable
CREATE TABLE "stock_reservations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_line_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "quantity_reserved" INTEGER NOT NULL,
    "quantity_consumed" INTEGER NOT NULL DEFAULT 0,
    "quantity_released" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_reservations_order_line_id_key" ON "stock_reservations"("order_line_id");

-- CreateIndex
CREATE INDEX "stock_reservations_variant_id_idx" ON "stock_reservations"("variant_id");

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "stock_reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_rejected_by_id_fkey" FOREIGN KEY ("rejected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written invariants that the Prisma schema cannot express.

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
  OR ("status" = 'CONFIRMED' AND "submitted_at" IS NOT NULL AND "submitted_by_id" IS NOT NULL AND "total_minor" IS NOT NULL
    AND "confirmed_at" IS NOT NULL AND "confirmed_by_id" IS NOT NULL
    AND "cancelled_at" IS NULL AND "cancelled_by_id" IS NULL
    AND "rejected_at" IS NULL AND "rejected_by_id" IS NULL AND "rejection_reason" IS NULL)
  OR ("status" = 'REJECTED' AND "submitted_at" IS NOT NULL AND "submitted_by_id" IS NOT NULL AND "total_minor" IS NOT NULL
    AND "rejected_at" IS NOT NULL AND "rejected_by_id" IS NOT NULL
    AND "rejection_reason" IS NOT NULL AND length(btrim("rejection_reason")) >= 3
    AND "cancelled_at" IS NULL AND "cancelled_by_id" IS NULL
    AND "confirmed_at" IS NULL AND "confirmed_by_id" IS NULL)
  OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "cancelled_by_id" IS NOT NULL
    AND ("submitted_at" IS NULL) = ("total_minor" IS NULL)
    AND "confirmed_at" IS NULL AND "confirmed_by_id" IS NULL
    AND "rejected_at" IS NULL AND "rejected_by_id" IS NULL AND "rejection_reason" IS NULL)
);

-- Only the documented status transitions are possible; rejected and cancelled orders are terminal.
CREATE OR REPLACE FUNCTION enforce_order_rules() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF OLD.status IN ('CANCELLED', 'REJECTED') THEN
      RAISE EXCEPTION 'A % order cannot change', lower(OLD.status::text) USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
      (OLD.status = 'DRAFT' AND NEW.status IN ('SUBMITTED', 'CANCELLED'))
      OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('CONFIRMED', 'REJECTED', 'CANCELLED'))
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
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_quantities" CHECK (
  "quantity_reserved" > 0 AND "quantity_consumed" >= 0 AND "quantity_released" >= 0
  AND "quantity_consumed" + "quantity_released" <= "quantity_reserved"
);

-- A reservation covers its whole line, for the line's variant, and only while the order is submitted.
CREATE FUNCTION enforce_reservation_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.order_line_id IS DISTINCT FROM OLD.order_line_id OR NEW.variant_id IS DISTINCT FROM OLD.variant_id
    OR NEW.quantity_reserved IS DISTINCT FROM OLD.quantity_reserved) THEN
    RAISE EXCEPTION 'Reservation identity and reserved quantity are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT l.variant_id, l.quantity, o.status INTO line
      FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.id = NEW.order_line_id;
    IF line.variant_id IS DISTINCT FROM NEW.variant_id OR line.quantity IS DISTINCT FROM NEW.quantity_reserved THEN
      RAISE EXCEPTION 'A reservation must cover its order line exactly' USING ERRCODE = '23514';
    END IF;
    IF line.status <> 'SUBMITTED' THEN
      RAISE EXCEPTION 'Only submitted orders can be reserved' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stock_reservations_rules BEFORE INSERT OR UPDATE ON "stock_reservations"
  FOR EACH ROW EXECUTE FUNCTION enforce_reservation_rules();
CREATE TRIGGER stock_reservations_no_delete BEFORE DELETE ON "stock_reservations"
  FOR EACH ROW EXECUTE FUNCTION reject_inventory_movement_change();

-- Movement types now include reservations, which change only the reserved bucket.
ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_type_rules";
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_type_rules" CHECK (
  ("type" = 'OPENING_BALANCE' AND "delta" > 0 AND "bucket" IN ('SELLABLE', 'DAMAGED') AND "reservation_id" IS NULL)
  OR ("type" = 'RECEIPT' AND "delta" > 0 AND "bucket" = 'SELLABLE' AND "reservation_id" IS NULL)
  OR ("type" = 'ADJUSTMENT' AND "bucket" IN ('SELLABLE', 'DAMAGED') AND "reservation_id" IS NULL
    AND "reason" IS NOT NULL AND length(btrim("reason")) >= 3)
  OR ("type" = 'RESERVATION' AND "bucket" = 'RESERVED' AND "delta" > 0 AND "reservation_id" IS NOT NULL)
);
