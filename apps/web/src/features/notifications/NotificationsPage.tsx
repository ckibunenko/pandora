import { notificationEventTypeSchema, notificationStatusSchema } from "@pandora/contracts";
import { Link, useSearchParams } from "react-router";
import { ListPagination } from "../../components/ListPagination";
import { useSession } from "../auth/session";
import catalogStyles from "../catalog/Catalog.module.css";
import { EVENT_LABELS, STATUS_LABELS, notificationDate, useNotifications } from "./notifications-api";
import styles from "./Notifications.module.css";

/** Delivery diagnostics: operators see the operational view, administrators also see recipient addresses. */
export function NotificationsPage() {
  const [params, setParams] = useSearchParams();
  const jobs = useNotifications(params.toString());
  const isAdmin = useSession().data?.user.role === "administrator";

  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next);
  }

  return (
    <>
      <div className={catalogStyles.heading}>
        <div>
          <p className={catalogStyles.eyebrow}>DELIVERY DIAGNOSTICS</p>
          <h1>Notifications</h1>
          <p className={catalogStyles.muted}>
            Emails queued by business events and delivered to the captured inbox. A failed delivery never changes the order; retry it
            from its detail page.
          </p>
        </div>
      </div>
      <div className={styles.filters}>
        <label className={catalogStyles.field}>
          Status
          <select value={params.get("status") ?? ""} onChange={(event) => change("status", event.target.value)} data-test="notifications-status-filter">
            <option value="">All statuses</option>
            {notificationStatusSchema.options.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <label className={catalogStyles.field}>
          Event
          <select value={params.get("eventType") ?? ""} onChange={(event) => change("eventType", event.target.value)} data-test="notifications-event-filter">
            <option value="">All events</option>
            {notificationEventTypeSchema.options.map((type) => (
              <option key={type} value={type}>
                {EVENT_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {jobs.isPending && <p role="status">Loading notifications…</p>}
      {jobs.isError && (
        <div role="alert" className={catalogStyles.error} data-test="notifications-error">
          Could not load notifications.{" "}
          <button className={catalogStyles.textButton} onClick={() => void jobs.refetch()} data-test="notifications-retry-load">
            Try again
          </button>
        </div>
      )}
      {jobs.data && (
        <>
          <p className={catalogStyles.results} role="status" data-test="notifications-total">
            {jobs.data.total} {jobs.data.total === 1 ? "notification" : "notifications"}
          </p>
          {!jobs.data.items.length ? (
            <div className={catalogStyles.empty} data-test="notifications-empty">
              <h2>No notifications found</h2>
              <p>Business events queue notifications automatically. Try other filters.</p>
            </div>
          ) : (
            <div className={catalogStyles.tableScroll} role="region" aria-label="Notifications" tabIndex={0}>
              <table className={`${catalogStyles.table} ${styles.jobsTable}`}>
                <caption className={catalogStyles.srOnly}>Notifications, newest first. Times shown in Europe/Belgrade.</caption>
                <thead>
                  <tr>
                    <th>Queued</th>
                    <th>Event</th>
                    <th>Recipient</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Last error</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.data.items.map((job) => (
                    <tr key={job.id} data-test="notification-row" data-notification-id={job.id} data-status={job.status}>
                      <td>
                        <time dateTime={job.createdAt}>{notificationDate(job.createdAt)}</time>
                      </td>
                      <td>
                        <Link to={`/notifications/${job.id}?${params}`} data-test="notification-link">
                          {EVENT_LABELS[job.eventType]}
                        </Link>
                        <span className={styles.detail}>{job.order.number}</span>
                      </td>
                      <td>
                        {job.recipient.displayName}
                        {isAdmin && job.recipientEmail && <span className={styles.detail}>{job.recipientEmail}</span>}
                      </td>
                      <td>
                        <span className={styles.status} data-status={job.status} data-test="notification-status">
                          {STATUS_LABELS[job.status]}
                        </span>
                      </td>
                      <td>
                        {job.attemptCount} of {job.maxAttempts}
                      </td>
                      <td>{job.lastError ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ListPagination label="Notification pages" prefix="notifications" page={jobs.data.page} pageSize={jobs.data.pageSize} total={jobs.data.total} onChange={change} />
        </>
      )}
    </>
  );
}
