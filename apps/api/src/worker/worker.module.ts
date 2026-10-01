import { Module, type DynamicModule } from "@nestjs/common";
import { BugLabModule } from "../common/bug-lab/bug-lab.js";
import { ClockModule } from "../common/clock/clock.module.js";
import { AppConfigModule } from "../common/config/app-config.module.js";
import { WORKER_CONFIG, type WorkerConfig } from "../common/config/worker-config.js";
import { PrismaModule } from "../infrastructure/prisma/prisma.module.js";
import { FailingTransport, MailTransport, SmtpTransport } from "./mail-transport.js";
import { NotificationWorker } from "./notification-worker.js";

@Module({})
export class WorkerModule {
  static forRoot(config: WorkerConfig): DynamicModule {
    return {
      module: WorkerModule,
      // BugLabModule refuses a database whose defect marker does not match, exactly as the API does.
      imports: [AppConfigModule.forRoot(config), ClockModule, PrismaModule, BugLabModule],
      providers: [
        { provide: WORKER_CONFIG, useValue: config },
        { provide: MailTransport, useValue: config.failureMode === "none" ? new SmtpTransport(config) : new FailingTransport(config.failureMode) },
        NotificationWorker,
      ],
    };
  }
}
