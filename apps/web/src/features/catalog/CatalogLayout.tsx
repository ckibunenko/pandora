import { useMutation, useQueryClient } from "@tanstack/react-query";
import { NavLink, Outlet, useNavigate } from "react-router";
import { roleLabel, useSession } from "../auth/session";
import { logout } from "../../lib/api-client";
import styles from "./Catalog.module.css";

export const PROCESSING_QUEUE = "/orders?status=submitted&sort=submitted_asc";

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
      <a className={styles.skipLink} href="#main-content">Skip to content</a>
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
          <NavLink
            to={user.role === "retailer" ? "/orders" : PROCESSING_QUEUE}
            data-test="orders-nav"
          >
            Orders
          </NavLink>
          {(user.role === "operator" || user.role === "administrator") && (
            <>
              <NavLink to="/inventory" data-test="inventory-nav">
                Inventory
              </NavLink>
              <NavLink to="/audit" data-test="audit-nav">
                Audit trail
              </NavLink>
              <NavLink to="/notifications" data-test="notifications-nav">
                Notifications
              </NavLink>
            </>
          )}
          {user.role === "administrator" && (
            <>
              <NavLink to="/admin/organizations" data-test="organizations-nav">
                Organizations
              </NavLink>
              <NavLink to="/admin/users" data-test="users-nav">
                Users
              </NavLink>
            </>
          )}
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
      <main className={styles.page} id="main-content" tabIndex={-1}>
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
