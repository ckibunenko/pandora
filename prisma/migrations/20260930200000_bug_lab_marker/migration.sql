-- Bug Lab (overview §9): the Standard status check stays in force everywhere, except for the single wrong state
-- that BUG-001 produces, and only in a database the Bug Lab setup tool marked with ALTER DATABASE ... SET pandora.defect.
-- Unmarked databases (development, QA, demo) behave exactly as before.
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
      IF NEW.status <> derived AND NOT (
        NEW.status = 'PARTIALLY_SHIPPED' AND derived = 'SHIPPED'
        AND current_setting('pandora.defect', true) = 'BUG-001'
      ) THEN
        RAISE EXCEPTION 'Order status % does not match its quantities (expected %)', NEW.status, derived USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
