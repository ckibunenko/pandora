import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { BUG_LAB_DATABASE } from "../common/bug-lab/defects.js";
import { databaseUrlSchema, InvalidConfigError, parseEnv } from "../common/config/app-config.js";
import { PrismaClient } from "../generated/prisma/client.js";

// Scenario fixtures for Bug Lab databases (Standard comparison included): enough Tabletop Lantern orders that the
// retailer's list spans three pages of 20, so BUG-002 can be reproduced by hand. Created only if missing.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test"], { error: "scenario fixtures only load when NODE_ENV is development or test" }),
  DATABASE_URL: databaseUrlSchema,
});
const TABLETOP_LANTERN_ID = "01920000-0000-7000-8000-000000000002";
const TABLETOP_LANTERN_RETAILER_ID = "01920000-0000-7000-8000-000000000201";
const FIRST = 101;
const COUNT = 40;

async function loadScenario(): Promise<void> {
  const env = parseEnv(envSchema, process.env, "Bug Lab scenario");
  if (!BUG_LAB_DATABASE.test(new URL(env.DATABASE_URL).pathname.slice(1))) {
    throw new InvalidConfigError("Bug Lab scenario fixtures load only into a pandora_buglab… database.");
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
  try {
    const created = await prisma.$transaction(async (tx) => {
      const variant = await tx.productVariant.findUniqueOrThrow({ where: { sku: "LOV-EN-STD" }, select: { id: true } });
      let count = 0;
      for (let n = FIRST; n < FIRST + COUNT; n += 1) {
        const id = `01920000-0000-7000-8000-${String(3000 + n).padStart(12, "0")}`;
        if (await tx.order.findUnique({ where: { id }, select: { id: true } })) continue;
        const at = new Date(Date.UTC(2026, 1, 1, 9) + (n - FIRST) * 60 * 60 * 1000);
        await tx.order.create({
          data: {
            id,
            number: `PO-${String(n).padStart(6, "0")}`,
            organizationId: TABLETOP_LANTERN_ID,
            status: "DRAFT",
            currency: "EUR",
            createdById: TABLETOP_LANTERN_RETAILER_ID,
            createdAt: at,
            updatedAt: at,
            lines: { create: [{ variantId: variant.id, quantity: 1 + (n % 3) }] },
          },
        });
        count += 1;
      }
      return count;
    });
    console.log(`Loaded ${created} new Bug Lab scenario orders (PO-000${FIRST}–PO-000${FIRST + COUNT - 1}).`);
  } finally {
    await prisma.$disconnect();
  }
}

try {
  await loadScenario();
} catch (error: unknown) {
  if (error instanceof InvalidConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
