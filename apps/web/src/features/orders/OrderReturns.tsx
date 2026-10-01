import type { Order, ReturnRequest } from "@pandora/contracts";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import catalogStyles from "../catalog/Catalog.module.css";
import { parseWholeNumber } from "../inventory/inventory-api";
import { formatDate, mutationMessage, useOrderCacheUpdate } from "./order-helpers";
import { approveReturn, receiveReturn, rejectReturn, requestReturn } from "./orders-api";
import styles from "./Orders.module.css";

const units = (count: number) => `${count} ${count === 1 ? "unit" : "units"}`;
const RETURN_LABELS: Record<ReturnRequest["status"], string> = {
  pending: "Pending",
  approved: "Approved, awaiting receipt",
  rejected: "Rejected",
  completed: "Received",
};
const RETURNABLE_STATUSES: readonly Order["status"][] = ["partially_shipped", "shipped", "closed_partial"];

function ReturnRequestForm({ order }: { order: Order }) {
  const returnable = order.shipments.flatMap((shipment) =>
    shipment.items.filter((item) => item.returnableQuantity > 0).map((item) => ({ ...item, shipment: shipment.number })),
  );
  const [open, setOpen] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, string>>(() => Object.fromEntries(returnable.map((item) => [item.id, "0"])));
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Any edit makes this a different request, so it gets a new idempotency key.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const updateCache = useOrderCacheUpdate();
  const send = useMutation({
    mutationFn: (items: { shipmentItemId: string; quantity: number }[]) => requestReturn(order.id, { reason: reason.trim(), items }, key),
    onSuccess: updateCache,
  });
  const parsed = returnable.map((item) => ({ item, quantity: parseWholeNumber(quantities[item.id] ?? "", false) }));
  const total = parsed.reduce((sum, entry) => sum + (entry.quantity ?? 0), 0);
  const edited = () => {
    setKey(crypto.randomUUID());
    send.reset();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    for (const { item, quantity } of parsed) {
      if (quantity === undefined || quantity > item.returnableQuantity) {
        nextErrors[item.id] = `Enter 0 to ${item.returnableQuantity}.`;
      }
    }
    if (Object.keys(nextErrors).length === 0 && total === 0) {
      nextErrors["form"] = "Enter a quantity for at least one item.";
    }
    if (reason.trim().length < 3) {
      nextErrors["reason"] = "Give a reason of at least 3 characters.";
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) {
      send.mutate(parsed.filter((entry) => (entry.quantity ?? 0) > 0).map((entry) => ({ shipmentItemId: entry.item.id, quantity: entry.quantity ?? 0 })));
    }
  };

  if (returnable.length === 0) return null;
  if (!open) {
    return (
      <div className={styles.actions}>
        <button className={catalogStyles.secondary} onClick={() => setOpen(true)} data-test="return-request">
          Request a return
        </button>
      </div>
    );
  }
  return (
    <form className={styles.panel} onSubmit={onSubmit} aria-labelledby="return-request-heading" data-test="return-request-panel" noValidate>
      <h2 id="return-request-heading">Request a return</h2>
      <p>Choose how many shipped units to send back. The distributor approves the request, then inspects what arrives.</p>
      {parsed.map(({ item }) => (
        <div className={catalogStyles.field} key={item.id} data-test="return-request-line" data-shipment-number={item.shipment} data-sku={item.sku}>
          <label htmlFor={`return-${item.id}`}>
            {item.shipment} · {item.sku} ({item.quantity} shipped, {item.returnableQuantity} returnable)
          </label>
          <input
            id={`return-${item.id}`}
            className={styles.quantity}
            inputMode="numeric"
            value={quantities[item.id] ?? ""}
            onChange={(event) => {
              setQuantities({ ...quantities, [item.id]: event.target.value });
              edited();
            }}
            aria-invalid={errors[item.id] ? true : undefined}
            aria-describedby={errors[item.id] ? `return-${item.id}-error` : undefined}
            disabled={send.isPending}
            data-test="return-request-quantity"
          />
          {errors[item.id] && (
            <p className={catalogStyles.fieldError} id={`return-${item.id}-error`}>
              {errors[item.id]}
            </p>
          )}
        </div>
      ))}
      <div className={catalogStyles.field}>
        <label htmlFor="return-request-reason">Reason</label>
        <textarea
          id="return-request-reason"
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            edited();
          }}
          aria-invalid={errors["reason"] ? true : undefined}
          aria-describedby={errors["reason"] ? "return-request-reason-error" : undefined}
          disabled={send.isPending}
          data-test="return-request-reason"
        />
        {errors["reason"] && (
          <p className={catalogStyles.fieldError} id="return-request-reason-error">
            {errors["reason"]}
          </p>
        )}
      </div>
      {errors["form"] && (
        <p role="alert" className={catalogStyles.error}>
          {errors["form"]}
        </p>
      )}
      {send.isError && (
        <p role="alert" className={catalogStyles.error} data-test="return-error">
          {mutationMessage(send.error, "Could not confirm the return request. Send it again; it will not be sent twice.")}
        </p>
      )}
      <div className={styles.actions}>
        <button className={catalogStyles.primary} disabled={send.isPending} data-test="return-request-submit">
          {send.isPending ? "Sending…" : `Send return request for ${units(total)}`}
        </button>
        <button type="button" className={catalogStyles.secondary} onClick={() => setOpen(false)} disabled={send.isPending}>
          Keep everything
        </button>
      </div>
    </form>
  );
}

