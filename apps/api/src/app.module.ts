import { Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { ClockModule } from "./common/clock/clock.module.js";
import type { AppConfig } from "./common/config/app-config.js";
import { AppConfigModule } from "./common/config/app-config.module.js";
import { ApiExceptionFilter } from "./common/errors/api-exception.filter.js";
import { PrismaModule } from "./infrastructure/prisma/prisma.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { CatalogModule } from "./modules/catalog/catalog.module.js";
import { InventoryModule } from "./modules/inventory/inventory.module.js";

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [AppConfigModule.forRoot(config), ClockModule, PrismaModule, AuthModule, HealthModule, CatalogModule, InventoryModule],
      providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
    };
  }
}
