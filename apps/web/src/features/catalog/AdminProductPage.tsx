import { useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import type { CatalogProduct } from "@pandora/contracts";
import { formatPrice, languageLabel, useProduct } from "./catalog-api";
import { ProductForm } from "./ProductForm";
import { VariantForm } from "./VariantForm";
import styles from "./Catalog.module.css";

function ProductEditor({ product }: { product: CatalogProduct }) {
  const [editing, setEditing] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const selected = product.variants.find((variant) => variant.id === editing);
  function close() {
    setEditing(null);
    requestAnimationFrame(() => trigger.current?.focus());
  }
  return (
    <div className={styles.editor}>
      <ProductForm product={product} />
      <section className={styles.variants}>
        <div className={styles.sectionHeading}>
          <div>
            <h2>Variants</h2>
            <p className={styles.muted}>
              Language, edition, and price per SKU.
            </p>
          </div>
          <button
            className={styles.secondary}
            onClick={(event) => {
              trigger.current = event.currentTarget;
              setEditing("new");
            }}
            disabled={editing !== null}
            data-test="variant-create"
          >
            Add variant
          </button>
        </div>
        {!product.variants.length && (
          <p className={styles.empty}>
            Add a variant to make this product available in the catalog.
          </p>
        )}
        <ul className={styles.variantList}>
          {product.variants.map((variant) => (
            <li key={variant.id} data-sku={variant.sku} data-test="variant-row">
              <div>
                <strong>{variant.sku}</strong>
                <p>
                  {languageLabel(variant.language)} · {variant.edition}
                </p>
                <span className={styles.muted}>
                  {variant.isActive ? "Active" : "Inactive"}
                </span>
              </div>
              <div>
                <strong>{formatPrice(variant.unitPriceMinor)}</strong>
                <button
                  className={styles.textButton}
                  disabled={editing !== null}
                  onClick={(event) => {
                    trigger.current = event.currentTarget;
                    setEditing(variant.id);
                  }}
                  aria-label={`Edit ${variant.sku}`}
                  data-test="variant-edit"
                >
                  Edit
                </button>
              </div>
            </li>
          ))}
        </ul>
        {editing && (
          <VariantForm
            key={editing}
            productId={product.id}
            {...(selected ? { variant: selected } : {})}
            onClose={close}
          />
        )}
      </section>
    </div>
  );
}
export function AdminProductPage({ create = false }: { create?: boolean }) {
  const { productId = "" } = useParams();
  const product = useProduct(productId, true);
  const location = useLocation();
  const created =
    typeof location.state === "object" &&
    location.state !== null &&
    "created" in location.state &&
    location.state.created === true;
  return (
    <>
      <Link className={styles.back} to="/admin/catalog">
        ← Manage catalog
      </Link>
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>ADMINISTRATION</p>
          <h1>
            {create
              ? "Create a product"
              : (product.data?.name ?? "Edit product")}
          </h1>
        </div>
        {product.data?.isActive &&
          product.data.variants.some((variant) => variant.isActive) && (
            <Link
              className={styles.secondary}
              data-test="product-preview"
              to={`/catalog/${productId}`}
            >
              View in catalog
            </Link>
          )}
      </div>
      {create ? (
        <ProductForm />
      ) : (
        <>
          {created && product.data?.variants.length === 0 && (
            <p className={styles.success} role="status">
              Product created. Add a variant to complete the listing.
            </p>
          )}
          {product.isPending && <p role="status">Loading product…</p>}
          {product.isError && (
            <p role="alert">
              Could not load this product.{" "}
              <button onClick={() => void product.refetch()}>Try again</button>
            </p>
          )}
          {product.data && (
            <ProductEditor key={product.data.id} product={product.data} />
          )}
        </>
      )}
    </>
  );
}
