import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { z } from "zod";
import { Clock } from "../clock/clock.js";
import { ApiException } from "../errors/api-exception.js";
import { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { runSerializable } from "../../infrastructure/prisma/serializable.js";

/** How long an in-progress claim blocks the key before another request may take it over. */
const CLAIM_LEASE_MS = 30_000;

export interface IdempotencyScope {
  readonly organizationId: string;
  readonly actorId: string;
  readonly operation: string;
  readonly target: string;
  readonly key: string;
}

interface Claim {
  readonly id: string;
  readonly leaseExpiresAt: Date;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

@Injectable()
export class IdempotencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /**
   * Executes `work` at most once per scope. A completed request's response is replayed;
   * a failed request releases its claim so nothing records it as successful.
   */
  async execute<T extends Prisma.InputJsonObject>(
    scope: IdempotencyScope,
    payload: unknown,
    responseSchema: z.ZodType<T>,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const requestHash = createHash("sha256")
      .update(canonicalJson({ operation: scope.operation, target: scope.target, payload }))
      .digest("hex");
    const claimOrReplay = await this.claim(scope, requestHash);
    if ("replay" in claimOrReplay) {
      return responseSchema.parse(claimOrReplay.replay);
    }
    const { claim } = claimOrReplay;

    try {
      return await runSerializable(this.prisma, async (tx) => {
        const result = await work(tx);
        const completed = await tx.idempotencyRecord.updateMany({
          where: { id: claim.id, status: "IN_PROGRESS", leaseExpiresAt: claim.leaseExpiresAt },
          data: { status: "COMPLETED", responseStatus: 201, responseBody: result, completedAt: this.clock.now() },
        });
        if (completed.count !== 1) {
          // Our lease expired and another request took over; roll back this attempt's effects.
          throw ApiException.requestInProgress();
        }
        return result;
      });
    } catch (error: unknown) {
      await this.prisma.idempotencyRecord.deleteMany({
        where: { id: claim.id, status: "IN_PROGRESS", leaseExpiresAt: claim.leaseExpiresAt },
      });
      throw error;
    }
  }

  private async claim(
    scope: IdempotencyScope,
    requestHash: string,
  ): Promise<{ claim: Claim } | { replay: Prisma.JsonValue }> {
    const now = this.clock.now();
    const leaseExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);
    const where = {
      organizationId_actorId_operation_target_key: {
        organizationId: scope.organizationId,
        actorId: scope.actorId,
        operation: scope.operation,
        target: scope.target,
        key: scope.key,
      },
    };

    // Committed on its own so concurrent requests with the same key can see the claim.
    const inserted = await this.prisma.idempotencyRecord.createManyAndReturn({
      data: [{ ...where.organizationId_actorId_operation_target_key, requestHash, status: "IN_PROGRESS", leaseExpiresAt, createdAt: now }],
      skipDuplicates: true,
      select: { id: true, leaseExpiresAt: true },
    });
    const own = inserted[0];
    if (own) {
      return { claim: own };
    }

    const existing = await this.prisma.idempotencyRecord.findUnique({
      where,
      select: { id: true, requestHash: true, status: true, leaseExpiresAt: true, responseBody: true },
    });
    if (!existing) {
      // The previous claimant failed and released the key between our insert and read.
      throw ApiException.requestInProgress();
    }
    if (existing.requestHash !== requestHash) {
      throw ApiException.idempotencyKeyReused();
    }
    if (existing.status === "COMPLETED" && existing.responseBody !== null) {
      return { replay: existing.responseBody };
    }
    if (existing.leaseExpiresAt > now) {
      throw ApiException.requestInProgress();
    }
    const takenOver = await this.prisma.idempotencyRecord.updateMany({
      where: { id: existing.id, status: "IN_PROGRESS", leaseExpiresAt: existing.leaseExpiresAt },
      data: { leaseExpiresAt },
    });
    if (takenOver.count !== 1) {
      throw ApiException.requestInProgress();
    }
    return { claim: { id: existing.id, leaseExpiresAt } };
  }
}
