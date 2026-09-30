import { useId } from "react";
import styles from "./Catalog.module.css";

export function CatalogFormField({
  name,
  label,
  value,
  onChange,
  error,
  type = "text",
  options = [],
  maxLength,
  disabled = false,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  type?: "text" | "textarea" | "select";
  options?: { value: string; label: string }[];
  maxLength?: number;
  disabled?: boolean;
}) {
  const id = useId();
  const props = {
    id,
    name,
    value,
    onChange: (
      event: React.ChangeEvent<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >,
    ) => onChange(event.target.value),
    disabled,
    "aria-invalid": !!error,
    "aria-describedby": error ? `${id}-error` : undefined,
    "data-test": `field-${name}`,
  };
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      {type === "textarea" ? (
        <textarea {...props} rows={4} maxLength={maxLength} />
      ) : type === "select" ? (
        <select {...props}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input {...props} maxLength={maxLength} />
      )}
      {error && (
        <p className={styles.fieldError} id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
