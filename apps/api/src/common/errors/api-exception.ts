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
}
