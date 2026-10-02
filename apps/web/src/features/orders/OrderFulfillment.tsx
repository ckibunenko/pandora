import type { CancellationRequest, Order } from "@pandora/contracts";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { formatPrice, languageLabel } from "../catalog/catalog-api";
import catalogStyles from "../catalog/Catalog.module.css";
import { parseWholeNumber } from "../inventory/inventory-api";
import { formatDate, mutationMessage, useOrderCacheUpdate } from "./order-helpers";
import { approveCancellation, rejectCancellation, requestCancellation, shipOrder } from "./orders-api";
import { ReturnActions, ReturnList } from "./OrderReturns";
import styles from "./Orders.module.css";

const units = (count: number) => `${count} ${count === 1 ? "unit" : "units"}`;
const describeItems = (items: CancellationRequest["items"]) => items.map((item) => `${item.sku} × ${item.quantity}`).join(", ");

function FulfillmentTable({ order }: { order: Order }) {
  return (
    <div className={catalogStyles.tableScroll} role="region" aria-label="Fulfillment by line" tabIndex={0}>
      <table className={catalogStyles.table}>
        <caption className={catalogStyles.srOnly}>Fulfillment by line</caption>
        <thead>
          <tr>
            <th>Item</th>
            <th>SKU</th>
            <th className={styles.number}>Ordered</th>
            <th className={styles.number}>Shipped</th>
            <th className={styles.number}>Cancelled</th>
            <th className={styles.number}>Outstanding</th>
            <th className={styles.number}>Reserved</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((line) => (
            <tr key={line.id} data-test="order-line" data-sku={line.sku}>
              <td>
                {line.productName}
                <small className={styles.lineMeta}>
                  {languageLabel(line.language)} · {line.edition} · {formatPrice(line.unitPriceMinor)} each
                </small>
              </td>
              <td className={styles.sku}>{line.sku}</td>
              <td className={styles.number}>{line.quantity}</td>
              <td className={styles.number} data-test="order-line-shipped">
                {line.shippedQuantity}
              </td>
              <td className={styles.number} data-test="order-line-cancelled">
                {line.cancelledQuantity}
              </td>
              <td className={styles.number} data-test="order-line-outstanding">
                {line.outstandingQuantity}
              </td>
              <td className={styles.number} data-test="order-line-reserved">
                {line.reservedQuantity ?? 0}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShipmentForm({ order }: { order: Order }) {
  const open = order.lines.filter((line) => line.outstandingQuantity > 0);
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(open.map((line) => [line.id, String(line.outstandingQuantity)])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [key, setKey] = useState(() => crypto.randomUUID());
  const updateCache = useOrderCacheUpdate();
  const ship = useMutation({
    mutationFn: (items: { orderLineId: string; quantity: number }[]) => shipOrder(order.id, { version: order.version, items }, key),
    onSuccess: updateCache,
  });
  const parsed = open.map((line) => ({ line, quantity: parseWholeNumber(quantities[line.id] ?? "", false) }));
  const total = parsed.reduce((sum, entry) => sum + (entry.quantity ?? 0), 0);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    for (const { line, quantity } of parsed) {
      if (quantity === undefined || quantity > line.outstandingQuantity) {
        nextErrors[line.id] = `Enter 0 to ${line.outstandingQuantity}.`;
      }
    }
    if (Object.keys(nextErrors).length === 0 && total === 0) {
      nextErrors["form"] = "Enter a quantity for at least one line.";
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) {
      ship.mutate(parsed.filter((entry) => (entry.quantity ?? 0) > 0).map((entry) => ({ orderLineId: entry.line.id, quantity: entry.quantity ?? 0 })));
    }
  };

  return (
    <form className={styles.panel} onSubmit={onSubmit} aria-labelledby="ship-heading" data-test="shipment-form" noValidate>
      <h2 id="ship-heading">Record a shipment</h2>
      <p>Quantities default to everything outstanding. Use 0 to leave a line for a later shipment.</p>
      {open.map((line) => (
        <div className={catalogStyles.field} key={line.id} data-test="shipment-line" data-sku={line.sku}>
          <label htmlFor={`ship-${line.id}`}>
            {line.sku} · {line.productName} ({line.outstandingQuantity} outstanding)
          </label>
          <input
            id={`ship-${line.id}`}
            className={styles.quantity}
            inputMode="numeric"
            value={quantities[line.id] ?? ""}
            onChange={(event) => {
              setQuantities({ ...quantities, [line.id]: event.target.value });
              setKey(crypto.randomUUID());
              ship.reset();
            }}
            aria-invalid={errors[line.id] ? true : undefined}
            aria-describedby={errors[line.id] ? `ship-${line.id}-error` : undefined}
            disabled={ship.isPending}
            data-test="shipment-quantity"
          />
          {errors[line.id] && (
            <p className={catalogStyles.fieldError} id={`ship-${line.id}-error`}>
              {errors[line.id]}
            </p>
          )}
        </div>
      ))}
      {errors["form"] && (
        <p role="alert" className={catalogStyles.error}>
          {errors["form"]}
        </p>
      )}
      {ship.isError && (
        <p role="alert" className={catalogStyles.error} data-test="shipment-error">
          {mutationMessage(ship.error, "Could not confirm the shipment. Submit again; it will not be recorded twice.")}
        </p>
      )}
      <div className={styles.actions}>
        <button className={catalogStyles.primary} disabled={ship.isPending} data-test="shipment-submit">
          {ship.isPending ? "Recording…" : `Record shipment of ${units(total)}`}
        </button>
      </div>
    </form>
  );
}

function RequestReview({ order, request }: { order: Order; request: CancellationRequest }) {
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState("");
  const [approveKey] = useState(() => crypto.randomUUID());
  const [rejectKey, setRejectKey] = useState(() => crypto.randomUUID());
  const updateCache = useOrderCacheUpdate();
  const approve = useMutation({
    mutationFn: () => approveCancellation(order.id, request.id, { version: order.version }, approveKey),
    onSuccess: updateCache,
  });
  const reject = useMutation({
    mutationFn: () => rejectCancellation(order.id, request.id, { version: order.version, reason: reason.trim() }, rejectKey),
    onSuccess: updateCache,
  });
  const busy = approve.isPending || reject.isPending;
  const requestedUnits = request.items.reduce((sum, item) => sum + item.quantity, 0);
  const error = approve.error ?? reject.error;

  return (
    <section className={styles.panel} aria-labelledby="request-review-heading" data-test="cancellation-review">
      <h2 id="request-review-heading">Cancellation requested</h2>
      <p>
        {request.requestedBy.displayName} asked on {formatDate(request.requestedAt)} to cancel {describeItems(request.items)}
        {request.reason ? `: “${request.reason}”` : "."}
      </p>
      <p>
        Approving releases {units(requestedUnits)} of reserved stock; anything not requested stays open for shipment. Rejecting keeps the
        order as it is.
      </p>
      {error && (
        <p role="alert" className={catalogStyles.error} data-test="cancellation-error">
          {mutationMessage(error, "Could not confirm the decision. Try again; it will not be applied twice.")}
        </p>
      )}
      <div className={styles.actions}>
        <button className={catalogStyles.primary} onClick={() => approve.mutate()} disabled={busy} data-test="cancellation-approve">
          {approve.isPending ? "Approving…" : `Approve and release ${units(requestedUnits)}`}
        </button>
      </div>
      <div className={catalogStyles.field}>
        <label htmlFor="cancellation-reject-reason">Reason for rejecting</label>
        <textarea
          id="cancellation-reject-reason"
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setRejectKey(crypto.randomUUID());
            reject.reset();
          }}
          aria-invalid={reasonError ? true : undefined}
          aria-describedby={reasonError ? "cancellation-reject-reason-error" : undefined}
          data-test="cancellation-reject-reason"
        />
        {reasonError && (
          <p className={catalogStyles.fieldError} id="cancellation-reject-reason-error">
            {reasonError}
          </p>
        )}
      </div>
      <div className={styles.actions}>
        <button
          className={catalogStyles.secondary}
          onClick={() => {
            if (reason.trim().length < 3) {
              setReasonError("Give the retailer a reason of at least 3 characters.");
              return;
            }
            setReasonError("");
            reject.mutate();
          }}
          disabled={busy}
          data-test="cancellation-reject"
        >
          {reject.isPending ? "Rejecting…" : "Reject request"}
        </button>
      </div>
    </section>
  );
}

function RequestCancellation({ order }: { order: Order }) {
  const outstandingLines = order.lines.filter((line) => line.outstandingQuantity > 0);
  const [open, setOpen] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(outstandingLines.map((line) => [line.id, "0"])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const updateCache = useOrderCacheUpdate();
  const request = useMutation({
    mutationFn: (items: { orderLineId: string; quantity: number }[]) =>
      requestCancellation(order.id, { version: order.version, items, ...(reason.trim() ? { reason: reason.trim() } : {}) }, key),
    onSuccess: updateCache,
  });
  const remaining = outstandingLines.reduce((sum, line) => sum + line.outstandingQuantity, 0);
  const parsed = outstandingLines.map((line) => ({ line, quantity: parseWholeNumber(quantities[line.id] ?? "", false) }));
  const total = parsed.reduce((sum, entry) => sum + (entry.quantity ?? 0), 0);
  // Any edit makes this a different request, so it gets a new idempotency key.
  const edited = (next: Record<string, string>) => {
    setQuantities(next);
    setKey(crypto.randomUUID());
    request.reset();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    for (const { line, quantity } of parsed) {
      if (quantity === undefined || quantity > line.outstandingQuantity) {
        nextErrors[line.id] = `Enter 0 to ${line.outstandingQuantity}.`;
      }
    }
    if (Object.keys(nextErrors).length === 0 && total === 0) {
      nextErrors["form"] = "Enter a quantity for at least one line.";
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) {
      request.mutate(
        parsed.filter((entry) => (entry.quantity ?? 0) > 0).map((entry) => ({ orderLineId: entry.line.id, quantity: entry.quantity ?? 0 })),
      );
    }
  };

  if (!open) {
    return (
      <div className={styles.actions}>
        <button className={catalogStyles.secondary} onClick={() => setOpen(true)} data-test="cancellation-request">
          Request cancellation
        </button>
      </div>
    );
  }
  return (
    <form className={styles.panel} onSubmit={onSubmit} aria-labelledby="request-heading" data-test="cancellation-request-panel" noValidate>
      <h2 id="request-heading">Request cancellation</h2>
      <p>
        {units(remaining)} not yet shipped. Choose how many to cancel; the rest stays on the order. The distributor reviews the
        request. Until then nothing changes, and shipping may continue.
      </p>
      {outstandingLines.map((line) => (
        <div className={catalogStyles.field} key={line.id} data-test="cancellation-request-line" data-sku={line.sku}>
          <label htmlFor={`cancel-${line.id}`}>
            {line.sku} · {line.productName} ({line.outstandingQuantity} outstanding)
          </label>
          <input
            id={`cancel-${line.id}`}
            className={styles.quantity}
            inputMode="numeric"
            value={quantities[line.id] ?? ""}
            onChange={(event) => edited({ ...quantities, [line.id]: event.target.value })}
            aria-invalid={errors[line.id] ? true : undefined}
            aria-describedby={errors[line.id] ? `cancel-${line.id}-error` : undefined}
            disabled={request.isPending}
            data-test="cancellation-request-quantity"
          />
          {errors[line.id] && (
            <p className={catalogStyles.fieldError} id={`cancel-${line.id}-error`}>
              {errors[line.id]}
            </p>
          )}
        </div>
      ))}
      <div className={styles.actions}>
        <button
          type="button"
          className={catalogStyles.secondary}
          onClick={() => edited(Object.fromEntries(outstandingLines.map((line) => [line.id, String(line.outstandingQuantity)])))}
          disabled={request.isPending}
          data-test="cancellation-request-all"
        >
          Cancel all remaining
        </button>
      </div>
      {errors["form"] && (
        <p role="alert" className={catalogStyles.error}>
          {errors["form"]}
        </p>
      )}
      <div className={catalogStyles.field}>
        <label htmlFor="cancellation-request-reason">Reason (optional)</label>
        <textarea
          id="cancellation-request-reason"
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setKey(crypto.randomUUID());
            request.reset();
          }}
          data-test="cancellation-request-reason"
        />
      </div>
      {request.isError && (
        <p role="alert" className={catalogStyles.error} data-test="cancellation-request-error">
          {mutationMessage(request.error, "Could not confirm the request. Send it again; it will not be sent twice.")}
        </p>
      )}
      <div className={styles.actions}>
        <button className={catalogStyles.primary} disabled={request.isPending} data-test="cancellation-request-submit">
          {request.isPending ? "Sending…" : `Send request to cancel ${units(total)}`}
        </button>
        <button type="button" className={catalogStyles.secondary} onClick={() => setOpen(false)} disabled={request.isPending}>
          Keep order
        </button>
      </div>
    </form>
  );
}

function Records({ order }: { order: Order }) {
  return (
    <>
      <section className={styles.records} aria-labelledby="shipments-heading">
        <h2 id="shipments-heading">Shipments</h2>
        {order.shipments.length === 0 ? (
          <p className={catalogStyles.muted}>No shipments yet.</p>
        ) : (
          <ol data-test="shipment-list">
            {order.shipments.map((shipment) => (
              <li key={shipment.id} data-test="shipment-row" data-shipment-number={shipment.number}>
                <strong>{shipment.number}</strong> · {describeItems(shipment.items)} · {shipment.createdBy.displayName} ·{" "}
                <time dateTime={shipment.createdAt}>{formatDate(shipment.createdAt)}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
      {order.cancellationRequests.length > 0 && (
        <section className={styles.records} aria-labelledby="requests-heading">
          <h2 id="requests-heading">Cancellation requests</h2>
          <ol data-test="cancellation-request-list">
            {order.cancellationRequests.map((request) => (
              <li key={request.id} data-test="cancellation-request-row" data-status={request.status}>
                <span className={styles.status} data-status={request.status}>{request.status === "pending" ? "Pending" : request.status === "approved" ? "Approved" : "Rejected"}</span> ·{" "}
                {describeItems(request.items)} · requested by {request.requestedBy.displayName}
                {request.reason ? ` (“${request.reason}”)` : ""}
                {request.decidedBy && request.decidedAt
                  ? ` · decided by ${request.decidedBy.displayName} on ${formatDate(request.decidedAt)}`
                  : ""}
                {request.decisionReason ? `: ${request.decisionReason}` : ""}
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

/** Orders after confirmation: shipped/cancelled progress plus the actions each role may take. */
export function FulfillmentView({ order, isStaff }: { order: Order; isStaff: boolean }) {
  const open = order.status === "confirmed" || order.status === "partially_shipped";
  const pending = order.cancellationRequests.find((request) => request.status === "pending");
  return (
    <>
      <FulfillmentTable order={order} />
      <p className={styles.total}>
        Total <strong data-test="order-total">{formatPrice(order.totalMinor)}</strong>
        <small> Prices were fixed at submission.</small>
      </p>
      {open && isStaff && pending && <RequestReview key={`${pending.id}-${order.version}`} order={order} request={pending} />}
      <ReturnActions order={order} isStaff={isStaff} />
      {open && isStaff && <ShipmentForm key={order.version} order={order} />}
      {open && !isStaff && pending && (
        <p role="status" className={styles.panel} data-test="cancellation-pending">
          Cancellation of {describeItems(pending.items)} requested on {formatDate(pending.requestedAt)} — waiting for the distributor.
        </p>
      )}
      {open && !isStaff && !pending && <RequestCancellation key={order.version} order={order} />}
      <Records order={order} />
      <ReturnList order={order} />
    </>
  );
}
