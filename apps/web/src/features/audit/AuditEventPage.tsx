import { Link, useParams, useSearchParams } from "react-router";
import { ApiError } from "../../lib/api-client";
import catalogStyles from "../catalog/Catalog.module.css";
import { auditDate, useAuditEvent } from "./audit-api";
import auditStyles from "./Audit.module.css";

export function AuditEventPage() {
  const { eventId = "" } = useParams();
  const [params] = useSearchParams();
  const event = useAuditEvent(eventId);
  return <>
    <Link className={catalogStyles.back} to={`/audit?${params}`} data-test="audit-back">← Back to audit trail</Link>
    {event.isPending && <p role="status">Loading audit event…</p>}
    {event.isError && <p role="alert" className={catalogStyles.error} data-test="audit-detail-error">
      {event.error instanceof ApiError && event.error.status === 404 ? "This audit event is unavailable." : "Could not load this audit event."}{" "}
      <button className={catalogStyles.textButton} onClick={() => void event.refetch()} data-test="audit-detail-retry">Try again</button>
    </p>}
    {event.data && <>
      <div className={catalogStyles.heading}><div>
        <p className={catalogStyles.eyebrow}>COMMITTED CHANGE</p>
        <h1 data-test="audit-detail-heading">{event.data.entityType.replaceAll("_", " ")} · {event.data.action.replaceAll("_", " ")}</h1>
        <p className={catalogStyles.muted}>Recorded values are read-only. Actor and organization names reflect their current names.</p>
      </div></div>
      <dl className={auditStyles.metadata} data-test="audit-metadata">
        <dt>When</dt><dd><time dateTime={event.data.occurredAt}>{auditDate(event.data.occurredAt)}</time></dd>
        <dt>Event ID</dt><dd>{event.data.id}</dd>
        <dt>Entity ID</dt><dd>{event.data.entityId}</dd>
        <dt>Actor</dt><dd>{event.data.actor.displayName ?? "Unavailable name"} · {event.data.actor.id}</dd>
        <dt>Acting organization</dt><dd>{event.data.organization.name ?? "Unavailable name"} · {event.data.organization.id}</dd>
        <dt>Correlation ID</dt><dd data-test="audit-correlation-id">{event.data.correlationId}</dd>
      </dl>
      <div className={auditStyles.snapshots}>
        <section><h2>Before</h2><pre data-test="audit-before">{event.data.before === null ? "No previous value recorded." : JSON.stringify(event.data.before, null, 2)}</pre></section>
        <section><h2>After</h2><pre data-test="audit-after">{JSON.stringify(event.data.after, null, 2)}</pre></section>
      </div>
    </>}
  </>;
}
