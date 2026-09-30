-- Hand-written invariants for organization and user administration; the Prisma schema is unchanged.

-- Organization names are unique regardless of case.
CREATE UNIQUE INDEX "organizations_name_lower_key" ON "organizations"(lower("name"));
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_name_length" CHECK (length(btrim("name")) BETWEEN 1 AND 120);
ALTER TABLE "users" ADD CONSTRAINT "users_display_name_length" CHECK (length(btrim("display_name")) BETWEEN 1 AND 120);

CREATE FUNCTION enforce_organization_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.type IS DISTINCT FROM OLD.type) THEN
    RAISE EXCEPTION 'Organization identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.type = 'DISTRIBUTOR' AND NOT NEW.is_active THEN
    RAISE EXCEPTION 'The distributor organization cannot be deactivated' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER organizations_rules BEFORE INSERT OR UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION enforce_organization_rules();

CREATE FUNCTION enforce_user_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  organization_type "OrganizationType";
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.email IS DISTINCT FROM OLD.email OR NEW.organization_id IS DISTINCT FROM OLD.organization_id) THEN
    RAISE EXCEPTION 'User identity is immutable' USING ERRCODE = '23514';
  END IF;
  SELECT type INTO organization_type FROM organizations WHERE id = NEW.organization_id;
  IF (organization_type = 'RETAILER') <> (NEW.role = 'RETAILER') THEN
    RAISE EXCEPTION 'Role % does not match a % organization', NEW.role, organization_type USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_rules BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION enforce_user_rules();

-- Checked at commit, so a transaction may swap administrators but can never end without one.
CREATE FUNCTION ensure_active_administrator() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM users u JOIN organizations o ON o.id = u.organization_id
    WHERE u.role = 'ADMINISTRATOR' AND u.is_active AND o.type = 'DISTRIBUTOR' AND o.is_active
  ) THEN
    RAISE EXCEPTION 'At least one active administrator must remain' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER users_active_administrator AFTER UPDATE OR DELETE ON users
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ensure_active_administrator();
