import { ERROR_CODES, MAX_LINE_QUANTITY, type Order } from "@pandora/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "../../lib/api-client";
import { useSession } from "../auth/session";
import { formatPrice, languageLabel } from "../catalog/catalog-api";
import catalogStyles from "../catalog/Catalog.module.css";
import { parseWholeNumber } from "../inventory/inventory-api";
import { ORDERS_QUERY_KEY, STATUS_LABELS, cancelOrder, fetchOrder, saveOrderLines, submitOrder, useOrder } from "./orders-api";
import styles from "./Orders.module.css";

interface LocalLine {
  variantId: string;
  quantity: string;
}

const toLocal = (order: Order): LocalLine[] => order.lines.map((line) => ({ variantId: line.variantId, quantity: String(line.quantity) }));
const sameLines = (a: readonly LocalLine[], b: readonly LocalLine[]) =>
  a.length === b.length && a.every((line, index) => line.variantId === b[index]?.variantId && line.quantity === b[index]?.quantity);
const formatDate = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/Belgrade" });
const skusFrom = (error: ApiError) => error.details.map((detail) => detail.field.replace(/^lines\./, "")).join(", ");

function mutationMessage(error: unknown, lostResponse: string): string {
  if (!(error instanceof ApiError)) return lostResponse;
  switch (error.code) {
    case ERROR_CODES.versionConflict:
      return "Someone else changed this draft. Your edits are still shown; reload to see the latest version.";
    case ERROR_CODES.priceChanged:
      return `Prices changed for ${skusFrom(error)}. The latest prices are shown now; review them and submit again.`;
    case ERROR_CODES.variantUnavailable:
      return `No longer available: ${skusFrom(error)}. Remove these items to submit.`;
    case ERROR_CODES.validationFailed:
      return "Please correct the highlighted fields.";
    default:
      return error.message;
  }
}

function useOrderCacheUpdate() {
  const client = useQueryClient();
  const session = useSession();
  return async (order: Order) => {
    client.setQueryData([...ORDERS_QUERY_KEY, session.data?.user.id, "order", order.id], order);
    await Promise.all([
      client.invalidateQueries({ queryKey: [...ORDERS_QUERY_KEY, session.data?.user.id, "list"] }),
      client.invalidateQueries({ queryKey: ["catalog"] }),
    ]);
  };
}

function CancelPanel({ order, version }: { order: Order; version: number }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const updateCache = useOrderCacheUpdate();
  const cancel = useMutation({
    mutationFn: () => cancelOrder(order.id, { version, ...(reason.trim() ? { reason: reason.trim() } : {}) }, key),
    onSuccess: async (updated) => {
      setKey(crypto.randomUUID());
      await updateCache(updated);
    },
  });
  if (!open) {
    return (
      <button className={catalogStyles.secondary} onClick={() => setOpen(true)} data-test="order-cancel">
        Cancel order
      </button>
    );
  }
  return (
    <section className={styles.panel} aria-labelledby="cancel-heading" data-test="order-cancel-panel">
      <h2 id="cancel-heading">Cancel {order.number}?</h2>
      <p>The whole order is cancelled for everyone in your organization. This cannot be undone.</p>
      <div className={catalogStyles.field}>
        <label htmlFor="cancel-reason">Reason (optional)</label>
        <textarea
          id="cancel-reason"
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setKey(crypto.randomUUID());
            cancel.reset();
          }}
          data-test="order-cancel-reason"
        />
      </div>
      {cancel.isError && (
        <p role="alert" className={catalogStyles.error} data-test="order-cancel-error">
          {mutationMessage(cancel.error, "Could not confirm the cancellation. Try again; it will not be applied twice.")}
        </p>
      )}
      <div className={styles.actions}>
        <button className={catalogStyles.primary} onClick={() => cancel.mutate()} disabled={cancel.isPending} data-test="order-cancel-confirm">
          {cancel.isPending ? "Cancelling…" : "Cancel order"}
        </button>
        <button className={catalogStyles.secondary} onClick={() => setOpen(false)} disabled={cancel.isPending}>
          Keep order
        </button>
      </div>
    </section>
  );
}

