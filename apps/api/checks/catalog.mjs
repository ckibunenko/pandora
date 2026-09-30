import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../dist/generated/prisma/client.js";
import {
  catalogResponseSchema,
  productSchema,
  variantSchema,
} from "@pandora/contracts";

const databaseName = process.env.CATALOG_CHECK_DATABASE;
assert.match(
  databaseName ?? "",
  /^pandora_catalog_check_[a-z0-9_]+$/,
  "Set CATALOG_CHECK_DATABASE to a separate, empty QA database created for this run.",
);
const url = new URL(process.env.DATABASE_URL);
assert.notEqual(
  url.pathname.slice(1),
  databaseName,
  "QA database must differ from the configured development database.",
);
url.pathname = `/${databaseName}`;
const port = process.env.CATALOG_CHECK_PORT ?? "3011";
const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  NODE_ENV: "test",
  CATALOG_CURRENCY: "EUR",
  API_PORT: port,
};
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const existingTables =
  await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
assert.equal(
  existingTables.length,
  0,
  "Refusing to modify a nonempty QA database. Create a new database for each run.",
);
execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
  env,
  stdio: "pipe",
});
execFileSync(process.execPath, ["dist/seed/seed.js"], { env, stdio: "pipe" });
const baseline = await Promise.all([
  db.product.count(),
  db.productVariant.count(),
  db.user.count(),
  db.organization.count(),
]);
assert.deepEqual(
  baseline,
  [8, 11, 6, 4],
  "Use a fresh QA database for every run.",
);
execFileSync(process.execPath, ["dist/seed/seed.js"], { env, stdio: "pipe" });
assert.deepEqual(
  await Promise.all([
    db.product.count(),
    db.productVariant.count(),
    db.user.count(),
    db.organization.count(),
    db.auditEvent.count(),
  ]),
  [8, 11, 6, 4, 0],
);
const server = spawn(process.execPath, ["dist/main.js"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (data) => {
  logs += data;
});
server.stderr.on("data", (data) => {
  logs += data;
});
const origin = `http://127.0.0.1:${port}/api`;
let checks = 0;
async function check(label, operation) {
  await operation();
  checks++;
  console.log(`PASS ${label}`);
}
async function call(
  path,
  { actor, method = "GET", body, csrf = true, headers = {} } = {},
) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(actor ? { Cookie: actor.cookie } : {}),
      ...(actor && csrf ? { "X-CSRF-Token": actor.csrf } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    body: response.status === 204 ? undefined : await response.json(),
    headers: response.headers,
  };
}
async function login(email) {
  const result = await call("/auth/login", {
    method: "POST",
    body: { email, password: process.env.SEED_USER_PASSWORD },
  });
  assert.equal(result.status, 200);
  return {
    cookie: result.headers.get("set-cookie").split(";")[0],
    csrf: result.body.csrfToken,
  };
}
const browse = "/catalog/products";
const adminPath = "/admin/catalog/products";
const fixtureId = (n) =>
  `01920000-0000-7000-8000-${String(1000 + n).padStart(12, "0")}`;
