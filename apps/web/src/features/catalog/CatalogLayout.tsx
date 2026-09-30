import { useMutation, useQueryClient } from "@tanstack/react-query";
import { NavLink, Outlet, useNavigate } from "react-router";
import { roleLabel, useSession } from "../auth/session";
import { logout } from "../../lib/api-client";
import styles from "./Catalog.module.css";

export function CatalogLayout() {
  const session = useSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation({
    mutationFn: logout,
    onSettled: () => {
      client.clear();
      void navigate("/login", { replace: true });
    },
  });
  if (!session.data) return null;
  const { user } = session.data;
  return (
    <>
      <header className={styles.header}>
        <NavLink to="/" className={styles.brand ?? ""}>
          Pandora<span>GAME DISTRIBUTION</span>
        </NavLink>
        <nav aria-label="Main navigation" className={styles.nav}>
          <NavLink to="/catalog" data-test="catalog-nav">
            Catalog
          </NavLink>
          {user.role === "administrator" && (
            <NavLink to="/admin/catalog" data-test="catalog-admin-nav">
              Manage catalog
            </NavLink>
          )}
          {user.role === "retailer" && (
            <NavLink to="/orders" data-test="orders-nav">
              Orders
            </NavLink>
          )}
          {(user.role === "operator" || user.role === "administrator") && (
            <NavLink to="/inventory" data-test="inventory-nav">
              Inventory
            </NavLink>
          )}
          {user.role === "operator" && <NavLink to="/">Home</NavLink>}
        </nav>
        <div className={styles.account}>
          <span data-test="current-user">
            {user.displayName}
            <small>
              {roleLabel(user.role)} · {user.organization.name}
            </small>
          </span>
          <button
            className={styles.textButton}
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
            data-test="logout-button"
          >
            {signOut.isPending ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </header>
      <main className={styles.page}>
        <Outlet />
      </main>
    </>
  );
}

export function RequireCatalogAdmin() {
  const session = useSession();
  if (session.data?.user.role !== "administrator")
    return (
      <section>
        <h1>Access restricted</h1>
        <p>Catalog management is available to administrators.</p>
        <NavLink to="/catalog">Return to catalog</NavLink>
      </section>
    );
  return <Outlet />;
}
