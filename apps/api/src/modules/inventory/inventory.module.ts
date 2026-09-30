import { Module } from "@nestjs/common";
import { IdempotencyService } from "../../common/idempotency/idempotency.service.js";
import { InventoryController } from "./inventory.controller.js";
import { InventoryService } from "./inventory.service.js";

@Module({
  controllers: [InventoryController],
  providers: [InventoryService, IdempotencyService],
})
export class InventoryModule {}