const input = {
  name: "QA catalog product",
  publisher: "QA Studio",
  description: "Isolated test product.",
  type: "base_game",
  isActive: true,
};
const variantInput = {
  sku: "QA-EN-001",
  language: "en",
  edition: "Standard",
  unitPriceMinor: 1000,
  isActive: true,
};
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null)
      throw new Error(`API exited during startup: ${logs}`);
    try {
      if ((await fetch(`${origin}/health/ready`)).ok) break;
    } catch {
      /* readiness polling only; no concurrency assertions depend on timing */
    }
    await delay(50);
  }
  assert.equal((await fetch(`${origin}/health/ready`)).status, 200);
  const admin = await login("admin@pandora.test");
  const operator = await login("operator@pandora.test");
  const retailer = await login("retailer@tabletop-lantern.test");
  const retailer2 = await login("retailer@cardboard-keep.test");
  const paths = [
    [browse, "GET"],
    [`${browse}/${fixtureId(1)}`, "GET"],
    [adminPath, "GET"],
    [`${adminPath}/${fixtureId(1)}`, "GET"],
    [adminPath, "POST", input],
    [`${adminPath}/${fixtureId(1)}`, "PATCH", { name: "Forbidden" }],
    [`${adminPath}/${fixtureId(1)}/variants`, "POST", variantInput],
    [
      `${adminPath}/${fixtureId(1)}/variants/01920000-0000-7000-8000-000000002001`,
      "PATCH",
      { edition: "Forbidden" },
    ],
  ];
  await check(
    "all endpoints require authentication; admin endpoints enforce roles and CSRF",
    async () => {
      for (const [path, method, body] of paths) {
        assert.equal((await call(path, { method, body })).status, 401);
        if (path.startsWith(adminPath))
          for (const actor of [operator, retailer, retailer2])
            assert.equal(
              (await call(path, { actor, method, body })).status,
              403,
            );
        if (method !== "GET") {
          assert.equal(
            (await call(path, { actor: admin, method, body, csrf: false }))
              .status,
            403,
          );
          assert.equal(
            (
              await call(path, {
                actor: admin,
                method,
                body,
                headers: { "X-CSRF-Token": "wrong" },
              })
            ).status,
            403,
          );
        }
      }
      assert.equal(await db.auditEvent.count(), 0);
    },
  );
  await check(
    "visibility, selected variant contracts, language/type/SKU filters and literal search",
    async () => {
      for (const actor of [admin, operator, retailer, retailer2]) {
        const result = await call(browse, { actor });
        assert.equal(result.status, 200);
        catalogResponseSchema.parse(result.body);
        assert.equal(result.body.total, 7);
        assert.equal(
          (await call(`${browse}/${fixtureId(8)}`, { actor })).status,
          404,
        );
        assert.equal(
          (await call(`${browse}/${fixtureId(6)}`, { actor })).body.variants
            .length,
          1,
        );
      }
      assert.equal((await call(adminPath, { actor: admin })).body.total, 8);
      assert.equal(
        (await call(`${adminPath}?status=inactive`, { actor: admin })).body
          .total,
        1,
      );
      assert.equal(
        (await call(`${browse}?language=sr`, { actor: retailer })).body.total,
        2,
      );
      assert.equal(
        (
          await call(`${browse}?type=expansion&language=en`, {
            actor: retailer,
          })
        ).body.total,
        2,
      );
      assert.equal(
        (await call(`${browse}?q=LOV-SR`, { actor: retailer })).body.total,
        1,
      );
      assert.equal(
        (await call(`${browse}?q=MBM-EN`, { actor: retailer })).body.total,
        0,
      );
      assert.equal(
        (await call(`${adminPath}?q=MBM-EN`, { actor: admin })).body.total,
        1,
      );
      for (const q of ["%", "_", "\\"])
        assert.equal(
          (
            await call(`${browse}?q=${encodeURIComponent(q)}`, {
              actor: retailer,
            })
          ).body.total,
          0,
        );
      for (const size of [20, 50, 100])
        assert.equal(
          (await call(`${browse}?pageSize=${size}`, { actor: retailer })).body
            .pageSize,
          size,
        );
      for (const query of [
        "page=0",
        "page=1.5",
        "page=1e2",
        "pageSize=25",
        "language=de",
        "status=all",
        "unknown=x",
      ])
        assert.equal(
          (await call(`${browse}?${query}`, { actor: retailer })).status,
          422,
        );
      assert.equal(
        (await call(`${browse}/not-a-uuid`, { actor: retailer })).status,
        422,
      );
    },
  );
  let product;
  let variant;
  await check(
    "create, canonical SKU, integer price limits and preserved audit attribution",
    async () => {
      let result = await call(adminPath, {
        actor: admin,
        method: "POST",
        body: input,
        headers: { "X-Correlation-Id": "catalog-create-check" },
      });
      assert.equal(result.status, 201);
      product = productSchema.parse(result.body);
      assert.equal(
        (await call(`${browse}/${product.id}`, { actor: retailer })).status,
        404,
      );
      result = await call(`${adminPath}/${product.id}/variants`, {
        actor: admin,
        method: "POST",
        body: { ...variantInput, sku: "  qa-en-001  ", unitPriceMinor: 0 },
      });
      assert.equal(result.status, 201);
      variant = variantSchema.parse(result.body);
      assert.equal(variant.sku, "QA-EN-001");
      assert.equal(variant.unitPriceMinor, 0);
      assert.equal(
        (await call(`${browse}/${product.id}`, { actor: retailer })).status,
        200,
      );
      const audit = await db.auditEvent.findFirstOrThrow({
        where: { entityId: product.id },
      });
      assert.equal(audit.correlationId, "catalog-create-check");
      assert.equal(audit.actorId, "01920000-0000-7000-8000-000000000101");
      assert.equal(audit.before, null);
      assert.deepEqual(
        Object.keys(audit.after).sort(),
        [
          "baseProductId",
          "description",
          "id",
          "isActive",
          "name",
          "publisher",
          "type",
        ].sort(),
      );
      for (const unitPriceMinor of [-1, 0.5, 2147483648])
        assert.equal(
          (
            await call(`${adminPath}/${product.id}/variants`, {
              actor: admin,
              method: "POST",
              body: { ...variantInput, sku: "QA-INVALID", unitPriceMinor },
            })
          ).status,
          422,
        );
      result = await call(`${adminPath}/${product.id}/variants/${variant.id}`, {
        actor: admin,
        method: "PATCH",
        body: { unitPriceMinor: 2147483647 },
      });
      assert.equal(result.status, 200);
      const count = await db.auditEvent.count();
      assert.equal(
        (
          await call(`${adminPath}/${product.id}/variants/${variant.id}`, {
            actor: admin,
            method: "PATCH",
            body: { unitPriceMinor: 2147483647 },
          })
        ).status,
        200,
      );
      assert.equal(
        await db.auditEvent.count(),
        count,
        "No-op creates no audit event",
      );
      assert.equal(
        (
          await call(`${adminPath}/${fixtureId(1)}/variants/${variant.id}`, {
            actor: admin,
            method: "PATCH",
            body: { edition: "Wrong product" },
          })
        ).status,
        404,
      );
    },
  );
  await check(
    "invalid and immutable fields leave no committed effects",
    async () => {
      const counts = await Promise.all([
        db.product.count(),
        db.productVariant.count(),
        db.auditEvent.count(),
      ]);
      for (const body of [
        {},
        { name: " " },
        { type: "expansion" },
        { baseProductId: fixtureId(1) },
        { unknown: 1 },
      ])
        assert.equal(
          (
            await call(`${adminPath}/${product.id}`, {
              actor: admin,
              method: "PATCH",
              body,
            })
          ).status,
          422,
        );
      for (const body of [
        { sku: "CHANGED" },
        { productId: fixtureId(1) },
        {},
        { language: "de" },
      ])
        assert.equal(
          (
            await call(`${adminPath}/${product.id}/variants/${variant.id}`, {
              actor: admin,
              method: "PATCH",
              body,
            })
          ).status,
          422,
        );
      for (const body of [
        { ...input, type: "expansion", baseProductId: fixtureId(2) },
        { ...input, type: "expansion", baseProductId: fixtureId(999) },
        { ...input, type: "expansion" },
        { ...input, baseProductId: fixtureId(1) },
      ])
        assert.equal(
          (await call(adminPath, { actor: admin, method: "POST", body }))
            .status,
          422,
        );
      assert.deepEqual(
        await Promise.all([
          db.product.count(),
          db.productVariant.count(),
          db.auditEvent.count(),
        ]),
        counts,
      );
    },
  );
  await check("database constraints reject invalid direct writes", async () => {
    await assert.rejects(
      db.productVariant.update({
        where: { id: variant.id },
        data: { sku: "NEW-SKU" },
      }),
    );
    await assert.rejects(
      db.productVariant.update({
        where: { id: variant.id },
        data: { unitPriceMinor: -1 },
      }),
    );
    await assert.rejects(
      db.productVariant.create({
        data: { ...variantInput, productId: product.id, sku: "bad sku" },
      }),
    );
    await assert.rejects(
      db.product.update({
        where: { id: product.id },
        data: { type: "EXPANSION", baseProductId: fixtureId(1) },
      }),
    );
    await assert.rejects(
      db.product.create({
        data: { ...input, type: "EXPANSION", baseProductId: fixtureId(2) },
      }),
    );
  });
  await check(
    "deactivation preserves variants and independent expansion visibility",
    async () => {
      assert.equal(
        (
          await call(`${adminPath}/${fixtureId(1)}`, {
            actor: admin,
            method: "PATCH",
            body: { isActive: false },
          })
        ).status,
        200,
      );
      assert.equal(
        (await call(`${browse}/${fixtureId(1)}`, { actor: retailer })).status,
        404,
      );
      const expansion = await call(`${browse}/${fixtureId(2)}`, {
        actor: retailer,
      });
      assert.equal(expansion.status, 200);
      assert.equal(expansion.body.baseProduct.isVisible, false);
      assert.equal(
        await db.productVariant.count({
          where: { productId: fixtureId(1), isActive: true },
        }),
        2,
      );
      assert.equal(
        (
          await call(`${adminPath}/${fixtureId(1)}`, {
            actor: admin,
            method: "PATCH",
            body: { isActive: true },
          })
        ).status,
        200,
      );
      assert.equal(
        (await call(`${browse}/${fixtureId(1)}`, { actor: retailer })).status,
        200,
      );
      assert.equal(
        (
          await call(`${adminPath}/${product.id}/variants/${variant.id}`, {
            actor: admin,
            method: "PATCH",
            body: { isActive: false },
          })
        ).status,
        200,
      );
      assert.equal(
        (await call(`${browse}/${product.id}`, { actor: retailer })).status,
        404,
      );
      assert.equal(
        (
          await call(`${adminPath}/${product.id}/variants/${variant.id}`, {
            actor: admin,
            method: "PATCH",
            body: { isActive: true },
          })
        ).status,
        200,
      );
    },
  );
  await check(
    "concurrent canonical SKU creation commits exactly one variant and audit",
    async () => {
      const count = await db.auditEvent.count();
      const results = await Promise.all(
        ["QA-CONCURRENT", " qa-concurrent "].map((sku) =>
          call(`${adminPath}/${product.id}/variants`, {
            actor: admin,
            method: "POST",
            body: { ...variantInput, sku },
          }),
        ),
      );
      assert.deepEqual(
        results.map((result) => result.status).sort(),
        [201, 409],
      );
      assert.equal(
        results.find((result) => result.status === 409).body.code,
        "SKU_ALREADY_EXISTS",
      );
      assert.equal(
        await db.productVariant.count({ where: { sku: "QA-CONCURRENT" } }),
        1,
      );
      assert.equal(await db.auditEvent.count(), count + 1);
    },
  );
  await check(
    "audit insertion failure rolls back both create and update",
    async () => {
      await db.$executeRaw`CREATE FUNCTION reject_check_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected QA audit failure'; END; $$`;
      await db.$executeRaw`CREATE TRIGGER reject_check_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_check_audit()`;
      const count = await db.product.count();
      const auditCount = await db.auditEvent.count();
      try {
        assert.equal(
          (
            await call(adminPath, {
              actor: admin,
              method: "POST",
              body: { ...input, name: "Must roll back" },
            })
          ).status,
          500,
        );
        assert.equal(
          (
            await call(`${adminPath}/${product.id}`, {
              actor: admin,
              method: "PATCH",
              body: { name: "Must roll back" },
            })
          ).status,
          500,
        );
        assert.equal(await db.product.count(), count);
        assert.equal(await db.auditEvent.count(), auditCount);
        assert.equal(
          (await db.product.findUniqueOrThrow({ where: { id: product.id } }))
            .name,
          input.name,
        );
      } finally {
        await db.$executeRaw`DROP TRIGGER reject_check_audit ON audit_events`;
        await db.$executeRaw`DROP FUNCTION reject_check_audit()`;
      }
    },
  );
  await check(
    "stable pagination with matching variants, totals, search and combined filters",
    async () => {
      for (let index = 0; index < 41; index++) {
        await db.product.create({
          data: {
            name: "Pagination fixture",
            publisher: "Boundary QA",
            description: "Pagination check",
            type: "BASE_GAME",
            variants: {
              create: [
                {
                  sku: `PAGE-EN-${index}`,
                  language: "en",
                  edition: "Standard",
                  unitPriceMinor: 100,
                },
                {
                  sku: `PAGE-SR-${index}`,
                  language: "sr",
                  edition: "Standard",
                  unitPriceMinor: 100,
                },
              ],
            },
          },
        });
      }
      const pages = await Promise.all(
        [1, 2, 3, 4].map((page) =>
          call(
            `${browse}?q=Boundary%20QA&type=base_game&language=sr&page=${page}`,
            { actor: retailer },
          ),
        ),
      );
      assert.deepEqual(
        pages.map((p) => p.body.items.length),
        [20, 20, 1, 0],
      );
      assert.ok(pages.every((p) => p.body.total === 41));
      const ids = pages.flatMap((p) => p.body.items.map((item) => item.id));
      assert.equal(new Set(ids).size, 41);
      assert.deepEqual(ids, [...ids].sort());
      const repeat = await call(
        `${browse}?q=Boundary%20QA&type=base_game&language=sr&page=2`,
        { actor: retailer },
      );
      assert.deepEqual(repeat.body, pages[1].body);
    },
  );
  await check(
    "published OpenAPI includes all routes and shared contracts",
    async () => {
      const spec = (await call("/openapi.json")).body;
      for (const [path, method] of paths) {
        const template = path
          .replace(/01920000-0000-7000-8000-000000001001/g, "{productId}")
          .replace(/01920000-0000-7000-8000-000000002001/g, "{variantId}");
        assert.ok(spec.paths[`/api${template}`][method.toLowerCase()]);
      }
    },
  );
  await check("session/logout regression", async () => {
    assert.equal(
      (await call("/auth/session", { actor: retailer })).status,
      200,
    );
    assert.equal(
      (await call("/auth/logout", { actor: retailer, method: "POST" })).status,
      204,
    );
    assert.equal((await call(browse, { actor: retailer })).status, 401);
  });
  console.log(
    `Catalog checks passed: ${checks} groups. Isolated database: ${databaseName}.`,
  );
} finally {
  server.kill("SIGTERM");
  await db.$disconnect();
}
