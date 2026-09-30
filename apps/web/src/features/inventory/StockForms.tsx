import { MAX_STOCK_CHANGE, type StockBucket, type StockChangeResponse } from "@pandora/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import catalogStyles from "../catalog/Catalog.module.css";
import { CatalogFormField } from "../catalog/CatalogFormField";
import { errorFields } from "../catalog/form-errors";
import { ApiError } from "../../lib/api-client";
import { INVENTORY_QUERY_KEY, parseWholeNumber, postAdjustment, postReceipt } from "./inventory-api";

function stockErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 422) return "Please correct the highlighted fields.";
    return error.message;
  }
  // The request may have been applied; resubmitting reuses the same key, so it cannot apply twice.
  return "Could not confirm the change. Submit again to retry safely.";
}

/**
 * One idempotency key per intended change: it survives retries of the same input
 * and is replaced when the input changes or after a success.
 */
function useIdempotencyKey() {
  const [key, setKey] = useState(() => crypto.randomUUID());
  return { key, renew: () => setKey(crypto.randomUUID()) };
}

function useStockMutation(
  submit: (key: string) => Promise<StockChangeResponse>,
  onDone: (result: StockChangeResponse) => void,
) {
  const client = useQueryClient();
  const idempotency = useIdempotencyKey();
  const mutation = useMutation({
    mutationFn: () => submit(idempotency.key),
    onSuccess: async (result) => {
      idempotency.renew();
      onDone(result);
      await Promise.all([
        client.invalidateQueries({ queryKey: INVENTORY_QUERY_KEY }),
        client.invalidateQueries({ queryKey: ["catalog"] }),
      ]);
    },
  });
  /** Call when the user edits the input: it is a new intended change, so earlier outcomes no longer apply. */
  const inputChanged = () => {
    idempotency.renew();
    mutation.reset();
  };
  return { mutation, inputChanged };
}

export function ReceiptForm({ variantId }: { variantId: string }) {
  const [quantity, setQuantity] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState("");
  const { mutation, inputChanged } = useStockMutation(
    (key) =>
      postReceipt(
        variantId,
        {
          quantity: Number(quantity.trim()),
          ...(reference.trim() ? { reference: reference.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        key,
      ),
    (result) => {
      setSuccess(`Received ${result.movement.delta} units. Sellable stock is now ${result.item.sellable}.`);
      setQuantity("");
      setReference("");
      setNote("");
    },
  );
  const edit = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setSuccess("");
    inputChanged();
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseWholeNumber(quantity, false);
    if (parsed === undefined || parsed < 1 || parsed > MAX_STOCK_CHANGE) {
      setLocalErrors({ quantity: `Enter a whole number from 1 to ${MAX_STOCK_CHANGE.toLocaleString("en")}.` });
      return;
    }
    setLocalErrors({});
    mutation.mutate();
  };
  const errors = { ...errorFields(mutation.error), ...localErrors };

  return (
    <form className={catalogStyles.form} onSubmit={onSubmit} data-test="receipt-form" noValidate>
      <h2>Receive stock</h2>
      <fieldset className={catalogStyles.fields} disabled={mutation.isPending}>
        <legend className={catalogStyles.srOnly}>Stock receipt</legend>
        <CatalogFormField name="quantity" label="Quantity received" value={quantity} onChange={edit(setQuantity)} error={errors["quantity"]} maxLength={7} />
        <CatalogFormField name="reference" label="Delivery reference (optional)" value={reference} onChange={edit(setReference)} error={errors["reference"]} maxLength={80} />
        <CatalogFormField name="note" label="Note (optional)" type="textarea" value={note} onChange={edit(setNote)} error={errors["note"]} maxLength={500} />
      </fieldset>
      {mutation.isError && (
        <p role="alert" className={catalogStyles.error} data-test="receipt-error">
          {stockErrorMessage(mutation.error)}
        </p>
      )}
      {success && (
        <p role="status" className={catalogStyles.success} data-test="receipt-success">
          {success}
        </p>
      )}
      <button className={catalogStyles.primary} disabled={mutation.isPending} data-test="receipt-submit">
        {mutation.isPending ? "Recording…" : "Record receipt"}
      </button>
    </form>
  );
}

export function AdjustmentForm({ variantId }: { variantId: string }) {
  const [bucket, setBucket] = useState<StockBucket>("sellable");
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState("");
  const { mutation, inputChanged } = useStockMutation(
    (key) => postAdjustment(variantId, { bucket, delta: Number(delta.trim()), reason: reason.trim() }, key),
    (result) => {
      const change = result.movement.delta > 0 ? `+${result.movement.delta}` : String(result.movement.delta);
      setSuccess(
        `Adjusted ${result.movement.bucket} stock by ${change}. Sellable ${result.item.sellable}, damaged ${result.item.damaged}.`,
      );
      setDelta("");
      setReason("");
    },
  );
  const edit = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setSuccess("");
    inputChanged();
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    const parsed = parseWholeNumber(delta, true);
    if (parsed === undefined || parsed === 0 || Math.abs(parsed) > MAX_STOCK_CHANGE) {
      nextErrors["delta"] = "Enter a non-zero whole number, for example -3 or 5.";
    }
    if (reason.trim().length < 3) {
      nextErrors["reason"] = "Describe the reason in at least 3 characters.";
    }
    setLocalErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) {
      mutation.mutate();
    }
  };
  const errors = { ...errorFields(mutation.error), ...localErrors };

  return (
    <form className={catalogStyles.form} onSubmit={onSubmit} data-test="adjustment-form" noValidate>
      <h2>Adjust stock</h2>
      <fieldset className={catalogStyles.fields} disabled={mutation.isPending}>
        <legend className={catalogStyles.srOnly}>Stock adjustment</legend>
        <CatalogFormField
          name="bucket"
          label="Stock type"
          type="select"
          value={bucket}
          onChange={edit((value) => setBucket(value === "damaged" ? "damaged" : "sellable"))}
          options={[
            { value: "sellable", label: "Sellable" },
            { value: "damaged", label: "Damaged" },
          ]}
          error={errors["bucket"]}
        />
        <CatalogFormField name="delta" label="Change (use - to remove units)" value={delta} onChange={edit(setDelta)} error={errors["delta"]} maxLength={8} />
        <CatalogFormField name="reason" label="Reason" type="textarea" value={reason} onChange={edit(setReason)} error={errors["reason"]} maxLength={500} />
      </fieldset>
      {mutation.isError && (
        <p role="alert" className={catalogStyles.error} data-test="adjustment-error">
          {stockErrorMessage(mutation.error)}
        </p>
      )}
      {success && (
        <p role="status" className={catalogStyles.success} data-test="adjustment-success">
          {success}
        </p>
      )}
      <button className={catalogStyles.primary} disabled={mutation.isPending} data-test="adjustment-submit">
        {mutation.isPending ? "Recording…" : "Record adjustment"}
      </button>
    </form>
  );
}
