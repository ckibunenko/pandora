import { HttpException, HttpStatus } from "@nestjs/common";
import { ERROR_CODES, type ErrorCode, type ErrorDetail } from "@pandora/contracts";

export class ApiException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: ErrorCode,
    message: string,
    readonly details?: readonly ErrorDetail[],
  ) {
    super(message, status);
  }

  static unauthenticated(): ApiException {
    return new ApiException(HttpStatus.UNAUTHORIZED, ERROR_CODES.unauthenticated, "Authentication is required.");
  }

  static invalidCredentials(): ApiException {
    return new ApiException(HttpStatus.UNAUTHORIZED, ERROR_CODES.invalidCredentials, "Invalid email or password.");
  }

  static forbidden(): ApiException {
    return new ApiException(HttpStatus.FORBIDDEN, ERROR_CODES.forbidden, "You do not have permission to perform this action.");
  }

  static csrfTokenInvalid(): ApiException {
    return new ApiException(HttpStatus.FORBIDDEN, ERROR_CODES.csrfTokenInvalid, "Missing or invalid CSRF token.");
  }

  static validationFailed(details: readonly ErrorDetail[]): ApiException {
    return new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, ERROR_CODES.validationFailed, "Request validation failed.", details);
  }

  static notFound(message = "Resource not found."): ApiException {
    return new ApiException(HttpStatus.NOT_FOUND, ERROR_CODES.notFound, message);
  }

  static insufficientStock(details: readonly ErrorDetail[]): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.insufficientStock, "Not enough stock for this change.", details);
  }

  static idempotencyKeyRequired(): ApiException {
    return new ApiException(HttpStatus.BAD_REQUEST, ERROR_CODES.idempotencyKeyRequired, "The Idempotency-Key header is required.");
  }

  static idempotencyKeyReused(): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.idempotencyKeyReused, "This Idempotency-Key was already used with a different request.");
  }

  static requestInProgress(): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.requestInProgress, "A request with this Idempotency-Key is still in progress.");
  }

  static versionConflict(currentVersion: number): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.versionConflict, "The order changed since you loaded it. Reload to see the latest version.", [
      { field: "version", message: `The current version is ${currentVersion}.` },
    ]);
  }

  static invalidOrderTransition(message: string): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.invalidOrderTransition, message);
  }

  static priceChanged(details: readonly ErrorDetail[]): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.priceChanged, "Prices changed since you reviewed them.", details);
  }

  static variantUnavailable(details: readonly ErrorDetail[]): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.variantUnavailable, "Some items are no longer available.", details);
  }

  static concurrentModification(): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.concurrentModification, "The record changed concurrently. Please retry.");
  }
}
