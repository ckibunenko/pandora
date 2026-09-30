import { Module } from "@nestjs/common";
import {
  AdminCatalogController,
  CatalogController,
} from "./catalog.controller.js";
import { CatalogService } from "./catalog.service.js";

@Module({
  controllers: [CatalogController, AdminCatalogController],
  providers: [CatalogService],
})
export class CatalogModule {}
