import { Injectable } from "@nestjs/common";
import type {
  AdminOrganization,
  CreateOrganization,
  OrganizationListResponse,
  OrganizationQuery,
  UpdateOrganization,
} from "@pandora/contracts";
import { recordAudit } from "../../common/audit/audit.js";
import { Clock } from "../../common/clock/clock.js";
import { ApiException } from "../../common/errors/api-exception.js";
import { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { runSerializable } from "../../infrastructure/prisma/serializable.js";
import type { AuthContext } from "../auth/auth-context.js";
import { toOrganizationType } from "../auth/session-user.mapper.js";
import { revokeSessions } from "../auth/sessions.service.js";
import { isUniqueViolation, literalSearch, statusWhere } from "./administration.helpers.js";

const ORGANIZATION_SELECT = {
  id: true,
  name: true,
  type: true,
  isActive: true,
  createdAt: true,
} satisfies Prisma.OrganizationSelect;
type OrganizationRecord = Prisma.OrganizationGetPayload<{ select: typeof ORGANIZATION_SELECT }>;

const snapshot = (organization: OrganizationRecord) => ({
  id: organization.id,
  name: organization.name,
  type: toOrganizationType(organization.type),
  isActive: organization.isActive,
});

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async list(query: OrganizationQuery): Promise<OrganizationListResponse> {
    const where: Prisma.OrganizationWhereInput = {
      ...statusWhere(query.status),
      ...(query.type ? { type: query.type === "distributor" ? "DISTRIBUTOR" : "RETAILER" } : {}),
      ...(query.q ? { name: { contains: literalSearch(query.q), mode: "insensitive" } } : {}),
    };
    // Count, page, and user counts observe one snapshot.
    return this.prisma.$transaction(
      async (tx) => {
        const total = await tx.organization.count({ where });
        const organizations = await tx.organization.findMany({
          where,
          select: ORGANIZATION_SELECT,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        });
        return {
          items: await this.toDtos(tx, organizations),
          page: query.page,
          pageSize: query.pageSize,
          total,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async detail(id: string, tx: Prisma.TransactionClient = this.prisma): Promise<AdminOrganization> {
    const organization = await tx.organization.findUnique({ where: { id }, select: ORGANIZATION_SELECT });
    if (!organization) {
      throw ApiException.notFound("Organization not found.");
    }
    const [dto] = await this.toDtos(tx, [organization]);
    if (!dto) {
      throw new Error(`Organization ${id} could not be mapped.`);
    }
    return dto;
  }

  async create(input: CreateOrganization, auth: AuthContext): Promise<AdminOrganization> {
    try {
      return await runSerializable(this.prisma, async (tx) => {
        const now = this.clock.now();
        // Only retailer organizations can be created; the MVP has exactly one distributor.
        const organization = await tx.organization.create({
          data: { name: input.name, type: "RETAILER", createdAt: now, updatedAt: now },
          select: ORGANIZATION_SELECT,
        });
        await recordAudit(tx, this.clock, auth, {
          entityType: "organization",
          entityId: organization.id,
          action: "created",
          before: null,
          after: snapshot(organization),
        });
        return this.detail(organization.id, tx);
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw ApiException.organizationNameExists();
      }
      throw error;
    }
  }

  async update(id: string, input: UpdateOrganization, auth: AuthContext): Promise<AdminOrganization> {
    try {
      return await runSerializable(this.prisma, async (tx) => {
        const before = await tx.organization.findUnique({ where: { id }, select: ORGANIZATION_SELECT });
        if (!before) {
          throw ApiException.notFound("Organization not found.");
        }
        if (input.isActive === false && before.type === "DISTRIBUTOR") {
          throw ApiException.distributorOrganizationProtected();
        }
        const name = input.name ?? before.name;
        const isActive = input.isActive ?? before.isActive;
        if (name === before.name && isActive === before.isActive) {
          return this.detail(id, tx);
        }
        const after = await tx.organization.update({
          where: { id },
          data: { name, isActive, updatedAt: this.clock.now() },
          select: ORGANIZATION_SELECT,
        });
        // Deactivation ends every member's session; history, orders, and reservations stay untouched.
        const revokedSessions =
          before.isActive && !after.isActive
            ? await revokeSessions(tx, this.clock, { user: { organizationId: id } }, "organization_deactivated")
            : 0;
        await recordAudit(tx, this.clock, auth, {
          entityType: "organization",
          entityId: id,
          action: "updated",
          before: snapshot(before),
          after: { ...snapshot(after), revokedSessions },
        });
        return this.detail(id, tx);
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw ApiException.organizationNameExists();
      }
      throw error;
    }
  }

  private async toDtos(tx: Prisma.TransactionClient, organizations: OrganizationRecord[]): Promise<AdminOrganization[]> {
    const counts = await tx.user.groupBy({
      by: ["organizationId", "isActive"],
      where: { organizationId: { in: organizations.map((organization) => organization.id) } },
      _count: { _all: true },
    });
    const countFor = (organizationId: string, active?: boolean) =>
      counts
        .filter((row) => row.organizationId === organizationId && (active === undefined || row.isActive === active))
        .reduce((sum, row) => sum + row._count._all, 0);
    return organizations.map((organization) => ({
      ...snapshot(organization),
      userCount: countFor(organization.id),
      activeUserCount: countFor(organization.id, true),
      createdAt: organization.createdAt.toISOString(),
    }));
  }
}
