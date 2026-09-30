import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate } from "react-router";
import { roleLabel, useSession } from "../features/auth/session";
import { logout } from "../lib/api-client";
import { PROCESSING_QUEUE } from "../features/catalog/CatalogLayout";
import styles from "./HomePage.module.css";

export function HomePage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const signOut = useMutation({
    mutationFn: logout,
    // Local state is cleared even if the server call fails (for example, an already expired session).
    onSettled: () => {
      queryClient.clear();
      void navigate("/login", { replace: true });
    },
  });

  // RequireAuth renders this page only with a signed-in session.
  if (!session.data) {
    return null;
  }
  const { user } = session.data;
  if (user.role === "retailer") return <Navigate to="/catalog" replace />;
  if (user.role === "administrator") return <Navigate to="/admin/catalog" replace />;
  // Operators start from the queue of orders awaiting processing (overview §8).
  if (user.role === "operator") return <Navigate to={PROCESSING_QUEUE} replace />;

  return (
    <main className={styles.page}>
      <h1>Pandora</h1>
      <Link to="/catalog" data-test="catalog-nav">Browse catalog</Link>
      <Link to="/inventory" data-test="inventory-nav">Manage inventory</Link>
      <section className={styles.account} aria-label="Signed-in account">
        <p data-test="current-user">
          Signed in as <strong>{user.displayName}</strong> ({user.email})
        </p>
        <p className={styles.meta}>
          {roleLabel(user.role)} · {user.organization.name}
        </p>
        <button
          type="button"
          className={styles.logout}
          onClick={() => signOut.mutate()}
          disabled={signOut.isPending}
          data-test="logout-button"
        >
          {signOut.isPending ? "Signing out…" : "Sign out"}
        </button>
      </section>
    </main>
  );
}