function ReturnReview({ order, entry }: { order: Order; entry: ReturnRequest }) {
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState("");
  const [approveKey] = useState(() => crypto.randomUUID());
  const [rejectKey, setRejectKey] = useState(() => crypto.randomUUID());
  const updateCache = useOrderCacheUpdate();
  const approve = useMutation({ mutationFn: () => approveReturn(order.id, entry.id, {}, approveKey), onSuccess: updateCache });
  const reject = useMutation({
    mutationFn: () => rejectReturn(order.id, entry.id, { reason: reason.trim() }, rejectKey),
    onSuccess: updateCache,
  });
  const busy = approve.isPending || reject.isPending;
  const error = approve.error ?? reject.error;
  const headingId = `return-review-${entry.id}`;
  return (
    <section className={styles.panel} aria-labelledby={headingId} data-test="return-review" data-return-number={entry.number}>
      <h2 id={headingId}>Return {entry.number} requested</h2>
      <p>
        {entry.requestedBy.displayName} asked on {formatDate(entry.requestedAt)} to return {describeReturn(entry)}: “{entry.reason}”.
      </p>
      <p>Approving changes no stock; record the receipt when the goods arrive. Rejecting frees the units for a later request.</p>
      {error && (
        <p role="alert" className={catalogStyles.error} data-test="return-error">
          {mutationMessage(error, "Could not confirm the decision. Try again; it will not be applied twice.")}
        </p>
      )}
      <div className={styles.actions}>
        <button className={catalogStyles.primary} onClick={() => approve.mutate()} disabled={busy} data-test="return-approve">
          {approve.isPending ? "Approving…" : "Approve return"}
        </button>
      </div>
      <div className={catalogStyles.field}>
        <label htmlFor={`return-reject-${entry.id}`}>Reason for rejecting</label>
        <textarea
          id={`return-reject-${entry.id}`}
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setRejectKey(crypto.randomUUID());
            reject.reset();
          }}
          aria-invalid={reasonError ? true : undefined}
          aria-describedby={reasonError ? `return-reject-${entry.id}-error` : undefined}
          data-test="return-reject-reason"
        />
        {reasonError && (
          <p className={catalogStyles.fieldError} id={`return-reject-${entry.id}-error`}>
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
          data-test="return-reject"
        >
          {reject.isPending ? "Rejecting…" : "Reject return"}
        </button>
      </div>
    </section>
  );
}

