import { Module } from "@nestjs/common";
import { IdempotencyService } from "../../common/idempotency/idempotency.service.js";
import { NotificationOutbox } from "./notification-outbox.js";
import { NotificationsController } from "./notifications.controller.js";
import { NotificationsService } from "./notifications.service.js";

@Module({
  controllers: [NotificationsController],
  providers: [NotificationOutbox, NotificationsService, IdempotencyService],
  exports: [NotificationOutbox],
})
export class NotificationsModule {}
