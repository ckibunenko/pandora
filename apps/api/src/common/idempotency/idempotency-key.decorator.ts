import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { ApiException } from "../errors/api-exception.js";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
const VALID_KEY = /^[\x21-\x7E]{1,255}$/;

export const IdempotencyKey = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const key = context.switchToHttp().getRequest<Request>().header(IDEMPOTENCY_KEY_HEADER);
  if (key === undefined || key === "") {
    throw ApiException.idempotencyKeyRequired();
  }
  if (!VALID_KEY.test(key)) {
    throw ApiException.validationFailed([
      { field: IDEMPOTENCY_KEY_HEADER, message: "Use 1–255 printable ASCII characters without spaces." },
    ]);
  }
  return key;
});
