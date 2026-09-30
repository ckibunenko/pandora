-- Order numbers below PO-001001 are reserved for deterministic seed orders.
CREATE SEQUENCE "orders_number_seq" START WITH 1001;

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "number" VARCHAR(20) NOT NULL DEFAULT ('PO-'::text || lpad((nextval('orders_number_seq'::regclass))::text, 6, '0'::text)),
    "organization_id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "currency" CHAR(3) NOT NULL,
    "total_minor" BIGINT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "submitted_by_id" UUID,
    "submitted_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancellation_reason" VARCHAR(500),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "sku" VARCHAR(40),
    "product_name" VARCHAR(120),
    "language" VARCHAR(2),
    "edition" VARCHAR(80),
    "unit_price_minor" INTEGER,
    "line_total_minor" BIGINT,

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_number_key" ON "orders"("number");

-- CreateIndex
CREATE INDEX "orders_organization_id_created_at_id_idx" ON "orders"("organization_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "orders_status_created_at_id_idx" ON "orders"("status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "order_lines_order_id_variant_id_key" ON "order_lines"("order_id", "variant_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written invariants that the Prisma schema cannot express.

ALTER SEQUENCE "orders_number_seq" OWNED BY "orders"."number";

ALTER TABLE "orders" ADD CONSTRAINT "orders_number_format" CHECK ("number" ~ '^PO-[0-9]{6}$');
ALTER TABLE "orders" ADD CONSTRAINT "orders_version_positive" CHECK ("version" >= 1);
ALTER TABLE "orders" ADD CONSTRAINT "orders_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_nonnegative" CHECK ("total_minor" IS NULL OR "total_minor" >= 0);
-- Each status carries exactly the lifecycle data it implies.
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_data" CHECK (
  ("status" = 'DRAFT' AND "submitted_at" IS NULL AND "submitted_by_id" IS NULL AND "total_minor" IS NULL
    AND "cancelled_at" IS NULL AND "cancelled_by_id" IS NULL AND "cancellation_reason" IS NULL)
  OR ("status" = 'SUBMITTED' AND "submitted_at" IS NOT NULL AND "submitted_by_id" IS NOT NULL AND "total_minor" IS NOT NULL
    AND "cancelled_at" IS NULL AND "cancelled_by_id" IS NULL)
  OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "cancelled_by_id" IS NOT NULL
    AND ("submitted_at" IS NULL) = ("total_minor" IS NULL))
);

ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_quantity_range" CHECK ("quantity" BETWEEN 1 AND 10000);
-- Snapshot columns are all null (draft) or all frozen, and the frozen line total is exact.
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_snapshot_complete" CHECK (
  ("sku" IS NULL AND "product_name" IS NULL AND "language" IS NULL AND "edition" IS NULL
    AND "unit_price_minor" IS NULL AND "line_total_minor" IS NULL)
  OR ("sku" IS NOT NULL AND "product_name" IS NOT NULL AND "language" IS NOT NULL AND "edition" IS NOT NULL
    AND "unit_price_minor" >= 0 AND "line_total_minor" = "unit_price_minor"::bigint * "quantity")
);

CREATE FUNCTION enforce_order_rules() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF OLD.status = 'CANCELLED' THEN
      RAISE EXCEPTION 'A cancelled order cannot change' USING ERRCODE = '23514';
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
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_rules BEFORE INSERT OR UPDATE ON "orders"
  FOR EACH ROW EXECUTE FUNCTION enforce_order_rules();

-- Lines change only while their order is a draft; submitted snapshots are therefore immutable.
CREATE FUNCTION enforce_order_line_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_order UUID := COALESCE(NEW.order_id, OLD.order_id);
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.variant_id IS DISTINCT FROM OLD.variant_id) THEN
    RAISE EXCEPTION 'Order line identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF (SELECT status FROM orders WHERE id = target_order) <> 'DRAFT' THEN
    RAISE EXCEPTION 'Only draft order lines can change' USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER order_lines_rules BEFORE INSERT OR UPDATE OR DELETE ON "order_lines"
  FOR EACH ROW EXECUTE FUNCTION enforce_order_line_rules();
