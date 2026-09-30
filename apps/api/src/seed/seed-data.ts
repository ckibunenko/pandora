import type { Prisma, OrganizationType, UserRole } from "../generated/prisma/client.js";
import { seedCatalog } from "./catalog-seed.js";
import { seedInventory } from "./inventory-seed.js";
import { seedOrders } from "./orders-seed.js";

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

export async function seedData(tx: Prisma.TransactionClient, passwordHash: string): Promise<{ openingMovements: number; orders: number }> {
  await seedCatalog(tx);
  for (const { id, ...organization } of ORGANIZATIONS) {
    await tx.organization.upsert({ where: { id }, create: { id, ...organization }, update: organization });
  }
  for (const { id, ...user } of USERS) {
    const data = { ...user, passwordHash };
    await tx.user.upsert({ where: { id }, create: { id, ...data }, update: data });
  }
  return {
    openingMovements: await seedInventory(tx),
    orders: await seedOrders(
      tx,
      {
        tabletopLantern: { organizationId: TABLETOP_LANTERN_ID, userId: "01920000-0000-7000-8000-000000000201" },
        cardboardKeep: { organizationId: CARDBOARD_KEEP_ID, userId: "01920000-0000-7000-8000-000000000301" },
      },
      { organizationId: DISTRIBUTOR_ID, userId: "01920000-0000-7000-8000-000000000102" },
    ),
  };
}
