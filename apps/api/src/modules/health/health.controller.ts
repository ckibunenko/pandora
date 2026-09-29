import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import type { HealthResponse } from "@pandora/contracts";
import { HealthService } from "./health.service.js";

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  liveness(): HealthResponse {
    return { status: "ok" };
  }

  @Get("ready")
  async readiness(): Promise<HealthResponse> {
    const database = await this.health.checkDatabase();
    const response: HealthResponse = {
      status: database === "ok" ? "ok" : "unavailable",
      checks: { database },
    };
    if (response.status !== "ok") {
      throw new ServiceUnavailableException(response);
    }
    return response;
  }
}
