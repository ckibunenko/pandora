import { useSearchParams } from "react-router";

/** Keeps list filters in the URL; changing a filter returns to the first page. */
export function useListParams() {
  const [params, setParams] = useSearchParams();
  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next);
  }
  return { params, change, clear: () => setParams({}) };
}
