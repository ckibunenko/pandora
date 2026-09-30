import type { InventoryItem, InventoryMovement } from "@pandora/contracts";
import { useState } from "react";
import { Link, Outlet, useParams } from "react-router";
import { ApiError } from "../../lib/api-client";
import { useSession } from "../auth/session";
import { languageLabel } from "../catalog/catalog-api";
import catalogStyles from "../catalog/Catalog.module.css";
import { useInventoryItem, useMovements } from "./inventory-api";
import styles from "./Inventory.module.css";
import { AdjustmentForm, ReceiptForm } from "./StockForms";

const MOVEMENT_LABELS: Record<InventoryMovement["type"], string> = {
  opening_balance: "Opening balance",
  receipt: "Receipt",
  adjustment: "Adjustment",
};

const signed = (value: number) => (value > 0 ? `+${value}` : String(value));

function StockSummary({ item }: { item: InventoryItem }) {
  const figures = [
    { key: "sellable", label: "Sellable", value: item.sellable },
    { key: "reserved", label: "Reserved", value: item.reserved },
    { key: "damaged", label: "Damaged", value: item.damaged },
    { key: "available", label: "Available", value: item.available },
  ] as const;
  return (
    <dl className={styles.summary}>
      {figures.map((figure) => (
        <div key={figure.key}>
          <dt>{figure.label}</dt>
          <dd data-test={`stock-${figure.key}`}>{figure.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function MovementHistory({ variantId }: { variantId: string }) {
  const [page, setPage] = useState(1);
  const movements = useMovements(variantId, page);
  return (
    <section className={styles.history} aria-labelledby="movement-history">
      <h2 id="movement-history">Movement history</h2>
      {movements.isPending && <p role="status">Loading movements…</p>}
      {movements.isError && (
        <p role="alert" className={catalogStyles.error}>
          Could not load movements.{" "}
          <button className={catalogStyles.textButton} onClick={() => void movements.refetch()}>
            Try again
          </button>
        </p>
      )}
      {movements.data && (
        <>
          <div className={catalogStyles.tableScroll}>
            <table className={catalogStyles.table}>
              <caption className={catalogStyles.srOnly}>Inventory movements, newest first</caption>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th className={styles.number}>Change</th>
                  <th className={styles.number}>Sellable after</th>
                  <th className={styles.number}>Damaged after</th>
                  <th>Details</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {movements.data.items.map((movement) => (
                  <tr key={movement.id} data-test="movement-row" data-movement-id={movement.id}>
                    <td>
                      <time dateTime={movement.occurredAt}>
                        {new Date(movement.occurredAt).toLocaleString("en-GB", { timeZone: "Europe/Belgrade" })}
                      </time>
                    </td>
                    <td>{MOVEMENT_LABELS[movement.type]}</td>
                    <td className={styles.number}>
                      {signed(movement.delta)} {movement.bucket}
                    </td>
                    <td className={styles.number}>{movement.sellableAfter}</td>
                    <td className={styles.number}>{movement.damagedAfter}</td>
                    <td>{[movement.reference, movement.reason, movement.note].filter(Boolean).join(" · ") || "—"}</td>
                    <td>{movement.actor?.displayName ?? "Seed data"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav className={catalogStyles.pagination} aria-label="Movement pages">
            <span data-test="movement-page">
              Page {movements.data.page} of {Math.max(1, Math.ceil(movements.data.total / movements.data.pageSize))}
            </span>
            <button
              className={catalogStyles.secondary}
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              data-test="movement-previous"
            >
              Previous
            </button>
            <button
              className={catalogStyles.secondary}
              disabled={page * movements.data.pageSize >= movements.data.total}
              onClick={() => setPage(page + 1)}
              data-test="movement-next"
            >
              Next
            </button>
          </nav>
        </>
      )}
    </section>
  );
}

export function InventoryItemPage() {
  const { variantId = "" } = useParams();
  const item = useInventoryItem(variantId);
  return (
    <>
      <Link className={catalogStyles.back} to="/inventory">
        ← Back to inventory
      </Link>
      {item.isPending && <p role="status">Loading inventory item…</p>}
      {item.isError && (
        <p role="alert" className={catalogStyles.error}>
          {item.error instanceof ApiError && item.error.status === 404
            ? "This inventory item does not exist."
            : "Could not load this inventory item."}{" "}
          <button className={catalogStyles.textButton} onClick={() => void item.refetch()}>
            Try again
          </button>
        </p>
      )}
      {item.data && (
        <>
          <div className={catalogStyles.heading}>
            <div>
              <p className={catalogStyles.eyebrow} data-test="inventory-sku">
                {item.data.sku}
              </p>
              <h1>{item.data.product.name}</h1>
              <p className={catalogStyles.muted}>
                {languageLabel(item.data.language)} · {item.data.edition} ·{" "}
                {item.data.product.isActive && item.data.variantIsActive ? "Visible in catalog" : "Hidden from catalog"}
              </p>
            </div>
          </div>
          <StockSummary item={item.data} />
          <div className={catalogStyles.editor}>
            <ReceiptForm key={`receipt-${variantId}`} variantId={variantId} />
            <AdjustmentForm key={`adjustment-${variantId}`} variantId={variantId} />
          </div>
          <MovementHistory variantId={variantId} />
        </>
      )}
    </>
  );
}

/** Inventory is distributor staff only; retailers see availability through the catalog. */
export function RequireStaff() {
  const session = useSession();
  const role = session.data?.user.role;
  if (role !== "operator" && role !== "administrator") {
    return (
      <section>
        <h1>Access restricted</h1>
        <p>Inventory is available to distributor staff.</p>
        <Link to="/catalog">Return to catalog</Link>
      </section>
    );
  }
  return <Outlet />;
}
