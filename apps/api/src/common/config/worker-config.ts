import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { baseEnvShape, bugLabDefectFor, InvalidConfigError, parseEnv, type BaseConfig } from "./app-config.js";

export const WORKER_CONFIG = Symbol("WORKER_CONFIG");

const delayList = z
  .string()
  .regex(/^\d+(,\d+)*$/, "must be comma-separated whole milliseconds")
  .transform((value) => value.split(",").map(Number));

const workerEnvSchema = z.object({
  ...baseEnvShape,
  NOTIFICATION_SMTP_URL: z.url({ protocol: /^smtp$/ }),
  NOTIFICATION_FROM: z.string().trim().min(3).max(200).default("Pandora Distribution <notifications@pandora.test>"),
  NOTIFICATION_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(2_000),
  NOTIFICATION_LEASE_MS: z.coerce.number().int().min(500).max(3_600_000).default(60_000),
  NOTIFICATION_SEND_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
  /** Delay before attempt n+1 after attempt n failed; the last value repeats. */
  NOTIFICATION_RETRY_DELAYS_MS: delayList.default([60_000, 300_000, 900_000, 3_600_000]),
  NOTIFICATION_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  /** Controlled delivery failures for isolated environments (overview §9); refused in production. */
  NOTIFICATION_FAILURE_MODE: z.enum(["none", "transient", "permanent"]).default("none"),
});

export interface WorkerConfig extends BaseConfig {
  readonly workerId: string;
  readonly smtpUrl: URL;
  readonly from: string;
  readonly pollIntervalMs: number;
  readonly leaseMs: number;
  readonly sendTimeoutMs: number;
  readonly retryDelaysMs: readonly number[];
  readonly batchSize: number;
  readonly failureMode: "none" | "transient" | "permanent";
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = parseEnv(workerEnvSchema, env, "notification worker");
  const defect = bugLabDefectFor(parsed, "notification worker");
  if (parsed.NOTIFICATION_FAILURE_MODE !== "none" && parsed.NODE_ENV === "production") {
    throw new InvalidConfigError(
      "Invalid notification worker configuration:\n  - NOTIFICATION_FAILURE_MODE: controlled failures are refused when NODE_ENV is production.",
    );
  }
  if (parsed.NOTIFICATION_SEND_TIMEOUT_MS >= parsed.NOTIFICATION_LEASE_MS) {
    throw new InvalidConfigError(
      "Invalid notification worker configuration:\n  - NOTIFICATION_SEND_TIMEOUT_MS: must be shorter than NOTIFICATION_LEASE_MS.",
    );
  }
  return {
    environment: parsed.NODE_ENV,
    databaseUrl: parsed.DATABASE_URL,
    bugLabDefect: defect,
    workerId: `${hostname().slice(0, 24)}-${process.pid}-${randomUUID().slice(0, 8)}`,
    smtpUrl: new URL(parsed.NOTIFICATION_SMTP_URL),
    from: parsed.NOTIFICATION_FROM,
    pollIntervalMs: parsed.NOTIFICATION_POLL_INTERVAL_MS,
    leaseMs: parsed.NOTIFICATION_LEASE_MS,
    sendTimeoutMs: parsed.NOTIFICATION_SEND_TIMEOUT_MS,
    retryDelaysMs: parsed.NOTIFICATION_RETRY_DELAYS_MS,
    batchSize: parsed.NOTIFICATION_BATCH_SIZE,
    failureMode: parsed.NOTIFICATION_FAILURE_MODE,
  };
}
