import { ApiException } from "../../common/errors/api-exception.js";
import { Prisma } from "../../generated/prisma/client.js";
import type { PrismaService } from "./prisma.service.js";

export const MAX_SERIALIZABLE_ATTEMPTS = 3;

// The pg adapter maps SQLSTATE 40001 (serialization failure) and 40P01 (deadlock) to P2034 for statements.
// A conflict that PostgreSQL only detects at COMMIT surfaces as the adapter's raw error instead.
function isRetryableConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2034";
  }
  return (
    error instanceof Error &&
    error.name === "DriverAdapterError" &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "kind" in error.cause &&
    error.cause.kind === "TransactionWriteConflict"
  );
}

/**
 * Runs `work` in a Serializable transaction and retries the whole transaction on
 * serialization conflicts. `work` must not perform external side effects: it may run more than once.
 */
export async function runSerializable<T>(
  prisma: PrismaService,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error: unknown) {
      if (!isRetryableConflict(error)) {
        throw error;
      }
      if (attempt >= MAX_SERIALIZABLE_ATTEMPTS) {
        throw ApiException.concurrentModification();
      }
    }
  }
}
