import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "./common/config/app-config.js";
import { AppConfigModule } from "./common/config/app-config.module.js";
import { PrismaModule } from "./infrastructure/prisma/prisma.module.js";
import { HealthModule } from "./modules/health/health.module.js";

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [AppConfigModule.forRoot(config), PrismaModule, HealthModule],
    };
  }
}
