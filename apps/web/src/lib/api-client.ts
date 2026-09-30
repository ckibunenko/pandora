import {
  errorEnvelopeSchema,
  healthResponseSchema,
  sessionResponseSchema,
  type ErrorDetail,
  type HealthResponse,
  type LoginRequest,
  type SessionResponse,
} from "@pandora/contracts";

const API_BASE_PATH = "/api";
const CSRF_HEADER_NAME = "X-CSRF-Token";
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly correlationId: string | undefined,
    readonly details: readonly ErrorDetail[] = [],
  ) {
    super(message);
  }
}

// Held in memory only: it comes from the session response and must never be persisted in browser storage.
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

interface RequestOptions<T> {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  parse: (body: unknown) => T;
  acceptedErrorStatuses?: readonly number[];
  headers?: Readonly<Record<string, string>>;
}

async function toApiError(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => undefined);
  const envelope = errorEnvelopeSchema.safeParse(body);
  if (envelope.success) {
    const { code, message, correlation_id, details } = envelope.data;
    return new ApiError(response.status, code, message, correlation_id, details);
  }
  return new ApiError(response.status, "UNEXPECTED_RESPONSE", `Request failed with status ${response.status}.`, undefined);
}

export async function request<T>(
  path: string,
  { method = "GET", body, parse, acceptedErrorStatuses = [], headers: extraHeaders = {} }: RequestOptions<T>,
): Promise<T> {
  const headers: Record<string, string> = { ...extraHeaders, Accept: "application/json" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (UNSAFE_METHODS.has(method) && csrfToken !== null) {
    headers[CSRF_HEADER_NAME] = csrfToken;
  }

  const response = await fetch(`${API_BASE_PATH}${path}`, {
    method,
    headers,
    credentials: "same-origin",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok && !acceptedErrorStatuses.includes(response.status)) {
    throw await toApiError(response);
  }
  const responseBody: unknown = response.status === 204 ? undefined : await response.json();
  return parse(responseBody);
}

export function fetchReadiness(): Promise<HealthResponse> {
  // 503 carries a valid health body describing which check failed.
  return request("/health/ready", {
    parse: (body) => healthResponseSchema.parse(body),
    acceptedErrorStatuses: [503],
  });
}

/** Resolves to null when there is no valid session. */
export async function fetchSession(): Promise<SessionResponse | null> {
  try {
    const session = await request("/auth/session", { parse: (body) => sessionResponseSchema.parse(body) });
    setCsrfToken(session.csrfToken);
    return session;
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      setCsrfToken(null);
      return null;
    }
    throw error;
  }
}

export async function login(credentials: LoginRequest): Promise<SessionResponse> {
  const session = await request("/auth/login", {
    method: "POST",
    body: credentials,
    parse: (body) => sessionResponseSchema.parse(body),
  });
  setCsrfToken(session.csrfToken);
  return session;
}

export async function logout(): Promise<void> {
  try {
    await request("/auth/logout", { method: "POST", parse: () => undefined });
  } finally {
    setCsrfToken(null);
  }
}
