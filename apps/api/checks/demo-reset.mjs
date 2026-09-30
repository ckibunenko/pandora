// Only an explicitly named empty QA database; never the development or user demo database.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../dist/generated/prisma/client.js";
import { PasswordHasher } from "../dist/modules/auth/password-hasher.js";
import { restoreDemoData } from "../dist/seed/restore-demo-data.js";

const database = process.env.DEMO_CHECK_DATABASE;
assert.match(database ?? "", /^pandora_demo_check_[a-z0-9_]+$/);
const url = new URL(process.env.DATABASE_URL);
assert.notEqual(url.pathname.slice(1), database);
url.pathname = `/${database}`;
const env = { ...process.env, DATABASE_URL: url.toString(), NODE_ENV: "test" };
const client = () => new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL, max: 1 }) });
const db = client();
let passed = 0;
async function check(label, work) { await work(); console.log(`PASS ${label}`); passed++; }
const ADMIN = "01920000-0000-7000-8000-000000000101";
const ORG = "01920000-0000-7000-8000-000000000001";
const snapshot = async () => ({
  organizations: await db.organization.findMany({ orderBy: { id: "asc" } }),
  users: await db.user.findMany({ orderBy: { id: "asc" } }),
  sessions: await db.session.findMany({ orderBy: { id: "asc" } }),
  inventory: await db.inventoryItem.findMany({ orderBy: { variantId: "asc" } }),
  orders: await db.order.findMany({ orderBy: { id: "asc" } }),
  receipts: await db.idempotencyRecord.findMany(),
  sequence: await db.$queryRaw`SELECT last_value, is_called FROM orders_number_seq`,
});

try {
  assert.equal((await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`).length, 0);
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], { env, stdio: "pipe" });
  const hash = await new PasswordHasher().hash(process.env.SEED_USER_PASSWORD);
  await check("empty database restored with all lifecycle fixtures and valid constraints", async () => {
    await restoreDemoData(db, database, hash);
    assert.equal(await db.order.count(), 9);
    assert.equal(await db.shipment.count(), 1);
    assert.equal(await db.cancellationRequest.count(), 1);
    assert.equal(await db.user.count(), 6);
  });
  const inventory = await db.inventoryItem.findMany({ select: { variantId: true, sellable: true, reserved: true, damaged: true }, orderBy: { variantId: "asc" } });

  await db.user.update({ where: { id: ADMIN }, data: { displayName: "Changed Administrator" } });
  await db.organization.create({ data: { name: "Temporary Demo Store", type: "RETAILER" } });
  const now = new Date();
  await db.session.create({ data: { userId: ADMIN, tokenHash: "qa-only-old-token", csrfToken: "qa-only-csrf", createdAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + 3600000) } });
  await db.idempotencyRecord.create({ data: { organizationId: ORG, actorId: ADMIN, operation: "qa", target: "qa", key: "qa-key", requestHash: "a".repeat(64), status: "COMPLETED", leaseExpiresAt: now, createdAt: now, completedAt: now, responseStatus: 200, responseBody: { old: true } } });
  await db.$queryRaw`SELECT nextval('orders_number_seq')`;
  const changed = await snapshot();

  await check("wrong names and mismatched connected database rejected without changing data", async () => {
    await assert.rejects(restoreDemoData(db, "pandora", hash), /Only dedicated/);
    await assert.rejects(restoreDemoData(db, "pandora_demo_check_wrong", hash), /Wrong database/);
    assert.deepEqual(await snapshot(), changed);
  });
  await check("another connected client prevents reset; existing data survives", async () => {
    const other = client();
    try {
      await other.$queryRaw`SELECT 1`;
      await assert.rejects(restoreDemoData(db, database, hash), /Stop all other/);
      assert.deepEqual(await snapshot(), changed);
    } finally { await other.$disconnect(); }
  });
  await check("seed failure rolls back truncation, sessions, receipts, and sequence restart", async () => {
    await db.$executeRaw`CREATE FUNCTION qa_fail_demo_seed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA seed failure'; END $$`;
    await db.$executeRaw`CREATE TRIGGER qa_fail_demo_seed BEFORE INSERT ON organizations FOR EACH ROW EXECUTE FUNCTION qa_fail_demo_seed()`;
    try {
      await assert.rejects(restoreDemoData(db, database, hash));
      assert.deepEqual(await snapshot(), changed);
    } finally {
      await db.$executeRaw`DROP TRIGGER qa_fail_demo_seed ON organizations`;
      await db.$executeRaw`DROP FUNCTION qa_fail_demo_seed()`;
    }
  });
  await check("successful retry clears old access/receipts, removes additions, and restores inventory and numbering", async () => {
    await restoreDemoData(db, database, hash);
    assert.equal(await db.session.count(), 0);
    assert.equal(await db.idempotencyRecord.count(), 0);
    assert.equal(await db.organization.count(), 4);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: ADMIN } })).displayName, "Ada Administrator");
    assert.deepEqual(await db.inventoryItem.findMany({ select: { variantId: true, sellable: true, reserved: true, damaged: true }, orderBy: { variantId: "asc" } }), inventory);
    assert.equal((await db.$queryRaw`SELECT nextval('orders_number_seq') AS n`)[0].n, 1001n);
    assert.equal((await db.$queryRaw`SELECT nextval('shipments_number_seq') AS n`)[0].n, 1001n);
  });
  await check("repeated reset reproduces fixture counts, inventory, and sequence start", async () => {
    await restoreDemoData(db, database, hash);
    assert.equal(await db.order.count(), 9);
    assert.deepEqual(await db.inventoryItem.findMany({ select: { variantId: true, sellable: true, reserved: true, damaged: true }, orderBy: { variantId: "asc" } }), inventory);
    assert.equal((await db.$queryRaw`SELECT nextval('orders_number_seq') AS n`)[0].n, 1001n);
  });
  console.log(`${passed} demo reset check groups passed.`);
} finally { await db.$disconnect(); }
