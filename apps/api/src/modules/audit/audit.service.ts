import { Injectable } from "@nestjs/common";
import { auditEventSchema, type AuditEvent, type AuditEventSummary, type AuditListResponse, type AuditQuery } from "@pandora/contracts";
import { ApiException } from "../../common/errors/api-exception.js";
import { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import type { AuthContext } from "../auth/auth-context.js";

const SUMMARY_SELECT = {
  id: true, entityType: true, entityId: true, action: true, occurredAt: true,
  correlationId: true, actorId: true, organizationId: true,
} satisfies Prisma.AuditEventSelect;
type EventRecord = Prisma.AuditEventGetPayload<{ select: typeof SUMMARY_SELECT }>;

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  private scope(auth: AuthContext): Prisma.AuditEventWhereInput {
    return auth.user.role === "administrator" ? {} : { entityType: { in: ["order", "inventory_item", "notification"] } };
  }

  // Resolve display names in batches; audit IDs and snapshots never depend on current names.
  private async summaries(tx: Prisma.TransactionClient, events: EventRecord[]): Promise<AuditEventSummary[]> {
    const [actors, organizations] = await Promise.all([
      tx.user.findMany({ where: { id: { in: [...new Set(events.map((event) => event.actorId))] } }, select: { id: true, displayName: true } }),
      tx.organization.findMany({ where: { id: { in: [...new Set(events.map((event) => event.organizationId))] } }, select: { id: true, name: true } }),
    ]);
    const names = new Map(actors.map((actor) => [actor.id, actor.displayName]));
    const orgNames = new Map(organizations.map((org) => [org.id, org.name]));
    return events.map((event) => ({
      id: event.id, entityType: event.entityType, entityId: event.entityId, action: event.action,
      occurredAt: event.occurredAt.toISOString(), correlationId: event.correlationId,
      actor: { id: event.actorId, displayName: names.get(event.actorId) ?? null },
      organization: { id: event.organizationId, name: orgNames.get(event.organizationId) ?? null },
    }));
  }

  async list(query: AuditQuery, auth: AuthContext): Promise<AuditListResponse> {
    const where: Prisma.AuditEventWhereInput = {
      AND: [
        this.scope(auth),
        {
          ...(query.entityType ? { entityType: query.entityType } : {}),
          ...(query.entityId ? { entityId: query.entityId } : {}),
          ...(query.action ? { action: query.action } : {}),
          ...(query.actorId ? { actorId: query.actorId } : {}),
          ...(query.organizationId ? { organizationId: query.organizationId } : {}),
          ...(query.correlationId ? { correlationId: query.correlationId } : {}),
          ...((query.from || query.to) ? { occurredAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          } } : {}),
        },
      ],
    };
    return this.prisma.$transaction(async (tx) => {
      const total = await tx.auditEvent.count({ where });
      const events = await tx.auditEvent.findMany({
        where, select: SUMMARY_SELECT, orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize, take: query.pageSize,
      });
      return { items: await this.summaries(tx, events), total, page: query.page, pageSize: query.pageSize };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async detail(eventId: string, auth: AuthContext): Promise<AuditEvent> {
    return this.prisma.$transaction(async (tx) => {
      const event = await tx.auditEvent.findFirst({
        where: { id: eventId, ...this.scope(auth) }, select: { ...SUMMARY_SELECT, before: true, after: true },
      });
      if (!event) throw ApiException.notFound("Audit event not found.");
      const [summary] = await this.summaries(tx, [event]);
      return auditEventSchema.parse({ ...summary, before: event.before, after: event.after });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