function ReturnReceipt({ order, entry }: { order: Order; entry: ReturnRequest }) {
  const [counts, setCounts] = useState<Record<string, { sellable: string; damaged: string }>>(() =>
    Object.fromEntries(entry.items.map((item) => [item.id, { sellable: String(item.quantity), damaged: "0" }])),
  );
  const [discrepancy, setDiscrepancy] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [key, setKey] = useState(() => crypto.randomUUID());
  const updateCache = useOrderCacheUpdate();
  const receive = useMutation({
    mutationFn: (items: { returnItemId: string; sellableQuantity: number; damagedQuantity: number }[]) =>
      receiveReturn(order.id, entry.id, { items, ...(discrepancy.trim() ? { discrepancyReason: discrepancy.trim() } : {}) }, key),
    onSuccess: updateCache,
  });
  const parsed = entry.items.map((item) => ({
    item,
    sellable: parseWholeNumber(counts[item.id]?.sellable ?? "", false),
    damaged: parseWholeNumber(counts[item.id]?.damaged ?? "", false),
  }));
  const total = parsed.reduce((sum, entry) => sum + (entry.sellable ?? 0) + (entry.damaged ?? 0), 0);
  const short = parsed.some(({ item, sellable, damaged }) => (sellable ?? 0) + (damaged ?? 0) < item.quantity);
  const edited = () => {
    setKey(crypto.randomUUID());
    receive.reset();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    for (const { item, sellable, damaged } of parsed) {
      if (sellable === undefined || damaged === undefined || sellable + damaged > item.quantity) {
        nextErrors[item.id] = `Sellable and damaged together: 0 to ${item.quantity}.`;
      }
    }
    if (short && discrepancy.trim().length < 3) {
      nextErrors["discrepancy"] = "Fewer units than approved: explain the difference (at least 3 characters).";
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) {
      receive.mutate(parsed.map(({ item, sellable, damaged }) => ({ returnItemId: item.id, sellableQuantity: sellable ?? 0, damagedQuantity: damaged ?? 0 })));
    }
  };

  const headingId = `return-receipt-${entry.id}`;
  return (
    <form className={styles.panel} onSubmit={onSubmit} aria-labelledby={headingId} data-test="return-receipt" data-return-number={entry.number} noValidate>
      <h2 id={headingId}>Receive return {entry.number}</h2>
      <p>Inspect every item once. Sellable units go back into stock; damaged units are kept apart and cannot be sold.</p>
      {parsed.map(({ item }) => (
        <fieldset className={styles.receiptLine} key={item.id} data-test="return-receipt-line" data-sku={item.sku}>
          <legend>
            {item.shipmentNumber} · {item.sku} ({item.quantity} approved)
          </legend>
          {(["sellable", "damaged"] as const).map((bucket) => (
            <div className={catalogStyles.field} key={bucket}>
              <label htmlFor={`receipt-${item.id}-${bucket}`}>{bucket === "sellable" ? "Sellable" : "Damaged"}</label>
              <input
                id={`receipt-${item.id}-${bucket}`}
                className={styles.quantity}
                inputMode="numeric"
                value={counts[item.id]?.[bucket] ?? ""}
                onChange={(event) => {
                  setCounts({ ...counts, [item.id]: { sellable: "0", damaged: "0", ...counts[item.id], [bucket]: event.target.value } });
                  edited();
                }}
                aria-invalid={errors[item.id] ? true : undefined}
                aria-describedby={errors[item.id] ? `receipt-${item.id}-error` : undefined}
                disabled={receive.isPending}
                data-test={`return-receipt-${bucket}`}
              />
            </div>
          ))}
          {errors[item.id] && (
            <p className={catalogStyles.fieldError} id={`receipt-${item.id}-error`}>
              {errors[item.id]}
            </p>
          )}
        </fieldset>
      ))}
      <div className={catalogStyles.field}>
        <label htmlFor={`receipt-discrepancy-${entry.id}`}>Discrepancy reason {short ? "(required: fewer units than approved)" : "(optional)"}</label>
        <textarea
          id={`receipt-discrepancy-${entry.id}`}
          rows={2}
          maxLength={500}
          value={discrepancy}
          onChange={(event) => {
            setDiscrepancy(event.target.value);
            edited();
          }}
          aria-invalid={errors["discrepancy"] ? true : undefined}
          aria-describedby={errors["discrepancy"] ? `receipt-discrepancy-${entry.id}-error` : undefined}
          disabled={receive.isPending}
          data-test="return-receipt-discrepancy"
        />
        {errors["discrepancy"] && (
          <p className={catalogStyles.fieldError} id={`receipt-discrepancy-${entry.id}-error`}>
            {errors["discrepancy"]}
          </p>
        )}
      </div>
      {receive.isError && (
        <p role="alert" className={catalogStyles.error} data-test="return-error">
          {mutationMessage(receive.error, "Could not confirm the receipt. Submit again; it will not be recorded twice.")}
        </p>
      )}
      <div className={styles.actions}>
        <button className={catalogStyles.primary} disabled={receive.isPending} data-test="return-receipt-submit">
          {receive.isPending ? "Recording…" : `Record receipt of ${units(total)}`}
        </button>
      </div>
    </form>
  );
}

