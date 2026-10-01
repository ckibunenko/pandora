import { auditEntityTypeSchema, auditQuerySchema } from "@pandora/contracts";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { ListPagination } from "../../components/ListPagination";
import { useSession } from "../auth/session";
import catalogStyles from "../catalog/Catalog.module.css";
import { auditDate, useAuditEvents } from "./audit-api";
import auditStyles from "./Audit.module.css";

const FILTERS = [
  { key: "entityId", label: "Entity ID", placeholder: "Exact UUID", max: 36 },
  { key: "action", label: "Action", placeholder: "e.g. confirmed", max: 80 },
  { key: "actorId", label: "Actor ID", placeholder: "Exact UUID", max: 36 },
  { key: "organizationId", label: "Acting organization ID", placeholder: "Exact UUID", max: 36 },
  { key: "correlationId", label: "Correlation ID", placeholder: "Exact correlation ID", max: 64 },
  { key: "from", label: "From (UTC, inclusive)", placeholder: "2026-10-01T00:00:00Z", max: 30 },
  { key: "to", label: "To (UTC, inclusive)", placeholder: "2026-10-01T23:59:59.999Z", max: 30 },
] as const;

export function AuditPage() {
  const [params, setParams] = useSearchParams();
  const events = useAuditEvents(params.toString());
  const session = useSession();
  const isAdmin = session.data?.user.role === "administrator";
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    if (params.has("pageSize")) next.set("pageSize", params.get("pageSize") ?? "20");
    for (const [key, value] of form) if (typeof value === "string" && value.trim()) next.set(key, value.trim());
    const parsed = auditQuerySchema.safeParse(Object.fromEntries(next));
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message])));
      return;
    }
    setErrors({});
    setParams(next);
  }
  function clear() { setErrors({}); setParams({}); }
  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(key, value);
    if (key !== "page") next.delete("page");
    setErrors({});
    setParams(next);
  }

  return (
    <>
      <div className={catalogStyles.heading}>
        <div>
          <p className={catalogStyles.eyebrow}>{isAdmin ? "ALL BUSINESS CHANGES" : "ORDERS & INVENTORY"}</p>
          <h1>Audit trail</h1>
          <p className={catalogStyles.muted}>
            {isAdmin ? "Inspect committed changes across Pandora." : "Inspect committed changes to orders and warehouse stock."}
            {" "}Filters match exact values. Acting organization identifies who made the change.
          </p>
        </div>
      </div>
      <form key={params.toString()} onSubmit={submit} className={auditStyles.filters} data-test="audit-filters" noValidate>
        <label className={catalogStyles.field}>
          Entity type
          <select name="entityType" defaultValue={params.get("entityType") ?? ""} data-test="audit-entity-type">
            <option value="">All {isAdmin ? "types" : "operational types"}</option>
            {auditEntityTypeSchema.options.filter((type) => isAdmin || type === "order" || type === "inventory_item").map((type) => (
              <option key={type} value={type}>{type.replaceAll("_", " ")}</option>
            ))}
          </select>
        </label>
        {FILTERS.map((field) => (
          <label key={field.key} className={catalogStyles.field}>
            {field.label}
            <input name={field.key} defaultValue={params.get(field.key) ?? ""} placeholder={field.placeholder}
              maxLength={field.max} data-test={`audit-${field.key}`} aria-invalid={!!errors[field.key]}
              aria-describedby={errors[field.key] ? `audit-error-${field.key}` : undefined} />
            {errors[field.key] && <span className={catalogStyles.fieldError} id={`audit-error-${field.key}`}>{errors[field.key]}</span>}
          </label>
        ))}
        <div className={auditStyles.actions}>
          <button className={catalogStyles.primary} data-test="audit-search">Apply filters</button>
          <button type="button" className={catalogStyles.secondary} onClick={clear} data-test="audit-clear-filters">Clear filters</button>
        </div>
      </form>
      {events.isPending && <p role="status">Loading audit events…</p>}
      {events.isError && <div role="alert" className={catalogStyles.error} data-test="audit-error">
        Could not load audit events. Check the filters or try again.{" "}
        <button className={catalogStyles.textButton} onClick={() => void events.refetch()} data-test="audit-retry">Try again</button>
      </div>}
      {events.data && <>
        <p className={catalogStyles.results} role="status" data-test="audit-total">{events.data.total} {events.data.total === 1 ? "event" : "events"}</p>
        {!events.data.items.length ? <div className={catalogStyles.empty} data-test="audit-empty">
          <h2>No audit events found</h2><p>Try different filters or return to an earlier page.</p>
        </div> : <div className={catalogStyles.tableScroll} role="region" aria-label="Audit events" tabIndex={0}>
          <table className={`${catalogStyles.table} ${auditStyles.eventsTable}`}>
            <caption className={catalogStyles.srOnly}>Audit events, newest first. Times shown in Europe/Belgrade.</caption>
            <thead><tr><th>When</th><th>Change</th><th>Actor / organization</th><th>Correlation ID</th></tr></thead>
            <tbody>{events.data.items.map((entry) => <tr key={entry.id} data-test="audit-row" data-event-id={entry.id} data-entity-type={entry.entityType}>
              <td><time dateTime={entry.occurredAt}>{auditDate(entry.occurredAt)}</time></td>
              <td><Link to={`/audit/${entry.id}?${params}`} data-test="audit-link">{entry.entityType.replaceAll("_", " ")} · {entry.action.replaceAll("_", " ")}</Link>
                <span className={auditStyles.identity}>{entry.entityId}</span></td>
              <td>{entry.actor.displayName ?? entry.actor.id}<span className={auditStyles.identity}>{entry.organization.name ?? entry.organization.id}</span></td>
              <td>{entry.correlationId}</td>
            </tr>)}</tbody>
          </table>
        </div>}
        <ListPagination label="Audit pages" prefix="audit" page={events.data.page} pageSize={events.data.pageSize} total={events.data.total} onChange={change} />
      </>}
    </>
  );
}
