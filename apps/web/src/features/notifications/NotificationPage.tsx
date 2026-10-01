import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ApiError } from "../../lib/api-client";
import catalogStyles from "../catalog/Catalog.module.css";
import { mutationMessage } from "../orders/order-helpers";
import { EVENT_LABELS, NOTIFICATIONS_QUERY_KEY, STATUS_LABELS, notificationDate, retryNotification, useNotification } from "./notifications-api";
import styles from "./Notifications.module.css";

const OUTCOME_LABELS = { in_progress: "In progress", sent: "Sent", failed: "Failed", ambiguous: "Ambiguous (lease expired)" } as const;

export function NotificationPage() {
  const { notificationId = "" } = useParams();
  const [params] = useSearchParams();
  const job = useNotification(notificationId);
  const client = useQueryClient();
  // One key per retry intent: resubmitting after a lost response replays instead of queuing twice.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const retry = useMutation({
    mutationFn: () => retryNotification(notificationId, key),
    onSuccess: async () => {
      setKey(crypto.randomUUID());
      await client.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
    },
  });

  return (
    <>
      <Link className={catalogStyles.back} to={`/notifications?${params}`} data-test="notifications-back">
        ← Back to notifications
      </Link>
      {job.isPending && <p role="status">Loading notification…</p>}
      {job.isError && (
        <p role="alert" className={catalogStyles.error}>
          {job.error instanceof ApiError && job.error.status === 404 ? "This notification does not exist." : "Could not load this notification."}{" "}
          <button className={catalogStyles.textButton} onClick={() => void job.refetch()}>
            Try again
          </button>
        </p>
      )}
      {job.data && (
        <>
          <div className={catalogStyles.heading}>
            <div>
              <p className={catalogStyles.eyebrow}>{EVENT_LABELS[job.data.eventType].toUpperCase()}</p>
              <h1 data-test="notification-subject">{job.data.subject}</h1>
              <p>
                <span className={styles.status} data-status={job.data.status} data-test="notification-status">
                  {STATUS_LABELS[job.data.status]}
                </span>
              </p>
            </div>
          </div>
          <dl className={styles.metadata} data-test="notification-detail">
            <dt>Order</dt>
            <dd>
              <Link to={`/orders/${job.data.order.id}`}>{job.data.order.number}</Link>
            </dd>
            <dt>Recipient</dt>
            <dd>
              {job.data.recipient.displayName}
              {job.data.recipientEmail && <span data-test="notification-recipient-email"> · {job.data.recipientEmail}</span>}
            </dd>
            <dt>Attempts</dt>
            <dd>
              {job.data.attemptCount} of {job.data.maxAttempts}
            </dd>
            {job.data.nextAttemptAt && (
              <>
                <dt>Next attempt</dt>
                <dd>
                  <time dateTime={job.data.nextAttemptAt}>{notificationDate(job.data.nextAttemptAt)}</time>
                </dd>
              </>
            )}
            {job.data.sentAt && (
              <>
                <dt>Sent</dt>
                <dd>
                  <time dateTime={job.data.sentAt}>{notificationDate(job.data.sentAt)}</time>
                </dd>
              </>
            )}
            <dt>Last error</dt>
            <dd>{job.data.lastError ?? "None"}</dd>
            <dt>Queued</dt>
            <dd>
              <time dateTime={job.data.createdAt}>{notificationDate(job.data.createdAt)}</time>
            </dd>
            <dt>Correlation ID</dt>
            <dd data-test="notification-correlation-id">{job.data.correlationId}</dd>
          </dl>
          {job.data.status === "failed" && (
            <section className={styles.retry} aria-labelledby="retry-heading">
              <h2 id="retry-heading">Delivery failed</h2>
              <p>Retrying grants one more attempt now. The order itself is not affected either way.</p>
              {retry.isError && (
                <p role="alert" className={catalogStyles.error} data-test="notification-retry-error">
                  {mutationMessage(retry.error, "Could not confirm the retry. Select Retry again; it will not be queued twice.")}
                </p>
              )}
              <button className={catalogStyles.primary} onClick={() => retry.mutate()} disabled={retry.isPending} data-test="notification-retry">
                {retry.isPending ? "Queuing…" : "Retry delivery"}
              </button>
            </section>
          )}
          {retry.isSuccess && job.data.status !== "failed" && (
            <p role="status" className={catalogStyles.success} data-test="notification-retry-queued">
              Queued for one more attempt. The worker will deliver it shortly.
            </p>
          )}
          <h2>Attempts</h2>
          {job.data.attempts.length === 0 ? (
            <p className={catalogStyles.muted}>No delivery attempt yet.</p>
          ) : (
            <div className={catalogStyles.tableScroll} role="region" aria-label="Delivery attempts" tabIndex={0}>
              <table className={catalogStyles.table}>
                <caption className={catalogStyles.srOnly}>Delivery attempts, oldest first.</caption>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Outcome</th>
                    <th>Started</th>
                    <th>Worker</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {job.data.attempts.map((attempt) => (
                    <tr key={attempt.number} data-test="notification-attempt-row" data-outcome={attempt.outcome}>
                      <td>{attempt.number}</td>
                      <td>{OUTCOME_LABELS[attempt.outcome]}</td>
                      <td>
                        <time dateTime={attempt.startedAt}>{notificationDate(attempt.startedAt)}</time>
                      </td>
                      <td>{attempt.workerId}</td>
                      <td>{attempt.error ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {job.data.body !== null && (
            <section aria-labelledby="message-heading">
              <h2 id="message-heading">Message</h2>
              <pre className={styles.body} data-test="notification-body">
                {job.data.body}
              </pre>
            </section>
          )}
        </>
      )}
    </>
  );
}
