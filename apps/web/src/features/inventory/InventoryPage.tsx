import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { languageLabel } from "../catalog/catalog-api";
import catalogStyles from "../catalog/Catalog.module.css";
import { useInventory } from "./inventory-api";
import styles from "./Inventory.module.css";

export function InventoryPage() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const inventory = useInventory(params.toString());

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
  const clearFilters = () => {
    setParams({});
    setSearch("");
  };

  return (
    <>
      <div className={catalogStyles.heading}>
        <div>
          <p className={catalogStyles.eyebrow}>WAREHOUSE</p>
          <h1>Inventory</h1>
          <p className={catalogStyles.muted}>Stock for every SKU. Record receipts and adjustments from an item's page.</p>
        </div>
      </div>

      <div className={catalogStyles.filters}>
        <form onSubmit={submitSearch} className={catalogStyles.search}>
          <label htmlFor="inventory-search">Search inventory</label>
          <div>
            <input
              id="inventory-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="SKU or product name"
              maxLength={120}
              data-test="inventory-search"
            />
            <button className={catalogStyles.secondary} data-test="inventory-search-submit">
              Search
            </button>
          </div>
        </form>
        <label>
          Stock
          <select
            value={params.get("stock") ?? "all"}
            onChange={(event) => change("stock", event.target.value === "all" ? "" : event.target.value)}
            data-test="inventory-stock-filter"
          >
            <option value="all">All items</option>
            <option value="available">Available</option>
            <option value="unavailable">Unavailable</option>
          </select>
        </label>
      </div>

      {inventory.isPending && <p role="status">Loading inventory…</p>}
      {inventory.isError && (
        <div role="alert" className={catalogStyles.error}>
          Could not load inventory.{" "}
          <button className={catalogStyles.textButton} onClick={clearFilters}>
            Clear filters
          </button>
          <button
            className={catalogStyles.textButton}
            data-test="inventory-retry"
            onClick={() => void inventory.refetch()}
          >
            Try again
          </button>
        </div>
      )}
      {inventory.data && (
        <>
          <p className={catalogStyles.results} role="status" data-test="inventory-total">
            {inventory.data.total} {inventory.data.total === 1 ? "item" : "items"}
          </p>
          {!inventory.data.items.length ? (
            <div className={catalogStyles.empty}>
              <h2>No inventory items found</h2>
              <p>Try another search or change the stock filter.</p>
              <button className={catalogStyles.secondary} data-test="inventory-clear-filters" onClick={clearFilters}>
                Clear filters
              </button>
            </div>
          ) : (
            <div className={catalogStyles.tableScroll}>
              <table className={catalogStyles.table}>
                <caption className={catalogStyles.srOnly}>Inventory by SKU</caption>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Product</th>
                    <th>Edition</th>
                    <th className={styles.number}>Sellable</th>
                    <th className={styles.number}>Reserved</th>
                    <th className={styles.number}>Damaged</th>
                    <th className={styles.number}>Available</th>
                    <th>Catalog</th>
                  </tr>
                </thead>
                <tbody>
                  {inventory.data.items.map((item) => (
                    <tr key={item.variantId} data-test="inventory-row" data-sku={item.sku}>
                      <td>
                        <Link to={`/inventory/${item.variantId}`} data-test="inventory-detail-link">
                          {item.sku}
                        </Link>
                      </td>
                      <td>{item.product.name}</td>
                      <td>
                        {languageLabel(item.language)} · {item.edition}
                      </td>
                      <td className={styles.number}>{item.sellable}</td>
                      <td className={styles.number}>{item.reserved}</td>
                      <td className={styles.number}>{item.damaged}</td>
                      <td className={styles.number} data-zero={item.available === 0 || undefined}>
                        {item.available}
                      </td>
                      <td>{item.product.isActive && item.variantIsActive ? "Visible" : "Hidden"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <nav className={catalogStyles.pagination} aria-label="Inventory pages">
            <label>
              Per page
              <select
                value={inventory.data.pageSize}
                onChange={(event) => change("pageSize", event.target.value)}
                data-test="inventory-page-size"
              >
                <option>20</option>
                <option>50</option>
                <option>100</option>
              </select>
            </label>
            <span data-test="inventory-page">
              Page {inventory.data.page} of {Math.max(1, Math.ceil(inventory.data.total / inventory.data.pageSize))}
            </span>
            <button
              className={catalogStyles.secondary}
              disabled={inventory.data.page <= 1}
              onClick={() => change("page", String(inventory.data.page - 1))}
              data-test="inventory-previous"
            >
              Previous
            </button>
            <button
              className={catalogStyles.secondary}
              disabled={inventory.data.page * inventory.data.pageSize >= inventory.data.total}
              onClick={() => change("page", String(inventory.data.page + 1))}
              data-test="inventory-next"
            >
              Next
            </button>
          </nav>
        </>
      )}
    </>
  );
}
