import { Injectable, Logger } from "@nestjs/common";
import type { HealthStatus } from "@pandora/contracts";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async checkDatabase(): Promise<HealthStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return "ok";
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "unknown error";
      this.logger.warn(`Database readiness check failed: ${reason}`);
      return "unavailable";
    }
  }
}
