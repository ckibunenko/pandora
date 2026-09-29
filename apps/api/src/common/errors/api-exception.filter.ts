import { Catch, HttpException, HttpStatus, Logger, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { ERROR_CODES, type ErrorEnvelope } from "@pandora/contracts";
import type { Response } from "express";
import { currentCorrelationId } from "../request-context/request-context.js";
import { ApiException } from "./api-exception.js";

const CODE_BY_STATUS: Partial<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: ERROR_CODES.malformedRequest,
  [HttpStatus.UNAUTHORIZED]: ERROR_CODES.unauthenticated,
  [HttpStatus.FORBIDDEN]: ERROR_CODES.forbidden,
  [HttpStatus.NOT_FOUND]: ERROR_CODES.notFound,
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const correlationId = currentCorrelationId() ?? "unavailable";
    const { status, envelope } = this.toEnvelope(exception, correlationId);

    if (status >= 500) {
      this.logger.error({
        message: "Unhandled error",
        correlation_id: correlationId,
        error: exception instanceof Error ? exception.stack : String(exception),
      });
    }

    response.status(status).json(envelope);
  }

  private toEnvelope(exception: unknown, correlationId: string): { status: number; envelope: ErrorEnvelope } {
    if (exception instanceof ApiException) {
      return {
        status: exception.getStatus(),
        envelope: {
          code: exception.code,
          message: exception.message,
          correlation_id: correlationId,
          ...(exception.details ? { details: [...exception.details] } : {}),
        },
      };
    }

    // Framework errors (unknown routes, body-parser failures) and anything unexpected.
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    if (status >= 500) {
      return {
        status,
        envelope: { code: ERROR_CODES.internalError, message: "An unexpected error occurred.", correlation_id: correlationId },
      };
    }
    // Body-parser messages quote the raw body (possibly a password), so malformed requests get a fixed message.
    const message =
      status === HttpStatus.BAD_REQUEST
        ? "The request body is malformed."
        : exception instanceof HttpException
          ? exception.message
          : "Request failed.";
    return {
      status,
      envelope: { code: CODE_BY_STATUS[status] ?? `HTTP_${status}`, message, correlation_id: correlationId },
    };
  }
}
