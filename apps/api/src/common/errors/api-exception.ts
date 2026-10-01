import { HttpException, HttpStatus } from "@nestjs/common";
import { ERROR_CODES, type ErrorCode, type ErrorDetail } from "@pandora/contracts";

export class ApiException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: ErrorCode,
    message: string,
    readonly details?: readonly ErrorDetail[],
    readonly headers?: Readonly<Record<string, string>>,
  ) {
    super(message, status);
  }

  static unauthenticated(): ApiException {
    return new ApiException(HttpStatus.UNAUTHORIZED, ERROR_CODES.unauthenticated, "Authentication is required.");
  }

  static invalidCredentials(): ApiException {
    return new ApiException(HttpStatus.UNAUTHORIZED, ERROR_CODES.invalidCredentials, "Invalid email or password.");
  }

  /** The same answer for every email, known or not, so the limit reveals nothing about accounts. */
  static tooManyLoginAttempts(retryAfterSeconds: number): ApiException {
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    return new ApiException(
      HttpStatus.TOO_MANY_REQUESTS,
      ERROR_CODES.tooManyLoginAttempts,
      `Too many sign-in attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
      undefined,
      { "Retry-After": String(retryAfterSeconds) },
    );
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

  static shipmentQuantityExceeded(details: readonly ErrorDetail[]): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.shipmentQuantityExceeded, "A shipment cannot exceed the outstanding quantity.", details);
  }

  static cancellationRequestPending(): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.cancellationRequestPending, "A cancellation request for this order is already pending.");
  }

  static cancellationQuantityExceeded(details: readonly ErrorDetail[]): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.cancellationQuantityExceeded, "A cancellation request cannot exceed the outstanding quantity.", details);
  }

  static returnQuantityExceeded(details: readonly ErrorDetail[]): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.returnQuantityExceeded, "Returned quantities cannot exceed what was shipped or approved.", details);
  }

  static invalidReturnTransition(message: string): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.invalidReturnTransition, message);
  }

  static notificationNotRetryable(message: string): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.notificationNotRetryable, message);
  }

  static cancellationConflict(details: readonly ErrorDetail[]): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.cancellationConflict, "The order changed since the cancellation was requested.", details);
  }

  static organizationNameExists(): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.organizationNameExists, "An organization with this name already exists.", [
      { field: "name", message: "Choose a unique organization name." },
    ]);
  }

  static emailAlreadyExists(): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.emailAlreadyExists, "A user with this email already exists.", [
      { field: "email", message: "Choose an email that is not in use." },
    ]);
  }

  static distributorOrganizationProtected(): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.distributorOrganizationProtected, "The distributor organization cannot be deactivated.");
  }

  static lastActiveAdministrator(): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.lastActiveAdministrator, "The last active administrator cannot be deactivated or lose the administrator role.");
  }

  static concurrentModification(): ApiException {
    return new ApiException(HttpStatus.CONFLICT, ERROR_CODES.concurrentModification, "The record changed concurrently. Please retry.");
  }
}
