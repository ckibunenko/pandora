import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  createProductSchema,
  type CatalogProduct,
  type CreateProduct,
  type UpdateProduct,
} from "@pandora/contracts";
import { useNavigate } from "react-router";
import {
  createProduct,
  updateProduct,
  useCatalog,
  useExpiredSession,
} from "./catalog-api";
import { CatalogFormField } from "./CatalogFormField";
import { errorFields, mutationMessage } from "./form-errors";
import styles from "./Catalog.module.css";

function BaseGamePicker({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (id: string) => void;
  error?: string | undefined;
}) {
  const [page, setPage] = useState(1);
  const bases = useCatalog(`type=base_game&pageSize=100&page=${page}`, true);
  return (
    <div>
      <CatalogFormField
        name="baseProductId"
        label="Base game"
        type="select"
        value={value}
        onChange={onChange}
        error={error}
        options={[
          { value: "", label: "Select a base game" },
          ...(value &&
          !bases.data?.items.some((product) => product.id === value)
            ? [{ value, label: "Selected base game (another page)" }]
            : []),
          ...(bases.data?.items.map((product) => ({
            value: product.id,
            label: `${product.name}${product.isActive ? "" : " (inactive)"}`,
          })) ?? []),
        ]}
      />
      {bases.isPending && <p role="status">Loading base games…</p>}
      {bases.isError && (
        <p role="alert">
          Could not load base games.{" "}
          <button type="button" onClick={() => void bases.refetch()}>
            Retry
          </button>
        </p>
      )}
      {bases.data && bases.data.total > 100 && (
        <div className={styles.actions}>
          <button
            type="button"
            data-test="base-product-previous"
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            Previous base games
          </button>
          <span>Page {page}</span>
          <button
            type="button"
            data-test="base-product-next"
            disabled={page * 100 >= bases.data.total}
            onClick={() => setPage(page + 1)}
          >
            Next base games
          </button>
        </div>
      )}
    </div>
  );
}

export function ProductForm({ product }: { product?: CatalogProduct }) {
  const [baseline, setBaseline] = useState(product);
  const [name, setName] = useState(product?.name ?? "");
  const [publisher, setPublisher] = useState(product?.publisher ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [type, setType] = useState(product?.type ?? "base_game");
  const [baseProductId, setBaseProductId] = useState(
    product?.baseProduct?.id ?? "",
  );
  const [isActive, setIsActive] = useState(product?.isActive ?? true);
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const client = useQueryClient();
  const navigate = useNavigate();
  const save = useMutation({
    mutationFn: (input: CreateProduct) => {
      if (!product || !baseline) return createProduct(input);
      const patch: UpdateProduct = {};
      if (input.name !== baseline.name) patch.name = input.name;
      if (input.publisher !== baseline.publisher)
        patch.publisher = input.publisher;
      if (input.description !== baseline.description)
        patch.description = input.description;
      if (input.isActive !== baseline.isActive) patch.isActive = input.isActive;
      return Object.keys(patch).length
        ? updateProduct(product.id, patch)
        : Promise.resolve(product);
    },
    onSuccess: async (saved) => {
      setBaseline(saved);
      setName(saved.name);
      setPublisher(saved.publisher);
      setDescription(saved.description);
      setIsActive(saved.isActive);
      await client.invalidateQueries({ queryKey: ["catalog"] });
      if (!product)
        void navigate(`/admin/catalog/${saved.id}`, {
          replace: true,
          state: { created: true },
        });
    },
  });
  useExpiredSession(save.error);
  const errors = { ...errorFields(save.error), ...localErrors };
  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = createProductSchema.safeParse({
      name,
      publisher,
      description,
      type,
      baseProductId: type === "expansion" ? baseProductId : null,
      isActive,
    });
    setLocalErrors({});
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
      onSubmit={submit}
      className={styles.form}
      noValidate
      data-test="product-form"
    >
      <h2>{product ? "Product details" : "New product"}</h2>
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
          Product saved.
        </p>
      )}
      <fieldset disabled={save.isPending} className={styles.fields}>
        <CatalogFormField
          name="name"
          label="Product name"
          value={name}
          onChange={setName}
          maxLength={120}
          error={errors.name}
        />
        <CatalogFormField
          name="publisher"
          label="Publisher"
          value={publisher}
          onChange={setPublisher}
          maxLength={120}
          error={errors.publisher}
        />
        <CatalogFormField
          name="description"
          label="Description"
          type="textarea"
          value={description}
          onChange={setDescription}
          maxLength={2000}
          error={errors.description}
        />
        {product ? (
          <p className={styles.muted}>
            {product.type === "base_game"
              ? "Base game"
              : `Expansion for ${product.baseProduct?.name}`}
            . Product type and base game cannot be changed.
          </p>
        ) : (
          <>
            <CatalogFormField
              name="type"
              label="Product type"
              type="select"
              value={type}
              onChange={(value) =>
                setType(value === "expansion" ? "expansion" : "base_game")
              }
              options={[
                { value: "base_game", label: "Base game" },
                { value: "expansion", label: "Expansion" },
              ]}
            />
            {type === "expansion" && (
              <BaseGamePicker
                value={baseProductId}
                onChange={setBaseProductId}
                error={errors.baseProductId}
              />
            )}
          </>
        )}
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={isActive}
            onChange={(event) => setIsActive(event.target.checked)}
            data-test="product-active"
          />
          Active product
        </label>
        <p className={styles.muted}>
          An active product appears in the catalog once it has an active
          variant.
        </p>
      </fieldset>
      <button
        className={styles.primary}
        disabled={save.isPending}
        data-test="product-save"
      >
        {save.isPending
          ? "Saving…"
          : product
            ? "Save product"
            : "Create product"}
      </button>
    </form>
  );
}
