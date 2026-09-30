import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import type { CatalogProduct } from "@pandora/contracts";
import { formatPrice, languageLabel, useCatalog } from "./catalog-api";
import styles from "./Catalog.module.css";

export function ProductCover({ product }: { product: CatalogProduct }) {
  return (
    <div className={styles.cover} data-kind={product.type} aria-hidden="true">
      <span>PANDORA COLLECTION</span>
      <strong>{product.name}</strong>
      <span>{product.publisher}</span>
    </div>
  );
}

export function CatalogPage({ admin = false }: { admin?: boolean }) {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const catalog = useCatalog(params.toString(), admin);
  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next);
  }
  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    change("q", search);
  };
  return (
    <>
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>
            {admin ? "ADMINISTRATION" : "THE PANDORA COLLECTION"}
          </p>
          <h1>{admin ? "Manage catalog" : "Game catalog"}</h1>
          <p className={styles.muted}>
            {admin
              ? "Manage products, editions, prices, and visibility."
              : "Explore our games and find the right edition for your store."}
          </p>
        </div>
        {admin && (
          <Link
            className={styles.primary}
            to="/admin/catalog/new"
            data-test="product-create"
          >
            New product
          </Link>
        )}
      </div>
      <div className={styles.filters}>
        <form onSubmit={submitSearch} className={styles.search}>
          <label htmlFor="catalog-search">Search catalog</label>
          <div>
            <input
              id="catalog-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Product, publisher, or SKU"
              maxLength={120}
              data-test="catalog-search"
            />
            <button
              className={styles.secondary}
              data-test="catalog-search-submit"
            >
              Search
            </button>
          </div>
        </form>
        <label>
          Type
          <select
            value={params.get("type") ?? ""}
            onChange={(event) => change("type", event.target.value)}
            data-test="catalog-type"
          >
            <option value="">All games</option>
            <option value="base_game">Base games</option>
            <option value="expansion">Expansions</option>
          </select>
        </label>
        <label>
          Language
          <select
            value={params.get("language") ?? ""}
            onChange={(event) => change("language", event.target.value)}
            data-test="catalog-language"
          >
            <option value="">All languages</option>
            <option value="en">English</option>
            <option value="sr">Serbian</option>
          </select>
        </label>
        {admin && (
          <label>
            Status
            <select
              value={params.get("status") ?? "all"}
              onChange={(event) => change("status", event.target.value)}
              data-test="catalog-status"
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>
        )}
      </div>
      {catalog.isPending && <p role="status">Loading catalog…</p>}
      {catalog.isError && (
        <div role="alert" className={styles.error}>
          Could not load the catalog.{" "}
          <button
            className={styles.textButton}
            data-test="catalog-clear-invalid-filters"
            onClick={() => {
              setParams({});
              setSearch("");
            }}
          >
            Clear filters
          </button>
          <button
            className={styles.textButton}
            data-test="catalog-retry"
            onClick={() => void catalog.refetch()}
          >
            Try again
          </button>
        </div>
      )}
      {catalog.data && (
        <>
          <p className={styles.results} role="status" data-test="catalog-total">
            {catalog.data.total}{" "}
            {catalog.data.total === 1 ? "product" : "products"}
          </p>
          {!catalog.data.items.length ? (
            <div className={styles.empty}>
              <h2>No products found</h2>
              <p>Try another search or change your filters.</p>
              <button
                className={styles.secondary}
                data-test="catalog-clear-filters"
                onClick={() => {
                  setParams({});
                  setSearch("");
                }}
              >
                Clear filters
              </button>
            </div>
          ) : admin ? (
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <caption className={styles.srOnly}>Catalog management</caption>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Publisher</th>
                    <th>Type</th>
                    <th>Variants</th>
                    <th>Status</th>
                    <th>
                      <span className={styles.srOnly}>Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {catalog.data.items.map((product) => (
                    <tr
                      key={product.id}
                      data-product-id={product.id}
                      data-test="product-row"
                    >
                      <td>
                        <Link
                          to={`/admin/catalog/${product.id}`}
                          data-test="product-edit"
                        >
                          {product.name}
                        </Link>
                      </td>
                      <td>{product.publisher}</td>
                      <td>
                        {product.type === "base_game"
                          ? "Base game"
                          : "Expansion"}
                      </td>
                      <td>{product.variants.length}</td>
                      <td>{product.isActive ? "Active" : "Inactive"}</td>
                      <td>
                        <Link
                          to={`/admin/catalog/${product.id}`}
                          aria-label={`Edit ${product.name}`}
                        >
                          Edit →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={styles.grid}>
              {catalog.data.items.map((product) => (
                <article
                  className={styles.card}
                  key={product.id}
                  data-test="product-card"
                  data-product-id={product.id}
                >
                  <Link
                    to={`/catalog/${product.id}`}
                    className={styles.coverLink}
                    aria-label={`View ${product.name}`}
                    data-test="product-detail-link"
                  >
                    <ProductCover product={product} />
                  </Link>
                  <p className={styles.eyebrow}>
                    {product.type === "base_game" ? "BASE GAME" : "EXPANSION"}
                  </p>
                  <h2>
                    <Link to={`/catalog/${product.id}`}>{product.name}</Link>
                  </h2>
                  <p className={styles.muted}>{product.publisher}</p>
                  <ul className={styles.variantSummary}>
                    {product.variants.map((variant) => (
                      <li key={variant.id} data-sku={variant.sku}>
                        <span>
                          {languageLabel(variant.language)} · {variant.edition}
                        </span>
                        <span>{formatPrice(variant.unitPriceMinor)}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          )}
          <nav className={styles.pagination} aria-label="Catalog pages">
            <label>
              Per page
              <select
                value={catalog.data.pageSize}
                onChange={(event) => change("pageSize", event.target.value)}
                data-test="catalog-page-size"
              >
                <option>20</option>
                <option>50</option>
                <option>100</option>
              </select>
            </label>
            <span data-test="catalog-page">
              Page {catalog.data.page} of{" "}
              {Math.max(
                1,
                Math.ceil(catalog.data.total / catalog.data.pageSize),
              )}
            </span>
            <button
              className={styles.secondary}
              disabled={catalog.data.page <= 1}
              onClick={() => change("page", String(catalog.data.page - 1))}
              data-test="catalog-previous"
            >
              Previous
            </button>
            <button
              className={styles.secondary}
              disabled={
                catalog.data.page * catalog.data.pageSize >= catalog.data.total
              }
              onClick={() => change("page", String(catalog.data.page + 1))}
              data-test="catalog-next"
            >
              Next
            </button>
          </nav>
        </>
      )}
    </>
  );
}
