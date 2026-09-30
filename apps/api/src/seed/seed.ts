import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { databaseUrlSchema, InvalidConfigError, parseEnv } from "../common/config/app-config.js";
import { PrismaClient } from "../generated/prisma/client.js";
import { PasswordHasher } from "../modules/auth/password-hasher.js";
import { seedData } from "./seed-data.js";

const seedEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test"], { error: "seeding only runs when NODE_ENV is development or test" }),
  DATABASE_URL: databaseUrlSchema,
  SEED_USER_PASSWORD: z.string().min(12).max(256),
});

async function seed(): Promise<void> {
  const env = parseEnv(seedEnvSchema, process.env, "seed");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
  try {
    const passwordHash = await new PasswordHasher().hash(env.SEED_USER_PASSWORD);
    const { openingMovements, orders } = await prisma.$transaction((tx) => seedData(tx, passwordHash));
    console.log(
      "Seeded 4 organizations and 6 users; 8 catalog products and 11 variants; " +
        `${openingMovements} new opening-balance movements; ${orders} new demo orders.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

try {
  await seed();
} catch (error: unknown) {
  if (error instanceof InvalidConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
