-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('BASE_GAME', 'EXPANSION');

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" VARCHAR(120) NOT NULL,
    "publisher" VARCHAR(120) NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "type" "ProductType" NOT NULL,
    "base_product_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "product_id" UUID NOT NULL,
    "sku" VARCHAR(40) NOT NULL,
    "language" VARCHAR(2) NOT NULL,
    "edition" VARCHAR(80) NOT NULL,
    "unit_price_minor" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "actor_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "correlation_id" VARCHAR(64) NOT NULL,
    "before" JSONB,
    "after" JSONB NOT NULL,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "products_name_id_idx" ON "products"("name", "id");

-- CreateIndex
CREATE INDEX "products_base_product_id_idx" ON "products"("base_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_sku_key" ON "product_variants"("sku");

-- CreateIndex
CREATE INDEX "product_variants_product_id_sku_idx" ON "product_variants"("product_id", "sku");

-- CreateIndex
CREATE INDEX "audit_events_entity_type_entity_id_occurred_at_idx" ON "audit_events"("entity_type", "entity_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_base_product_id_fkey" FOREIGN KEY ("base_product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Invariants must also hold for writes outside the HTTP API.
ALTER TABLE products ADD CONSTRAINT products_text_nonempty CHECK (
  length(btrim(name)) > 0 AND length(btrim(publisher)) > 0 AND length(btrim(description)) > 0
);
ALTER TABLE products ADD CONSTRAINT products_base_reference CHECK (
  (type = 'BASE_GAME' AND base_product_id IS NULL) OR
  (type = 'EXPANSION' AND base_product_id IS NOT NULL AND base_product_id <> id)
);
ALTER TABLE product_variants ADD CONSTRAINT variants_price_nonnegative CHECK (unit_price_minor >= 0);
ALTER TABLE product_variants ADD CONSTRAINT variants_sku_format CHECK (sku ~ '^[A-Z0-9][A-Z0-9-]{1,38}[A-Z0-9]$');
ALTER TABLE product_variants ADD CONSTRAINT variants_language CHECK (language IN ('en', 'sr'));
ALTER TABLE product_variants ADD CONSTRAINT variants_edition_nonempty CHECK (length(btrim(edition)) > 0);

CREATE FUNCTION enforce_product_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.type IS DISTINCT FROM OLD.type OR NEW.base_product_id IS DISTINCT FROM OLD.base_product_id) THEN
    RAISE EXCEPTION 'Product identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.type = 'EXPANSION' AND NOT EXISTS (SELECT 1 FROM products WHERE id = NEW.base_product_id AND type = 'BASE_GAME') THEN
    RAISE EXCEPTION 'Expansion must reference a base game' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER products_identity BEFORE INSERT OR UPDATE ON products FOR EACH ROW EXECUTE FUNCTION enforce_product_identity();

CREATE FUNCTION enforce_variant_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.sku IS DISTINCT FROM OLD.sku OR NEW.product_id IS DISTINCT FROM OLD.product_id THEN
    RAISE EXCEPTION 'Variant identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER variants_identity BEFORE UPDATE ON product_variants FOR EACH ROW EXECUTE FUNCTION enforce_variant_identity();
