import { useQuery } from "@tanstack/react-query";
import { fetchReadiness } from "../lib/api-client";
import styles from "./HomePage.module.css";

export function HomePage() {
  const readiness = useQuery({ queryKey: ["health", "ready"], queryFn: fetchReadiness });

  let statusText: string;
  let statusClass: string | undefined;
  if (readiness.isPending) {
    statusText = "Checking API…";
  } else if (readiness.isError) {
    statusText = "API unreachable";
    statusClass = styles.down;
  } else if (readiness.data.status === "ok") {
    statusText = "API ready";
    statusClass = styles.up;
  } else {
    statusText = "API running, database unavailable";
    statusClass = styles.down;
  }

  return (
    <main className={styles.page}>
      <h1>Pandora</h1>
      <p className={[styles.status, statusClass].filter(Boolean).join(" ")} role="status" data-test="api-status">
        {statusText}
      </p>
    </main>
  );
}
