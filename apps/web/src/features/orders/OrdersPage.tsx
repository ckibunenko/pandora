import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useSession } from "../auth/session";
import { formatPrice } from "../catalog/catalog-api";
import catalogStyles from "../catalog/Catalog.module.css";
import { ORDERS_QUERY_KEY, STATUS_LABELS, createOrder, useOrders } from "./orders-api";
import styles from "./Orders.module.css";

const formatDate = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/Belgrade" });

export function OrdersPage() {
  const session = useSession();
  const canEdit = session.data?.user.role === "retailer";
  const [params, setParams] = useSearchParams();
  const orders = useOrders(params.toString());
  const client = useQueryClient();
  const navigate = useNavigate();
  // One key per click intent: a retried "New draft" after a lost response cannot create two drafts.
  const [createKey, setCreateKey] = useState(() => crypto.randomUUID());
  const create = useMutation({
    mutationFn: () => createOrder({ lines: [] }, createKey),
    onSuccess: async (order) => {
      setCreateKey(crypto.randomUUID());
      await client.invalidateQueries({ queryKey: ORDERS_QUERY_KEY });
      void navigate(`/orders/${order.id}`);
    },
  });

  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next);
  }

  return (
    <>
      <div className={catalogStyles.heading}>
        <div>
          <p className={catalogStyles.eyebrow}>{canEdit ? session.data?.user.organization.name.toUpperCase() : "ALL RETAILERS"}</p>
          <h1>{!canEdit && params.get("status") === "submitted" ? "Orders awaiting processing" : "Orders"}</h1>
          <p className={catalogStyles.muted}>
            {canEdit
              ? "Drafts are shared with everyone in your organization. Submitting sends an order for review; it does not reserve stock."
              : "Confirm submitted orders to reserve stock, or reject them with a reason."}
          </p>
        </div>
        {canEdit && (
          <button
            className={catalogStyles.primary}
            onClick={() => create.mutate()}
            disabled={create.isPending}
            data-test="order-create"
          >
            {create.isPending ? "Creating…" : "New draft"}
          </button>
        )}
      </div>
      {create.isError && (
        <p role="alert" className={catalogStyles.error} data-test="order-create-error">
          Could not confirm the new draft. Select New draft again to retry safely.
        </p>
      )}

      <div className={catalogStyles.filters}>
        <label>
          Status
          <select value={params.get("status") ?? ""} onChange={(event) => change("status", event.target.value)} data-test="orders-status-filter">
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="submitted">Submitted</option>
            <option value="confirmed">Confirmed</option>
            <option value="rejected">Rejected</option>
            <option value="partially_shipped">Partially shipped</option>
            <option value="shipped">Shipped</option>
            <option value="closed_partial">Closed (partly cancelled)</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
        <label>
          Order
          <select value={params.get("sort") ?? "created_desc"} onChange={(event) => change("sort", event.target.value)} data-test="orders-sort">
            <option value="created_desc">Newest first</option>
            <option value="submitted_asc">Oldest submission first</option>
          </select>
        </label>
      </div>

      {orders.isPending && <p role="status">Loading orders…</p>}
      {orders.isError && (
        <div role="alert" className={catalogStyles.error}>
          Could not load orders.{" "}
          <button className={catalogStyles.textButton} data-test="orders-retry" onClick={() => void orders.refetch()}>
            Try again
          </button>
        </div>
      )}
      {orders.data && (
        <>
          <p className={catalogStyles.results} role="status" data-test="orders-total">
            {orders.data.total} {orders.data.total === 1 ? "order" : "orders"}
          </p>
          {!orders.data.items.length ? (
            <div className={catalogStyles.empty}>
              <h2>{params.get("status") ? "No orders with this status" : "No orders yet"}</h2>
              <p>
                {params.get("status") === "submitted" && !canEdit
                  ? "Nothing is waiting for a decision."
                  : canEdit
                    ? "Create a draft or add items from the catalog."
                    : "No retailer has created an order."}
              </p>
            </div>
          ) : (
            <div className={catalogStyles.tableScroll}>
              <table className={catalogStyles.table}>
                <caption className={catalogStyles.srOnly}>Orders, newest first</caption>
                <thead>
                  <tr>
                    <th>Order</th>
                    {!canEdit && <th>Retailer</th>}
                    <th>Status</th>
                    <th className={styles.number}>Items</th>
                    <th className={styles.number}>Total</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.data.items.map((order) => (
                    <tr key={order.id} data-test="order-row" data-order-number={order.number}>
                      <td>
                        <Link to={`/orders/${order.id}`} data-test="order-link">
                          {order.number}
                        </Link>
                      </td>
                      {!canEdit && <td>{order.organization.name}</td>}
                      <td>
                        <span className={styles.status} data-status={order.status} data-test="order-status">
                          {STATUS_LABELS[order.status]}
                        </span>
                      </td>
                      <td className={styles.number}>{order.lineCount}</td>
                      <td className={styles.number}>
                        {formatPrice(order.totalMinor)}
                        {order.priceStatus === "provisional" && <span className={styles.estimate}> est.</span>}
                      </td>
                      <td>
                        <time dateTime={order.updatedAt}>{formatDate(order.updatedAt)}</time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <nav className={catalogStyles.pagination} aria-label="Order pages">
            <span data-test="orders-page">
              Page {orders.data.page} of {Math.max(1, Math.ceil(orders.data.total / orders.data.pageSize))}
            </span>
            <button
              className={catalogStyles.secondary}
              disabled={orders.data.page <= 1}
              onClick={() => change("page", String(orders.data.page - 1))}
              data-test="orders-previous"
            >
              Previous
            </button>
            <button
              className={catalogStyles.secondary}
              disabled={orders.data.page * orders.data.pageSize >= orders.data.total}
              onClick={() => change("page", String(orders.data.page + 1))}
              data-test="orders-next"
            >
              Next
            </button>
          </nav>
        </>
      )}
    </>
  );
}
