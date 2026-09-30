import { Global, Inject, Injectable, Module, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, InvalidConfigError, type AppConfig } from "../config/app-config.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import type { DefectId } from "./defects.js";

/**
 * Tells domain code whether the single selected defect is active. Every defect is guarded at one named place
 * with `bugLab.has("BUG-00X")`; Standard mode (no defect) is always the default.
 */
@Injectable()
export class BugLab implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  has(defect: DefectId): boolean {
    return this.config.bugLabDefect === defect;
  }

  /** The database marker, set only by the Bug Lab setup tool, must match the configured defect in both directions. */
  async onModuleInit(): Promise<void> {
    const [row] = await this.prisma.$queryRaw<{ marker: string | null }[]>`SELECT current_setting('pandora.defect', true) AS marker`;
    const marker = row?.marker ? row.marker : null;
    if (marker !== this.config.bugLabDefect) {
      throw new InvalidConfigError(
        this.config.bugLabDefect
          ? `Bug Lab: the database is marked ${marker ?? "for Standard mode"}, not ${this.config.bugLabDefect}. Prepare a new Bug Lab database with pnpm bug-lab setup.`
          : `Bug Lab: this database is marked for ${marker}; start the API with BUG_LAB_DEFECT=${marker} or use a Standard database.`,
      );
    }
  }
}

@Global()
@Module({ providers: [BugLab], exports: [BugLab] })
export class BugLabModule {}
