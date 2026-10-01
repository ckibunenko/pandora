import { z } from "zod";
import { BUG_LAB_DATABASE, BUG_LAB_DEFECTS, type DefectId } from "../bug-lab/defects.js";

export const APP_CONFIG = Symbol("APP_CONFIG");

export const databaseUrlSchema = z.url({ protocol: /^postgres(ql)?$/ });
const booleanFlagSchema = z.enum(["true", "false"]).transform((value) => value === "true");

/** What every process (API, notification worker) needs: the database, the environment, and the Bug Lab selection. */
export interface BaseConfig {
  readonly environment: "development" | "test" | "production";
  readonly databaseUrl: string;
  readonly bugLabDefect: DefectId | null;
}

export interface AppConfig extends BaseConfig {
  readonly catalogCurrency: "EUR";
  readonly port: number;
  readonly sessionCookieSecure: boolean;
  readonly sessionCleanupIntervalSeconds: number;
}

export class InvalidConfigError extends Error {
  override readonly name = "InvalidConfigError";
}

export function parseEnv<TSchema extends z.ZodType>(schema: TSchema, env: NodeJS.ProcessEnv, label: string): z.infer<TSchema> {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Report variable names and rule messages only; values may contain credentials.
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new InvalidConfigError(`Invalid ${label} configuration:\n${problems}`);
  }
  return result.data;
}

/** Bug Lab isolation (overview §9): never in production (the public demo), never outside a dedicated database. */
export function bugLabDefectFor(
  parsed: { NODE_ENV: BaseConfig["environment"]; DATABASE_URL: string; BUG_LAB_DEFECT?: DefectId | undefined },
  label: string,
): DefectId | null {
  const defect = parsed.BUG_LAB_DEFECT ?? null;
  if (defect && parsed.NODE_ENV === "production") {
    throw new InvalidConfigError(`Invalid ${label} configuration:\n  - BUG_LAB_DEFECT: Bug Lab is refused when NODE_ENV is production.`);
  }
  if (defect && !BUG_LAB_DATABASE.test(new URL(parsed.DATABASE_URL).pathname.slice(1))) {
    throw new InvalidConfigError(`Invalid ${label} configuration:\n  - BUG_LAB_DEFECT: Bug Lab needs a dedicated pandora_buglab… database.`);
  }
  return defect;
}

export const baseEnvShape = {
  NODE_ENV: z.enum(["development", "test", "production"]),
  DATABASE_URL: databaseUrlSchema,
  /** Bug Lab only: exactly one known defect ID; absent means Standard mode. */
  BUG_LAB_DEFECT: z
    .enum(BUG_LAB_DEFECTS, { error: `must be exactly one of ${BUG_LAB_DEFECTS.join(", ")} (one defect at a time)` })
    .optional(),
};

const envSchema = z.object({
  ...baseEnvShape,
  CATALOG_CURRENCY: z.literal("EUR"),
  API_PORT: z.coerce.number().int().min(1).max(65535),
  SESSION_COOKIE_SECURE: booleanFlagSchema,
  /** Optional; checks lower it to observe cleanup without waiting an hour. */
  SESSION_CLEANUP_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(86_400).default(3600),
});

export function loadAppConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = parseEnv(envSchema, env, "API");
  const defect = bugLabDefectFor(parsed, "API");
  return {
    catalogCurrency: parsed.CATALOG_CURRENCY,
    environment: parsed.NODE_ENV,
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.API_PORT,
    sessionCookieSecure: parsed.SESSION_COOKIE_SECURE,
    sessionCleanupIntervalSeconds: parsed.SESSION_CLEANUP_INTERVAL_SECONDS,
    bugLabDefect: defect,
  };
}