function DraftEditor({ latest }: { latest: Order }) {
  const [base, setBase] = useState(latest);
  const [lines, setLines] = useState(() => toLocal(latest));
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [submitKey, setSubmitKey] = useState(() => crypto.randomUUID());
  const updateCache = useOrderCacheUpdate();
  const dirty = !sameLines(lines, toLocal(base));

  function adopt(order: Order) {
    setBase(order);
    setLines(toLocal(order));
    setLineErrors({});
    setSubmitKey(crypto.randomUUID());
  }

  // Background refreshes only replace the draft when there are no unsaved edits to lose.
  if (latest.version !== base.version && !dirty) {
    adopt(latest);
  }

  const save = useMutation({
    mutationFn: (parsed: { variantId: string; quantity: number }[]) => saveOrderLines(base.id, { version: base.version, lines: parsed }),
    onSuccess: async (order) => {
      adopt(order);
      await updateCache(order);
    },
  });
  const submit = useMutation({
    mutationFn: () =>
      submitOrder(
        base.id,
        { version: base.version, reviewedPrices: base.lines.map((line) => ({ variantId: line.variantId, unitPriceMinor: line.unitPriceMinor })) },
        submitKey,
      ),
    onSuccess: updateCache,
    onError: async (error) => {
      if (error instanceof ApiError && (error.code === ERROR_CODES.priceChanged || error.code === ERROR_CODES.variantUnavailable)) {
        // Show the current prices and availability so the retailer reviews what would actually be submitted.
        adopt(await fetchOrder(base.id));
      }
    },
  });
  const reload = useMutation({
    mutationFn: () => fetchOrder(base.id),
    onSuccess: async (order) => {
      adopt(order);
      save.reset();
      await updateCache(order);
    },
  });

  function onSave() {
    const errors: Record<string, string> = {};
    const parsed = lines.map((line) => {
      const quantity = parseWholeNumber(line.quantity, false);
      if (quantity === undefined || quantity < 1 || quantity > MAX_LINE_QUANTITY) {
        errors[line.variantId] = `Enter a whole number from 1 to ${MAX_LINE_QUANTITY.toLocaleString("en")}.`;
      }
      return { variantId: line.variantId, quantity: quantity ?? 0 };
    });
    setLineErrors(errors);
    if (Object.keys(errors).length === 0) {
      submit.reset();
      save.mutate(parsed);
    }
  }
  const edit = (variantId: string, quantity: string | null) => {
    setLines((current) =>
      quantity === null
        ? current.filter((line) => line.variantId !== variantId)
        : current.map((line) => (line.variantId === variantId ? { ...line, quantity } : line)),
    );
    setConfirming(false);
    save.reset();
    submit.reset();
  };

  const conflict = save.error instanceof ApiError && save.error.code === ERROR_CODES.versionConflict;
  const changedElsewhere = latest.version !== base.version && dirty;
  const baseLine = (variantId: string) => base.lines.find((line) => line.variantId === variantId);
  const unavailable = base.lines.some((line) => !line.isAvailable);

  return (
    <>
      {(conflict || changedElsewhere) && (
        <div role="alert" className={catalogStyles.error} data-test="order-conflict">
          {conflict
            ? mutationMessage(save.error, "")
            : "Someone else saved this draft while you were editing. Reload to see their changes; your unsaved edits will be discarded."}{" "}
          <button className={catalogStyles.textButton} onClick={() => reload.mutate()} disabled={reload.isPending} data-test="order-reload">
            Reload latest
          </button>
        </div>
      )}
      {lines.length === 0 ? (
        <div className={catalogStyles.empty}>
          <h2>This draft is empty</h2>
          <p>Add items from the catalog: choose an edition, a quantity, and this draft.</p>
          <Link className={catalogStyles.secondary} to="/catalog" data-test="order-browse-catalog">
            Browse catalog
          </Link>
        </div>
      ) : (
        <div className={catalogStyles.tableScroll}>
          <table className={catalogStyles.table}>
            <caption className={catalogStyles.srOnly}>Draft items</caption>
            <thead>
              <tr>
                <th>Item</th>
                <th>SKU</th>
                <th className={styles.number}>Unit price</th>
                <th>Quantity</th>
                <th className={styles.number}>Line total</th>
                <th>
                  <span className={catalogStyles.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((local) => {
                const line = baseLine(local.variantId);
                if (!line) return null;
                const quantity = parseWholeNumber(local.quantity, false);
                const error = lineErrors[local.variantId];
                return (
                  <tr key={local.variantId} data-test="order-line" data-sku={line.sku}>
                    <td>
                      {line.productName}
                      <small className={styles.lineMeta}>
                        {languageLabel(line.language)} · {line.edition}
                        {line.isAvailable ? ` · ${line.availableQuantity ?? 0} available now` : ""}
                      </small>
                      {!line.isAvailable && (
                        <strong className={styles.unavailable} data-test="order-line-unavailable">
                          No longer available — remove to submit
                        </strong>
                      )}
                    </td>
                    <td>{line.sku}</td>
                    <td className={styles.number}>{formatPrice(line.unitPriceMinor)}</td>
                    <td>
                      <label className={catalogStyles.srOnly} htmlFor={`quantity-${line.variantId}`}>
                        Quantity of {line.sku}
                      </label>
                      <input
                        id={`quantity-${line.variantId}`}
                        className={styles.quantity}
                        inputMode="numeric"
                        value={local.quantity}
                        onChange={(event) => edit(local.variantId, event.target.value)}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? `quantity-error-${line.variantId}` : undefined}
                        disabled={save.isPending || submit.isPending}
                        data-test="order-line-quantity"
                      />
                      {error && (
                        <p className={catalogStyles.fieldError} id={`quantity-error-${line.variantId}`}>
                          {error}
                        </p>
                      )}
                    </td>
                    <td className={styles.number}>{quantity === undefined ? "—" : formatPrice(line.unitPriceMinor * quantity)}</td>
                    <td>
                      <button
                        className={catalogStyles.textButton}
                        onClick={() => edit(local.variantId, null)}
                        disabled={save.isPending || submit.isPending}
                        data-test="order-line-remove"
                      >
                        Remove<span className={catalogStyles.srOnly}> {line.sku}</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className={styles.total}>
        Estimated total <strong data-test="order-total">{formatPrice(base.totalMinor)}</strong>
        <small> Prices are provisional until you submit.</small>
      </p>

      {save.isError && !conflict && (
        <p role="alert" className={catalogStyles.error} data-test="order-save-error">
          {mutationMessage(save.error, "Could not confirm the save. Reload to check whether it was saved.")}
        </p>
      )}
      {save.isSuccess && !dirty && (
        <p role="status" className={catalogStyles.success} data-test="order-save-success">
          Draft saved.
        </p>
      )}
      {submit.isError && (
        <p role="alert" className={catalogStyles.error} data-test="order-submit-error">
          {mutationMessage(submit.error, "Could not confirm the submission. Submit again; it will not be applied twice.")}
        </p>
      )}

      <div className={styles.actions}>
        <button className={catalogStyles.secondary} onClick={onSave} disabled={!dirty || save.isPending} data-test="order-save">
          {save.isPending ? "Saving…" : "Save draft"}
        </button>
        <button
          className={catalogStyles.primary}
          onClick={() => setConfirming(true)}
          disabled={dirty || base.lines.length === 0 || unavailable || submit.isPending}
          data-test="order-submit"
        >
          Submit order
        </button>
        <CancelPanel order={base} version={base.version} />
      </div>
      {dirty && <p className={catalogStyles.muted}>Save your changes before submitting.</p>}

      {confirming && !dirty && (
        <section className={styles.panel} aria-labelledby="submit-heading" data-test="order-submit-panel">
          <h2 id="submit-heading">Submit {base.number}?</h2>
          <p>
            You are submitting {base.lines.length} {base.lines.length === 1 ? "item" : "items"} for{" "}
            <strong>{formatPrice(base.totalMinor)}</strong> at the prices shown. The distributor reviews the order next.
          </p>
          <p data-test="order-submit-no-reservation">
            <strong>Submitting does not reserve stock.</strong> Stock is reserved only when the distributor confirms the order.
          </p>
          <div className={styles.actions}>
            <button className={catalogStyles.primary} onClick={() => submit.mutate()} disabled={submit.isPending} data-test="order-submit-confirm">
              {submit.isPending ? "Submitting…" : "Confirm submission"}
            </button>
            <button className={catalogStyles.secondary} onClick={() => setConfirming(false)} disabled={submit.isPending}>
              Back to draft
            </button>
          </div>
        </section>
      )}
    </>
  );
}

function FrozenOrder({ order, canCancel }: { order: Order; canCancel: boolean }) {
  return (
    <>
      <div className={catalogStyles.tableScroll}>
        <table className={catalogStyles.table}>
          <caption className={catalogStyles.srOnly}>Ordered items</caption>
          <thead>
            <tr>
              <th>Item</th>
              <th>SKU</th>
              <th className={styles.number}>Unit price</th>
              <th className={styles.number}>Quantity</th>
              <th className={styles.number}>Line total</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((line) => (
              <tr key={line.id} data-test="order-line" data-sku={line.sku}>
                <td>
                  {line.productName}
                  <small className={styles.lineMeta}>
                    {languageLabel(line.language)} · {line.edition}
                  </small>
                </td>
                <td>{line.sku}</td>
                <td className={styles.number}>{formatPrice(line.unitPriceMinor)}</td>
                <td className={styles.number} data-test="order-line-quantity">
                  {line.quantity}
                </td>
                <td className={styles.number}>{formatPrice(line.lineTotalMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.total}>
        {order.priceStatus === "frozen" ? "Total" : "Estimated total"} <strong data-test="order-total">{formatPrice(order.totalMinor)}</strong>
        {order.priceStatus === "frozen" && <small> Prices were fixed at submission.</small>}
      </p>
      {canCancel && (
        <div className={styles.actions}>
          <CancelPanel order={order} version={order.version} />
        </div>
      )}
    </>
  );
}

function History({ order }: { order: Order }) {
  const events = [
    { label: "Created", by: order.createdBy.displayName, at: order.createdAt },
    ...(order.submittedAt && order.submittedBy ? [{ label: "Submitted", by: order.submittedBy.displayName, at: order.submittedAt }] : []),
    ...(order.cancelledAt && order.cancelledBy
      ? [{ label: order.cancellationReason ? `Cancelled: ${order.cancellationReason}` : "Cancelled", by: order.cancelledBy.displayName, at: order.cancelledAt }]
      : []),
  ];
  return (
    <section className={styles.history} aria-labelledby="order-history">
      <h2 id="order-history">History</h2>
      <ol data-test="order-history">
        {events.map((event) => (
          <li key={event.label}>
            <strong>{event.label}</strong> by {event.by} · <time dateTime={event.at}>{formatDate(event.at)}</time>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function OrderPage() {
  const { orderId = "" } = useParams();
  const order = useOrder(orderId);
  const session = useSession();
  const isRetailer = session.data?.user.role === "retailer";
  return (
    <>
      <Link className={catalogStyles.back} to="/orders">
        ← Back to orders
      </Link>
      {order.isPending && <p role="status">Loading order…</p>}
      {order.isError && (
        <p role="alert" className={catalogStyles.error}>
          {order.error instanceof ApiError && order.error.status === 404 ? "This order does not exist." : "Could not load this order."}{" "}
          <button className={catalogStyles.textButton} onClick={() => void order.refetch()}>
            Try again
          </button>
        </p>
      )}
      {order.data && (
        <>
          <div className={catalogStyles.heading}>
            <div>
              <p className={catalogStyles.eyebrow}>{order.data.organization.name.toUpperCase()}</p>
              <h1 data-test="order-number">{order.data.number}</h1>
              <p>
                <span className={styles.status} data-status={order.data.status} data-test="order-status">
                  {STATUS_LABELS[order.data.status]}
                </span>
              </p>
            </div>
          </div>
          {order.data.status === "draft" && isRetailer ? (
            <DraftEditor key={order.data.id} latest={order.data} />
          ) : (
            <FrozenOrder order={order.data} canCancel={isRetailer && order.data.status === "submitted"} />
          )}
          <History order={order.data} />
        </>
      )}
    </>
  );
}
