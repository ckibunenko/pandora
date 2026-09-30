import { Prisma } from "../../generated/prisma/client.js";
import type { AuthContext } from "../../modules/auth/auth-context.js";
import type { Clock } from "../clock/clock.js";
import { currentCorrelationId } from "../request-context/request-context.js";

export interface AuditEntry {
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly before: Prisma.InputJsonObject | null;
  readonly after: Prisma.InputJsonObject;
}

/** Records an audit event inside the caller's transaction, so it commits or rolls back with the change. */
export async function recordAudit(
  tx: Prisma.TransactionClient,
  clock: Clock,
  auth: AuthContext,
  entry: AuditEntry,
): Promise<void> {
  const correlationId = currentCorrelationId();
  if (!correlationId) {
    throw new Error("Audited writes require request context.");
  }
  await tx.auditEvent.create({
    data: {
      actorId: auth.user.id,
      organizationId: auth.user.organization.id,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      occurredAt: clock.now(),
      correlationId,
      before: entry.before ?? Prisma.DbNull,
      after: entry.after,
    },
  });
}
