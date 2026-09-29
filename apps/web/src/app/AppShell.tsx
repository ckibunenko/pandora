import { useQuery } from "@tanstack/react-query";
import { Outlet } from "react-router";
import { fetchReadiness } from "../lib/api-client";
import styles from "./AppShell.module.css";

function ApiStatus() {
  const readiness = useQuery({ queryKey: ["health", "ready"], queryFn: fetchReadiness });

  let text: string;
  let tone: string | undefined;
  if (readiness.isPending) {
    text = "Checking API…";
  } else if (readiness.isError) {
    text = "API unreachable";
    tone = styles.down;
  } else if (readiness.data.status === "ok") {
    text = "API ready";
    tone = styles.up;
  } else {
    text = "API running, database unavailable";
    tone = styles.down;
  }

  return (
    <p className={[styles.status, tone].filter(Boolean).join(" ")} role="status" data-test="api-status">
      {text}
    </p>
  );
}

export function AppShell() {
  return (
    <div className={styles.shell}>
      <div className={styles.content}>
        <Outlet />
      </div>
      <footer className={styles.footer}>
        <ApiStatus />
      </footer>
    </div>
  );
}