const describeReturn = (entry: ReturnRequest) => entry.items.map((item) => `${item.sku} × ${item.quantity} (${item.shipmentNumber})`).join(", ");

function describeReceipt(entry: ReturnRequest): string {
  const sellable = entry.items.reduce((sum, item) => sum + (item.receivedSellable ?? 0), 0);
  const damaged = entry.items.reduce((sum, item) => sum + (item.receivedDamaged ?? 0), 0);
  return `${sellable} sellable, ${damaged} damaged`;
}

export function ReturnList({ order }: { order: Order }) {
  if (order.returns.length === 0) return null;
  return (
    <section className={styles.records} aria-labelledby="returns-heading">
      <h2 id="returns-heading">Returns</h2>
      <ol data-test="return-list">
        {order.returns.map((entry) => (
          <li key={entry.id} data-test="return-row" data-return-number={entry.number} data-status={entry.status}>
            <strong>{entry.number}</strong> · {RETURN_LABELS[entry.status]} · {describeReturn(entry)} · requested by{" "}
            {entry.requestedBy.displayName} (“{entry.reason}”)
            {entry.decidedBy && entry.decidedAt ? ` · decided by ${entry.decidedBy.displayName} on ${formatDate(entry.decidedAt)}` : ""}
            {entry.decisionReason ? `: ${entry.decisionReason}` : ""}
            {entry.receivedBy && entry.receivedAt
              ? ` · received by ${entry.receivedBy.displayName} on ${formatDate(entry.receivedAt)}: ${describeReceipt(entry)}`
              : ""}
            {entry.discrepancyReason ? ` (discrepancy: ${entry.discrepancyReason})` : ""}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Return actions per role; returns are a separate lifecycle that never changes the order's fulfillment status. */
export function ReturnActions({ order, isStaff }: { order: Order; isStaff: boolean }) {
  const eligible = RETURNABLE_STATUSES.includes(order.status);
  // Return actions do not bump the order version, so forms are keyed by the returns they depend on.
  const returnsKey = order.returns.map((entry) => `${entry.id}:${entry.status}`).join(",");
  return (
    <>
      {isStaff &&
        order.returns.map((entry) =>
          entry.status === "pending" ? (
            <ReturnReview key={`${entry.id}-${entry.status}`} order={order} entry={entry} />
          ) : entry.status === "approved" ? (
            <ReturnReceipt key={`${entry.id}-${entry.status}`} order={order} entry={entry} />
          ) : null,
        )}
      {!isStaff && eligible && <ReturnRequestForm key={returnsKey} order={order} />}
    </>
  );
}
