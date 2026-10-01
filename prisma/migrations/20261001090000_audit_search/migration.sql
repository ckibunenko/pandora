CREATE INDEX "audit_events_occurred_at_id_idx" ON "audit_events"("occurred_at", "id");
CREATE INDEX "audit_events_actor_id_occurred_at_idx" ON "audit_events"("actor_id", "occurred_at");
CREATE INDEX "audit_events_organization_id_occurred_at_idx" ON "audit_events"("organization_id", "occurred_at");
