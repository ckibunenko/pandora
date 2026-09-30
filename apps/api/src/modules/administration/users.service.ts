import { Injectable } from "@nestjs/common";
import {
  rolesFor,
  type AdminUser,
  type CreateUser,
  type ResetPassword,
  type UpdateUser,
  type UserListResponse,
  type UserQuery,
  type UserRole,
} from "@pandora/contracts";
import { recordAudit } from "../../common/audit/audit.js";
import { Clock } from "../../common/clock/clock.js";
import { ApiException } from "../../common/errors/api-exception.js";
import { Prisma, type OrganizationType } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { runSerializable } from "../../infrastructure/prisma/serializable.js";
import type { AuthContext } from "../auth/auth-context.js";
import { PasswordHasher } from "../auth/password-hasher.js";
import { fromUserRole, toOrganizationType, toUserRole } from "../auth/session-user.mapper.js";
import { revokeSessions, type SessionRevocationReason } from "../auth/sessions.service.js";
import { isUniqueViolation, literalSearch, statusWhere } from "./administration.helpers.js";

// Never select the password hash: responses and audit snapshots are built from this shape.
const USER_SELECT = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  isActive: true,
  createdAt: true,
  organization: { select: { id: true, name: true, type: true, isActive: true } },
} satisfies Prisma.UserSelect;
type UserRecord = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

const snapshot = (user: UserRecord) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  role: toUserRole(user.role),
  organizationId: user.organization.id,
  isActive: user.isActive,
});

const toDto = (user: UserRecord): AdminUser => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  role: toUserRole(user.role),
  isActive: user.isActive,
  organization: {
    id: user.organization.id,
    name: user.organization.name,
    type: toOrganizationType(user.organization.type),
    isActive: user.organization.isActive,
  },
  createdAt: user.createdAt.toISOString(),
});

function assertRoleFits(role: UserRole, organizationType: OrganizationType): void {
  if (!rolesFor(toOrganizationType(organizationType)).includes(role)) {
    throw ApiException.validationFailed([
      {
        field: "role",
        message:
          organizationType === "DISTRIBUTOR"
            ? "Distributor users are operators or administrators."
            : "Retailer organization users have the retailer role.",
      },
    ]);
  }
}

const notFound = () => ApiException.notFound("User not found.");

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly passwords: PasswordHasher,
  ) {}

  async list(query: UserQuery): Promise<UserListResponse> {
    const search = query.q ? { contains: literalSearch(query.q), mode: "insensitive" as const } : undefined;
    const where: Prisma.UserWhereInput = {
      ...statusWhere(query.status),
      ...(query.organizationId ? { organizationId: query.organizationId } : {}),
      ...(query.role ? { role: fromUserRole(query.role) } : {}),
      ...(search ? { OR: [{ email: search }, { displayName: search }] } : {}),
    };
    const [total, users] = await this.prisma.$transaction(
      [
        this.prisma.user.count({ where }),
        this.prisma.user.findMany({
          where,
          select: USER_SELECT,
          orderBy: [{ email: "asc" }, { id: "asc" }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { items: users.map(toDto), page: query.page, pageSize: query.pageSize, total };
  }

  async detail(id: string): Promise<AdminUser> {
    const user = await this.prisma.user.findUnique({ where: { id }, select: USER_SELECT });
    if (!user) {
      throw notFound();
    }
    return toDto(user);
  }

  async create(input: CreateUser, auth: AuthContext): Promise<AdminUser> {
    // Hashed once, outside the transaction, so a serialization retry does not repeat the work.
    const passwordHash = await this.passwords.hash(input.password);
    try {
      return await runSerializable(this.prisma, async (tx) => {
        const organization = await tx.organization.findUnique({
          where: { id: input.organizationId },
          select: { type: true },
        });
        if (!organization) {
          throw ApiException.validationFailed([{ field: "organizationId", message: "Select an existing organization." }]);
        }
        assertRoleFits(input.role, organization.type);
        const now = this.clock.now();
        const user = await tx.user.create({
          data: {
            email: input.email,
            displayName: input.displayName,
            organizationId: input.organizationId,
            role: fromUserRole(input.role),
            passwordHash,
            createdAt: now,
            updatedAt: now,
          },
          select: USER_SELECT,
        });
        await recordAudit(tx, this.clock, auth, {
          entityType: "user",
          entityId: user.id,
          action: "created",
          before: null,
          after: snapshot(user),
        });
        return toDto(user);
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw ApiException.emailAlreadyExists();
      }
      throw error;
    }
  }

  async update(id: string, input: UpdateUser, auth: AuthContext): Promise<AdminUser> {
    return runSerializable(this.prisma, async (tx) => {
      const before = await tx.user.findUnique({ where: { id }, select: USER_SELECT });
      if (!before) {
        throw notFound();
      }
      if (input.role !== undefined) {
        assertRoleFits(input.role, before.organization.type);
      }
      const role = input.role !== undefined ? fromUserRole(input.role) : before.role;
      const isActive = input.isActive ?? before.isActive;
      const displayName = input.displayName ?? before.displayName;
      const roleChanged = role !== before.role;
      const deactivated = before.isActive && !isActive;
      if (!roleChanged && isActive === before.isActive && displayName === before.displayName) {
        return toDto(before);
      }

      const losesAdministration = before.role === "ADMINISTRATOR" && before.isActive && (role !== "ADMINISTRATOR" || !isActive);
      if (losesAdministration && (await this.otherActiveAdministrators(tx, id)) === 0) {
        throw ApiException.lastActiveAdministrator();
      }

      const after = await tx.user.update({
        where: { id },
        data: { role, isActive, displayName, updatedAt: this.clock.now() },
        select: USER_SELECT,
      });
      const reason: SessionRevocationReason | null = deactivated ? "user_deactivated" : roleChanged ? "role_changed" : null;
      const revokedSessions = reason ? await revokeSessions(tx, this.clock, { userId: id }, reason) : 0;
      await recordAudit(tx, this.clock, auth, {
        entityType: "user",
        entityId: id,
        action: "updated",
        before: snapshot(before),
        after: { ...snapshot(after), revokedSessions },
      });
      return toDto(after);
    });
  }

  async resetPassword(id: string, input: ResetPassword, auth: AuthContext): Promise<AdminUser> {
    const passwordHash = await this.passwords.hash(input.password);
    return runSerializable(this.prisma, async (tx) => {
      const exists = await tx.user.findUnique({ where: { id }, select: { id: true } });
      if (!exists) {
        throw notFound();
      }
      const user = await tx.user.update({
        where: { id },
        data: { passwordHash, updatedAt: this.clock.now() },
        select: USER_SELECT,
      });
      const revokedSessions = await revokeSessions(tx, this.clock, { userId: id }, "password_reset");
      // Neither the password nor its hash is ever audited.
      await recordAudit(tx, this.clock, auth, {
        entityType: "user",
        entityId: id,
        action: "password_reset",
        before: null,
        after: { id, revokedSessions },
      });
      return toDto(user);
    });
  }

  /** Counts administrators who could still sign in if `excludedId` lost the role. */
  private otherActiveAdministrators(tx: Prisma.TransactionClient, excludedId: string): Promise<number> {
    return tx.user.count({
      where: {
        id: { not: excludedId },
        role: "ADMINISTRATOR",
        isActive: true,
        organization: { type: "DISTRIBUTOR", isActive: true },
      },
    });
  }
}
