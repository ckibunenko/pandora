import { healthResponseSchema, type HealthResponse } from "@pandora/contracts";

const API_BASE_PATH = "/api";

export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface RequestOptions<T> {
  parse: (body: unknown) => T;
  acceptedErrorStatuses?: readonly number[];
}

async function request<T>(
  path: string,
  { parse, acceptedErrorStatuses = [] }: RequestOptions<T>,
): Promise<T> {
  const response = await fetch(`${API_BASE_PATH}${path}`, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  if (!response.ok && !acceptedErrorStatuses.includes(response.status)) {
    throw new ApiError(response.status, `Request to ${path} failed with status ${response.status}`);
  }
  const body: unknown = await response.json();
  return parse(body);
}

export function fetchReadiness(): Promise<HealthResponse> {
  // 503 carries a valid health body describing which check failed.
  return request("/health/ready", {
    parse: (body) => healthResponseSchema.parse(body),
    acceptedErrorStatuses: [503],
  });
}
