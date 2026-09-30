import { z } from "zod";

export const APP_CONFIG = Symbol("APP_CONFIG");

export const databaseUrlSchema = z.url({ protocol: /^postgres(ql)?$/ });
const booleanFlagSchema = z.enum(["true", "false"]).transform((value) => value === "true");

const envSchema = z.object({
  CATALOG_CURRENCY: z.literal("EUR"),
  NODE_ENV: z.enum(["development", "test", "production"]),
  DATABASE_URL: databaseUrlSchema,
  API_PORT: z.coerce.number().int().min(1).max(65535),
  SESSION_COOKIE_SECURE: booleanFlagSchema,
});

export interface AppConfig {
  readonly catalogCurrency: "EUR";
  readonly environment: "development" | "test" | "production";
  readonly databaseUrl: string;
  readonly port: number;
  readonly sessionCookieSecure: boolean;
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

export function loadAppConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = parseEnv(envSchema, env, "API");
  return {
    catalogCurrency: parsed.CATALOG_CURRENCY,
    environment: parsed.NODE_ENV,
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.API_PORT,
    sessionCookieSecure: parsed.SESSION_COOKIE_SECURE,
  };
}
