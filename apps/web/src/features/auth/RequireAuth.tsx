import { Navigate, Outlet, useLocation } from "react-router";
import { useSession } from "./session";

export function RequireAuth() {
  const session = useSession();
  const location = useLocation();

  if (session.isPending) {
    return <p role="status">Loading…</p>;
  }
  if (session.isError) {
    return <p role="alert">Could not reach the server. Please try again.</p>;
  }
  if (session.data === null) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}
