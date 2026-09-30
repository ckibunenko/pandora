import { NavLink, Outlet } from "react-router";
import { useSession } from "../auth/session";
import catalogStyles from "../catalog/Catalog.module.css";
import styles from "./Admin.module.css";

export function RequireAdmin() {
  const session = useSession();
  if (session.data?.user.role !== "administrator")
    return (
      <section>
        <h1>Access restricted</h1>
        <p>Organization and user management is available to administrators.</p>
        <NavLink to="/catalog">Return to catalog</NavLink>
      </section>
    );
  return <Outlet />;
}

export function ActiveBadge({ active, test }: { active: boolean; test: string }) {
  return (
    <span className={styles.status} data-active={active} data-test={test}>
      {active ? "Active" : "Inactive"}
    </span>
  );
}

export function ListPagination({
  label,
  prefix,
  page,
  pageSize,
  total,
  onChange,
}: {
  label: string;
  prefix: string;
  page: number;
  pageSize: number;
  total: number;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <nav className={catalogStyles.pagination} aria-label={label}>
      <label>
        Per page
        <select value={pageSize} onChange={(event) => onChange("pageSize", event.target.value)} data-test={`${prefix}-page-size`}>
          <option>20</option>
          <option>50</option>
          <option>100</option>
        </select>
      </label>
      <span data-test={`${prefix}-page`}>
        Page {page} of {Math.max(1, Math.ceil(total / pageSize))}
      </span>
      <button
        className={catalogStyles.secondary}
        disabled={page <= 1}
        onClick={() => onChange("page", String(page - 1))}
        data-test={`${prefix}-previous`}
      >
        Previous
      </button>
      <button
        className={catalogStyles.secondary}
        disabled={page * pageSize >= total}
        onClick={() => onChange("page", String(page + 1))}
        data-test={`${prefix}-next`}
      >
        Next
      </button>
    </nav>
  );
}
