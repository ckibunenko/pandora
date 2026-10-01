import { Module } from "@nestjs/common";
import { IdempotencyService } from "../../common/idempotency/idempotency.service.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { OrdersController } from "./orders.controller.js";
import { OrdersService } from "./orders.service.js";
import { ReturnsService } from "./returns.service.js";

@Module({
  imports: [NotificationsModule],
  controllers: [OrdersController],
  providers: [OrdersService, ReturnsService, IdempotencyService],
})
export class OrdersModule {}
