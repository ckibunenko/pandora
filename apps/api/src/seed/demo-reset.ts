import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { databaseUrlSchema, parseEnv } from "../common/config/app-config.js";
import { PrismaClient } from "../generated/prisma/client.js";
import { PasswordHasher } from "../modules/auth/password-hasher.js";
import { restoreDemoData } from "./restore-demo-data.js";

const schema = z.object({
  DATABASE_URL: databaseUrlSchema,
  SEED_USER_PASSWORD: z.string().min(12).max(256),
  DEMO_RESET_ALLOWED: z.literal("true"),
  NODE_ENV: z.literal("production"),
});

async function main(): Promise<void> {
  const env = parseEnv(schema, process.env, "demo reset");
  const url = new URL(env.DATABASE_URL);
  if (url.hostname !== "postgres" || url.pathname !== "/pandora_demo") {
    throw new Error("Reset requires the isolated Compose database postgres/pandora_demo.");
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
  try {
    const passwordHash = await new PasswordHasher().hash(env.SEED_USER_PASSWORD);
    await restoreDemoData(prisma, "pandora_demo", passwordHash);
    console.log("Demo seed restored and verified. Sessions and idempotency receipts cleared.");
  } finally {
    await prisma.$disconnect();
  }
}

try {
  await main();
} catch {
  // Driver errors may contain a connection URL or parameter data. Keep operator output secret-free.
  console.error("Demo reset failed. Check configuration, migrations, and stopped database clients. Maintenance must remain enabled.");
  process.exitCode = 1;
}
