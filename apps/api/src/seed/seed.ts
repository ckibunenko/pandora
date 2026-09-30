import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { databaseUrlSchema, InvalidConfigError, parseEnv } from "../common/config/app-config.js";
import { PrismaClient, type OrganizationType, type UserRole } from "../generated/prisma/client.js";
import { PasswordHasher } from "../modules/auth/password-hasher.js";

import { seedCatalog } from "./catalog-seed.js";

const seedEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test"], { error: "seeding only runs when NODE_ENV is development or test" }),
  DATABASE_URL: databaseUrlSchema,
  SEED_USER_PASSWORD: z.string().min(12),
});

interface SeedOrganization {
  id: string;
  name: string;
  type: OrganizationType;
  isActive: boolean;
}

interface SeedUser {
  id: string;
  organizationId: string;
  email: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
}

// Fixed IDs keep the seed deterministic so QA scenarios can reference records directly.
const DISTRIBUTOR_ID = "01920000-0000-7000-8000-000000000001";
const TABLETOP_LANTERN_ID = "01920000-0000-7000-8000-000000000002";
const CARDBOARD_KEEP_ID = "01920000-0000-7000-8000-000000000003";
const CLOSED_SHELF_ID = "01920000-0000-7000-8000-000000000004";

const ORGANIZATIONS: readonly SeedOrganization[] = [
  { id: DISTRIBUTOR_ID, name: "Pandora Distribution", type: "DISTRIBUTOR", isActive: true },
  { id: TABLETOP_LANTERN_ID, name: "Tabletop Lantern", type: "RETAILER", isActive: true },
  { id: CARDBOARD_KEEP_ID, name: "Cardboard Keep", type: "RETAILER", isActive: true },
  { id: CLOSED_SHELF_ID, name: "Closed Shelf Games", type: "RETAILER", isActive: false },
];

const USERS: readonly SeedUser[] = [
  { id: "01920000-0000-7000-8000-000000000101", organizationId: DISTRIBUTOR_ID, email: "admin@pandora.test", displayName: "Ada Administrator", role: "ADMINISTRATOR", isActive: true },
  { id: "01920000-0000-7000-8000-000000000102", organizationId: DISTRIBUTOR_ID, email: "operator@pandora.test", displayName: "Oskar Operator", role: "OPERATOR", isActive: true },
  { id: "01920000-0000-7000-8000-000000000201", organizationId: TABLETOP_LANTERN_ID, email: "retailer@tabletop-lantern.test", displayName: "Tara Lantern", role: "RETAILER", isActive: true },
  { id: "01920000-0000-7000-8000-000000000202", organizationId: TABLETOP_LANTERN_ID, email: "former@tabletop-lantern.test", displayName: "Felix Former", role: "RETAILER", isActive: false },
  { id: "01920000-0000-7000-8000-000000000301", organizationId: CARDBOARD_KEEP_ID, email: "retailer@cardboard-keep.test", displayName: "Kira Keep", role: "RETAILER", isActive: true },
  { id: "01920000-0000-7000-8000-000000000401", organizationId: CLOSED_SHELF_ID, email: "retailer@closed-shelf.test", displayName: "Cole Shelf", role: "RETAILER", isActive: true },
];

async function seed(): Promise<void> {
  const env = parseEnv(seedEnvSchema, process.env, "seed");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
  const passwordHash = await new PasswordHasher().hash(env.SEED_USER_PASSWORD);

  try {
    await prisma.$transaction(async (tx) => {
      await seedCatalog(tx);
      for (const { id, ...organization } of ORGANIZATIONS) {
        await tx.organization.upsert({ where: { id }, create: { id, ...organization }, update: organization });
      }
      for (const { id, ...user } of USERS) {
        const data = { ...user, passwordHash };
        await tx.user.upsert({ where: { id }, create: { id, ...data }, update: data });
      }
    });
    console.log(`Seeded ${ORGANIZATIONS.length} organizations and ${USERS.length} users; 8 catalog products and 11 variants.`);
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
