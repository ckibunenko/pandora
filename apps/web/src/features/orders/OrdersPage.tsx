import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useSession } from "../auth/session";
import { formatPrice } from "../catalog/catalog-api";
import catalogStyles from "../catalog/Catalog.module.css";
import { ORDERS_QUERY_KEY, STATUS_LABELS, createOrder, useOrders } from "./orders-api";
import styles from "./Orders.module.css";
import { ListPagination } from "../../components/ListPagination";

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
  const hasFilters = !!(params.get("status") || params.get("returns"));
  function clearFilters() {
    const next = new URLSearchParams(params);
    next.delete("status");
    next.delete("returns");
    next.delete("page");
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
          Returns
          <select value={params.get("returns") ?? ""} onChange={(event) => change("returns", event.target.value)} data-test="orders-returns-filter">
            <option value="">All orders</option>
            <option value="open">With open returns</option>
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
              <h2>{orders.data.total > 0 ? "No orders on this page" : hasFilters ? "No orders match these filters" : "No orders yet"}</h2>
              <p>
                {orders.data.total > 0
                  ? "Return to the first page to see orders in this list."
                  : hasFilters
                    ? params.get("status") === "submitted" && !canEdit && !params.get("returns")
                      ? "Nothing is waiting for a decision."
                      : "Try a different status or return filter."
                    : canEdit
                      ? "Create a draft or add items from the catalog."
                      : "No retailer has created an order."}
              </p>
              {orders.data.total > 0 ? (
                <button className={catalogStyles.secondary} onClick={() => change("page", "1")}>
                  Return to first page
                </button>
              ) : hasFilters ? (
                <button className={catalogStyles.secondary} onClick={clearFilters}>
                  Clear filters
                </button>
              ) : canEdit ? (
                <Link className={catalogStyles.secondary} to="/catalog">Browse catalog</Link>
              ) : null}
            </div>
          ) : (
            <div className={catalogStyles.tableScroll} role="region" aria-label="Orders" tabIndex={0}>
              <table className={catalogStyles.table}>
                <caption className={catalogStyles.srOnly}>Orders, {params.get("sort") === "submitted_asc" ? "oldest submission first" : "newest first"}</caption>
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
                        {order.openReturnCount > 0 && (
                          <span className={styles.openReturns} data-test="order-open-returns">
                            {order.openReturnCount} open {order.openReturnCount === 1 ? "return" : "returns"}
                          </span>
                        )}
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
          <ListPagination
            label="Order pages"
            prefix="orders"
            page={orders.data.page}
            pageSize={orders.data.pageSize}
            total={orders.data.total}
            onChange={change}
          />
        </>
      )}
    </>
  );
}
