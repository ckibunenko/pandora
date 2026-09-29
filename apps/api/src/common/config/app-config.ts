import { z } from "zod";

export const APP_CONFIG = Symbol("APP_CONFIG");

const envSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  API_PORT: z.coerce.number().int().min(1).max(65535),
});

export interface AppConfig {
  readonly databaseUrl: string;
  readonly port: number;
}

export class InvalidConfigError extends Error {
  override readonly name = "InvalidConfigError";
}

export function loadAppConfig(env: NodeJS.ProcessEnv): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    // Report variable names and rule messages only; values may contain credentials.
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new InvalidConfigError(`Invalid API configuration:\n${problems}`);
  }
  return {
    databaseUrl: result.data.DATABASE_URL,
    port: result.data.API_PORT,
  };
}
