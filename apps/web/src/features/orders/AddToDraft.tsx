import { MAX_LINE_QUANTITY, type Order } from "@pandora/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../../lib/api-client";
import catalogStyles from "../catalog/Catalog.module.css";
import { parseWholeNumber } from "../inventory/inventory-api";
import { ORDERS_QUERY_KEY, createOrder, fetchOrder, saveOrderLines, useOrders } from "./orders-api";
import styles from "./Orders.module.css";

const NEW_DRAFT = "new";

/** Adds the selected variant to an existing draft (merging quantities) or to a new draft. */
export function AddToDraft({ variantId, sku }: { variantId: string; sku: string }) {
  const drafts = useOrders("status=draft&pageSize=100");
  const client = useQueryClient();
  const quantityId = useId();
  const targetId = useId();
  const [quantity, setQuantity] = useState("1");
  const [target, setTarget] = useState<string | null>(null);
  const [quantityError, setQuantityError] = useState("");
  const [added, setAdded] = useState<{ order: Order; quantity: number } | null>(null);
  // Only draft creation needs a key; adding to an existing draft is protected by its version.
  const [createKey, setCreateKey] = useState(() => crypto.randomUUID());
  const selected = target ?? drafts.data?.items[0]?.id ?? NEW_DRAFT;

  const add = useMutation({
    mutationFn: async (amount: number): Promise<Order> => {
      if (selected === NEW_DRAFT) {
        return createOrder({ lines: [{ variantId, quantity: amount }] }, createKey);
      }
      const draft = await fetchOrder(selected);
      const lines = draft.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity }));
      const existing = lines.find((line) => line.variantId === variantId);
      if (existing) existing.quantity += amount;
      else lines.push({ variantId, quantity: amount });
      return saveOrderLines(selected, { version: draft.version, lines });
    },
    onSuccess: async (order, amount) => {
      setAdded({ order, quantity: amount });
      setTarget(order.id);
      setCreateKey(crypto.randomUUID());
      await client.invalidateQueries({ queryKey: ORDERS_QUERY_KEY });
    },
  });
  const changed = () => {
    setAdded(null);
    add.reset();
    setCreateKey(crypto.randomUUID());
  };
  const onAdd = () => {
    const amount = parseWholeNumber(quantity, false);
    if (amount === undefined || amount < 1 || amount > MAX_LINE_QUANTITY) {
      setQuantityError(`Enter a whole number from 1 to ${MAX_LINE_QUANTITY.toLocaleString("en")}.`);
      return;
    }
    setQuantityError("");
    add.mutate(amount);
  };

  let failure = "";
  if (add.isError) {
    failure =
      add.error instanceof ApiError
        ? add.error.status === 409
          ? "The draft changed or can no longer be edited. Choose the draft again and retry."
          : add.error.status === 422
            ? `Could not add: ${add.error.details.map((detail) => detail.message).join(" ")}`
            : add.error.message
        : "Could not confirm the change. Check the draft before trying again.";
  }

  return (
    <section className={styles.panel} aria-labelledby={`${quantityId}-heading`} data-test="add-to-draft-panel">
      <h2 id={`${quantityId}-heading`}>Add {sku} to an order</h2>
      <div className={catalogStyles.field}>
        <label htmlFor={quantityId}>Quantity</label>
        <input
          id={quantityId}
          className={styles.quantity}
          inputMode="numeric"
          value={quantity}
          onChange={(event) => {
            setQuantity(event.target.value);
            changed();
          }}
          aria-invalid={quantityError ? true : undefined}
          aria-describedby={quantityError ? `${quantityId}-error` : undefined}
          data-test="add-quantity"
        />
        {quantityError && (
          <p className={catalogStyles.fieldError} id={`${quantityId}-error`}>
            {quantityError}
          </p>
        )}
      </div>
      <div className={catalogStyles.field}>
        <label htmlFor={targetId}>Draft</label>
        <select
          id={targetId}
          value={selected}
          onChange={(event) => {
            setTarget(event.target.value);
            changed();
          }}
          disabled={drafts.isPending}
          data-test="add-draft-select"
        >
          {drafts.data?.items.map((draft) => (
            <option key={draft.id} value={draft.id}>
              {draft.number} · {draft.lineCount} {draft.lineCount === 1 ? "item" : "items"}
            </option>
          ))}
          <option value={NEW_DRAFT}>New draft</option>
        </select>
      </div>
      {failure && (
        <p role="alert" className={catalogStyles.error} data-test="add-to-draft-error">
          {failure}
        </p>
      )}
      {added && (
        <p role="status" className={catalogStyles.success} data-test="add-to-draft-success">
          Added {added.quantity} × {sku} to{" "}
          <Link to={`/orders/${added.order.id}`} data-test="add-to-draft-link">
            {added.order.number}
          </Link>
          . Adding to a draft does not reserve stock.
        </p>
      )}
      <div>
        <button className={catalogStyles.primary} onClick={onAdd} disabled={add.isPending || drafts.isPending} data-test="add-to-draft">
          {add.isPending ? "Adding…" : "Add to draft"}
        </button>
      </div>
    </section>
  );
}
