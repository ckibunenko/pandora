-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('OPENING_BALANCE', 'RECEIPT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "StockBucket" AS ENUM ('SELLABLE', 'DAMAGED');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateTable
CREATE TABLE "inventory_items" (
    "variant_id" UUID NOT NULL,
    "sellable" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "damaged" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("variant_id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "variant_id" UUID NOT NULL,
    "type" "MovementType" NOT NULL,
    "bucket" "StockBucket" NOT NULL,
    "delta" INTEGER NOT NULL,
    "sellable_after" INTEGER NOT NULL,
    "reserved_after" INTEGER NOT NULL,
    "damaged_after" INTEGER NOT NULL,
    "reference" VARCHAR(80),
    "note" VARCHAR(500),
    "reason" VARCHAR(500),
    "actor_id" UUID,
    "organization_id" UUID,
    "correlation_id" VARCHAR(64),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "operation" VARCHAR(64) NOT NULL,
    "target" VARCHAR(64) NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status" "IdempotencyStatus" NOT NULL,
    "lease_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_movements_variant_id_occurred_at_id_idx" ON "inventory_movements"("variant_id", "occurred_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_organization_id_actor_id_operation_targ_key" ON "idempotency_records"("organization_id", "actor_id", "operation", "target", "idempotency_key");

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "inventory_items"("variant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written invariants that the Prisma schema cannot express.

-- Quantities stay within the stock invariants for every writer, not only the API.
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_quantities" CHECK (
  "sellable" >= 0 AND "reserved" >= 0 AND "damaged" >= 0 AND "reserved" <= "sellable"
);

ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_quantities" CHECK (
  "delta" <> 0 AND "sellable_after" >= 0 AND "reserved_after" >= 0 AND "damaged_after" >= 0
  AND "reserved_after" <= "sellable_after"
);
-- Opening balances and receipts only add sellable stock; adjustments need a non-blank reason.
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_type_rules" CHECK (
  ("type" IN ('OPENING_BALANCE', 'RECEIPT') AND "delta" > 0 AND ("type" = 'OPENING_BALANCE' OR "bucket" = 'SELLABLE'))
  OR ("type" = 'ADJUSTMENT' AND "reason" IS NOT NULL AND length(btrim("reason")) >= 3)
);
-- Only seed opening balances may lack an actor; every other movement is attributed.
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_attribution" CHECK (
  ("type" = 'OPENING_BALANCE' AND "actor_id" IS NULL AND "organization_id" IS NULL AND "correlation_id" IS NULL)
  OR ("type" <> 'OPENING_BALANCE' AND "actor_id" IS NOT NULL AND "organization_id" IS NOT NULL AND "correlation_id" IS NOT NULL)
);

CREATE FUNCTION reject_inventory_movement_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Inventory movements are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER inventory_movements_append_only BEFORE UPDATE OR DELETE ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION reject_inventory_movement_change();

-- Every variant has exactly one inventory item, whichever writer creates the variant.
INSERT INTO "inventory_items" ("variant_id") SELECT "id" FROM "product_variants";
CREATE FUNCTION create_inventory_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "inventory_items" ("variant_id") VALUES (NEW."id");
  RETURN NEW;
END;
$$;
CREATE TRIGGER product_variants_inventory_item AFTER INSERT ON "product_variants"
  FOR EACH ROW EXECUTE FUNCTION create_inventory_item();

ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_completion" CHECK (
  ("status" = 'IN_PROGRESS' AND "response_status" IS NULL AND "response_body" IS NULL AND "completed_at" IS NULL)
  OR ("status" = 'COMPLETED' AND "response_status" IS NOT NULL AND "response_body" IS NOT NULL AND "completed_at" IS NOT NULL)
);
