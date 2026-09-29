import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export const CORRELATION_ID_HEADER = "X-Correlation-Id";
const VALID_CORRELATION_ID = /^[A-Za-z0-9-]{1,64}$/;

interface RequestContext {
  readonly correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(CORRELATION_ID_HEADER);
  // Externally supplied IDs end up in logs, so only a conservative character set is accepted.
  const correlationId = incoming !== undefined && VALID_CORRELATION_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  storage.run({ correlationId }, next);
}
