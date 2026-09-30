import { useState } from "react";
import { Link, useParams } from "react-router";
import type { CatalogProduct } from "@pandora/contracts";
import { ApiError } from "../../lib/api-client";
import { formatPrice, languageLabel, useProduct } from "./catalog-api";
import { ProductCover } from "./CatalogPage";
import styles from "./Catalog.module.css";

function ProductDetails({ product }: { product: CatalogProduct }) {
  const [variantId, setVariantId] = useState("");
  const variant = product.variants.find((item) => item.id === variantId);
  return (
    <div className={styles.detail}>
      <ProductCover product={product} />
      <section>
        <p className={styles.eyebrow}>
          {product.type === "base_game" ? "BASE GAME" : "EXPANSION"}
        </p>
        <h1>{product.name}</h1>
        <p className={styles.publisher}>{product.publisher}</p>
        <p className={styles.description}>{product.description}</p>
        {product.baseProduct && (
          <p className={styles.relationship}>
            Expansion for{" "}
            {product.baseProduct.isVisible ? (
              <Link
                data-test="base-product-link"
                to={`/catalog/${product.baseProduct.id}`}
              >
                {product.baseProduct.name}
              </Link>
            ) : (
              product.baseProduct.name
            )}
            .
          </p>
        )}
        <label className={styles.field}>
          Choose an edition
          <select
            value={variant?.id ?? ""}
            onChange={(event) => setVariantId(event.target.value)}
            data-test="variant-select"
          >
            <option value="">Select language and edition</option>
            {product.variants.map((item) => (
              <option key={item.id} value={item.id}>
                {languageLabel(item.language)} · {item.edition} · {item.sku}
              </option>
            ))}
          </select>
        </label>
        {variant ? (
          <div
            className={styles.selection}
            data-test="selected-variant"
            data-sku={variant.sku}
            role="status"
          >
            <strong className={styles.price}>
              {formatPrice(variant.unitPriceMinor)}
            </strong>
            <dl>
              <div>
                <dt>SKU</dt>
                <dd>{variant.sku}</dd>
              </div>
              <div>
                <dt>Language</dt>
                <dd>{languageLabel(variant.language)}</dd>
              </div>
              <div>
                <dt>Edition</dt>
                <dd>{variant.edition}</dd>
              </div>
              <div>
                <dt>Available</dt>
                <dd data-test="variant-available">
                  {variant.availableQuantity}
                </dd>
              </div>
            </dl>
            <p className={styles.muted} data-test="availability-note">
              Availability is not reserved until your order is confirmed.
            </p>
          </div>
        ) : (
          <p className={styles.muted}>
            Select an edition to view its price and SKU.
          </p>
        )}
      </section>
    </div>
  );
}
export function ProductPage() {
  const { productId = "" } = useParams();
  const product = useProduct(productId);
  return (
    <>
      <Link className={styles.back} to="/catalog">
        ← Back to catalog
      </Link>
      {product.isPending && <p role="status">Loading product…</p>}
      {product.isError && (
        <p role="alert">
          {product.error instanceof ApiError && product.error.status === 404
            ? "This product is not available."
            : "Could not load this product."}{" "}
          <button
            className={styles.textButton}
            onClick={() => void product.refetch()}
          >
            Try again
          </button>
        </p>
      )}
      {product.data && (
        <ProductDetails key={product.data.id} product={product.data} />
      )}
    </>
  );
}
