import { NavLink, Outlet } from "react-router";
import { useSession } from "../auth/session";
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

export { ListPagination } from "../../components/ListPagination";
