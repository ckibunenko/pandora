import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import { ApiResponse, ApiTags } from "@nestjs/swagger";
import { healthResponseSchema, type HealthResponse } from "@pandora/contracts";
import type { Response } from "express";
import { openApiSchema } from "../../common/openapi/zod-openapi.js";
import { Public } from "../auth/decorators.js";
import { HealthService } from "./health.service.js";

const HEALTH_SCHEMA = openApiSchema(healthResponseSchema);

@ApiTags("health")
@Public()
@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiResponse({ status: 200, description: "The API process is running.", schema: HEALTH_SCHEMA })
  liveness(): HealthResponse {
    return { status: "ok" };
  }

  @Get("ready")
  @ApiResponse({ status: 200, description: "All dependencies are reachable.", schema: HEALTH_SCHEMA })
  @ApiResponse({ status: 503, description: "A dependency is unavailable.", schema: HEALTH_SCHEMA })
  async readiness(@Res({ passthrough: true }) response: Response): Promise<HealthResponse> {
    const database = await this.health.checkDatabase();
    const ready = database === "ok";
    // Set directly rather than thrown: the 503 body is the health contract, not an error envelope.
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? "ok" : "unavailable", checks: { database } };
  }
}
