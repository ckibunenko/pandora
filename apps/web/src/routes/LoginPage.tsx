import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ERROR_CODES } from "@pandora/contracts";
import { useId, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { SESSION_QUERY_KEY, useSession } from "../features/auth/session";
import { ApiError, login } from "../lib/api-client";
import styles from "./LoginPage.module.css";

function redirectTarget(state: unknown): string {
  if (typeof state === "object" && state !== null && "from" in state) {
    const from = state.from;
    if (typeof from === "string" && from.startsWith("/") && !from.startsWith("//") && from !== "/login") {
      return from;
    }
  }
  return "/";
}

function fieldError(error: unknown, field: string): string | undefined {
  if (error instanceof ApiError && error.code === ERROR_CODES.validationFailed) {
    return error.details.find((detail) => detail.field === field)?.message;
  }
  return undefined;
}

function formError(error: unknown): string | undefined {
  if (!error) {
    return undefined;
  }
  if (error instanceof ApiError) {
    if (error.code === ERROR_CODES.invalidCredentials) {
      return "Invalid email or password.";
    }
    if (error.code === ERROR_CODES.validationFailed) {
      return "Please correct the highlighted fields.";
    }
    if (error.code === ERROR_CODES.tooManyLoginAttempts) {
      return error.message;
    }
    const reference = error.correlationId ? ` Reference: ${error.correlationId}` : "";
    return `Sign-in failed. Please try again.${reference}`;
  }
  return "Could not reach the server. Please try again.";
}

export function LoginPage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const emailErrorId = useId();
  const passwordErrorId = useId();
  const formErrorId = useId();

  const signIn = useMutation({
    mutationFn: login,
    onSuccess: (newSession) => {
      queryClient.clear();
      queryClient.setQueryData(SESSION_QUERY_KEY, newSession);
      void navigate(redirectTarget(location.state), { replace: true });
    },
  });

  if (session.data) {
    return <Navigate to="/" replace />;
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    signIn.mutate({ email: email.trim(), password });
  };

  const emailError = fieldError(signIn.error, "email");
  const passwordError = fieldError(signIn.error, "password");
  const generalError = formError(signIn.error);

  return (
    <main className={styles.page}>
      <div className={styles.brand}>
        <p className={styles.wordmark}>
          Pandora<span>GAME DISTRIBUTION</span>
        </p>
        <p className={styles.tagline}>Wholesale ordering and fulfillment for independent board-game stores.</p>
      </div>
      <form className={styles.card} onSubmit={onSubmit} aria-describedby={generalError ? formErrorId : undefined}>
        <h1 className={styles.title}>Sign in to Pandora</h1>

        {generalError && (
          <p id={formErrorId} className={styles.formError} role="alert" data-test="login-error">
            {generalError}
          </p>
        )}

        <div className={styles.field}>
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? emailErrorId : undefined}
            data-test="login-email"
          />
          {emailError && (
            <p id={emailErrorId} className={styles.fieldError}>
              {emailError}
            </p>
          )}
        </div>

        <div className={styles.field}>
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={passwordError ? passwordErrorId : undefined}
            data-test="login-password"
          />
          {passwordError && (
            <p id={passwordErrorId} className={styles.fieldError}>
              {passwordError}
            </p>
          )}
        </div>

        <button type="submit" className={styles.submit} disabled={signIn.isPending} data-test="login-submit">
          {signIn.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
