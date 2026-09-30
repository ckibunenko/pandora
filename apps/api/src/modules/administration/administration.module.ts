import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { AdminOrganizationsController, AdminUsersController } from "./administration.controller.js";
import { OrganizationsService } from "./organizations.service.js";
import { UsersService } from "./users.service.js";

@Module({
  imports: [AuthModule],
  controllers: [AdminOrganizationsController, AdminUsersController],
  providers: [OrganizationsService, UsersService],
})
export class AdministrationModule {}
