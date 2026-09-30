import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  createVariantSchema,
  type CatalogVariant,
  type CreateVariant,
  type UpdateVariant,
} from "@pandora/contracts";
import {
  createVariant,
  updateVariant,
  parsePrice,
  priceInput,
  useExpiredSession,
} from "./catalog-api";
import { CatalogFormField } from "./CatalogFormField";
import { errorFields, mutationMessage } from "./form-errors";
import styles from "./Catalog.module.css";

export function VariantForm({
  productId,
  variant,
  onClose,
}: {
  productId: string;
  variant?: CatalogVariant;
  onClose: () => void;
}) {
  const [baseline, setBaseline] = useState(variant);
  const [sku, setSku] = useState(variant?.sku ?? "");
  const [language, setLanguage] = useState(variant?.language ?? "en");
  const [edition, setEdition] = useState(variant?.edition ?? "Standard");
  const [price, setPrice] = useState(
    variant ? priceInput(variant.unitPriceMinor) : "",
  );
  const [active, setActive] = useState(variant?.isActive ?? true);
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (input: CreateVariant) => {
      if (!variant || !baseline) return createVariant(productId, input);
      const patch: UpdateVariant = {};
      if (input.language !== baseline.language) patch.language = input.language;
      if (input.edition !== baseline.edition) patch.edition = input.edition;
      if (input.unitPriceMinor !== baseline.unitPriceMinor)
        patch.unitPriceMinor = input.unitPriceMinor;
      if (input.isActive !== baseline.isActive) patch.isActive = input.isActive;
      return Object.keys(patch).length
        ? updateVariant(productId, variant.id, patch)
        : Promise.resolve(variant);
    },
    onSuccess: async (saved) => {
      setBaseline(saved);
      setSku(saved.sku);
      setEdition(saved.edition);
      setPrice(priceInput(saved.unitPriceMinor));
      await client.invalidateQueries({ queryKey: ["catalog"] });
      // A created variant remains visible with a success state; it cannot be accidentally created again.
    },
  });
  useExpiredSession(save.error);
  const errors = { ...errorFields(save.error), ...localErrors };
  function submit(event: FormEvent) {
    event.preventDefault();
    setLocalErrors({});
    const unitPriceMinor = parsePrice(price);
    if (unitPriceMinor === undefined) {
      setLocalErrors({
        unitPriceMinor:
          "Enter an amount from 0 to 21,474,836.47 with at most two decimals.",
      });
      return;
    }
    const parsed = createVariantSchema.safeParse({
      sku,
      language,
      edition,
      unitPriceMinor,
      isActive: active,
    });
    if (!parsed.success) {
      setLocalErrors(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [
            issue.path.join("."),
            issue.message,
          ]),
        ),
      );
      return;
    }
    save.mutate(parsed.data);
  }
  return (
    <form
      className={styles.form}
      onSubmit={submit}
      noValidate
      data-test="variant-form"
    >
      <h3>{variant ? `Edit ${variant.sku}` : "New variant"}</h3>
      {save.isError && (
        <p role="alert" className={styles.error}>
          {mutationMessage(save.error)}
        </p>
      )}
      {Object.keys(localErrors).length > 0 && (
        <p role="alert" className={styles.error}>
          Please correct the highlighted fields.
        </p>
      )}
      {save.isSuccess && (
        <p role="status" className={styles.success}>
          Variant saved.
        </p>
      )}
      <fieldset
        className={styles.fields}
        disabled={save.isPending || (!variant && save.isSuccess)}
      >
        <CatalogFormField
          name="sku"
          label="SKU"
          value={sku}
          onChange={setSku}
          error={errors.sku}
          maxLength={40}
          disabled={!!variant}
        />
        <div className={styles.formColumns}>
          <CatalogFormField
            name="language"
            label="Language"
            type="select"
            value={language}
            onChange={(value) => setLanguage(value === "sr" ? "sr" : "en")}
            options={[
              { value: "en", label: "English" },
              { value: "sr", label: "Serbian" },
            ]}
            error={errors.language}
          />
          <CatalogFormField
            name="edition"
            label="Edition"
            value={edition}
            onChange={setEdition}
            maxLength={80}
            error={errors.edition}
          />
        </div>
        <CatalogFormField
          name="unitPriceMinor"
          label="Unit price (EUR)"
          value={price}
          onChange={setPrice}
          error={errors.unitPriceMinor}
        />
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
            data-test="variant-active"
          />
          Active variant
        </label>
      </fieldset>
      <div className={styles.actions}>
        <button
          className={styles.primary}
          disabled={save.isPending || (!variant && save.isSuccess)}
          data-test="variant-save"
        >
          {save.isPending ? "Saving…" : "Save variant"}
        </button>
        <button
          className={styles.secondary}
          type="button"
          onClick={onClose}
          disabled={save.isPending}
        >
          {save.isSuccess ? "Done" : "Cancel"}
        </button>
      </div>
    </form>
  );
}
