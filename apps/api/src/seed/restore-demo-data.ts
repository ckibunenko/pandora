import type { PrismaClient } from "../generated/prisma/client.js";
import { seedData } from "./seed-data.js";

/** Operator-only: all API/worker processes must be stopped before calling this operation. */
export async function restoreDemoData(prisma: PrismaClient, databaseName: string, passwordHash: string): Promise<void> {
  if (!/^pandora_demo(?:_check_[a-z0-9_]+)?$/.test(databaseName)) {
    throw new Error("Only dedicated demo or disposable demo-check databases can be restored.");
  }
  await prisma.$transaction(async (tx) => {
    const [target] = await tx.$queryRaw<{ name: string; locked: boolean }[]>`
      SELECT current_database() AS name, pg_try_advisory_xact_lock(738291, 1) AS locked`;
    if (target?.name !== databaseName || !target.locked) {
      throw new Error("Wrong database or another reset is already running.");
    }
    const [clients] = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`;
    if (clients?.count !== 0n) {
      throw new Error("Stop all other database clients before restoring the demo.");
    }
    // No CASCADE: a future table referencing this data must be reviewed and added explicitly.
    // TRUNCATE and ALTER SEQUENCE RESTART roll back with seed/verification failures.
    await tx.$executeRaw`TRUNCATE TABLE
      return_request_items, return_requests,
      cancellation_request_items, cancellation_requests, shipment_items, shipments,
      stock_reservations, order_lines, orders, idempotency_records,
      inventory_movements, inventory_items, audit_events, product_variants, products,
      sessions, login_attempts, users, organizations RESTART IDENTITY`;
    await tx.$executeRaw`ALTER SEQUENCE orders_number_seq RESTART WITH 1001`;
    await tx.$executeRaw`ALTER SEQUENCE shipments_number_seq RESTART WITH 1001`;
    await tx.$executeRaw`ALTER SEQUENCE returns_number_seq RESTART WITH 1001`;
    const seeded = await seedData(tx, passwordHash);
    const counts = await Promise.all([
      tx.organization.count(), tx.user.count(), tx.product.count(), tx.productVariant.count(),
      tx.order.count(), tx.session.count(), tx.idempotencyRecord.count(), tx.loginAttempt.count(),
    ]);
    if (seeded.orders !== 9 || counts.join(",") !== "4,6,8,11,9,0,0,0") {
      throw new Error("Demo seed verification failed.");
    }
    // Force all deferred inventory/order/admin constraints before returning success.
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
  }, { timeout: 60_000, maxWait: 10_000 });
}
