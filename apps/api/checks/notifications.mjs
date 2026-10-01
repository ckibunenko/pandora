// Outbox, worker delivery, retry, and diagnostics checks against an isolated, empty QA database and an SMTP stub.
// Usage: see context/features/notifications-verification.md.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { notificationListResponseSchema, notificationSchema } from "@pandora/contracts";
import { assertError, startQaApi } from "./harness.mjs";
import { startSmtpStub } from "./smtp-stub.mjs";

const qa = await startQaApi({
  databaseEnv: "NOTIFICATIONS_CHECK_DATABASE",
  databasePattern: /^pandora_notifications_check_[a-z0-9_]+$/,
  portEnv: "NOTIFICATIONS_CHECK_PORT",
  defaultPort: "3027",
});
const { db, call, login, check } = qa;
const smtp = await startSmtpStub();

const post = (actor, path, body, key = randomUUID()) => call(path, { actor, method: "POST", body, key });
const workerLogs = [];
const workers = new Set();

function startWorker(env = {}) {
  const child = spawn(process.execPath, ["dist/worker.js"], {
    env: {
      ...process.env,
      DATABASE_URL: qa.databaseUrl,
      NODE_ENV: "test",
      NOTIFICATION_SMTP_URL: `smtp://127.0.0.1:${smtp.port}`,
      NOTIFICATION_POLL_INTERVAL_MS: "100",
      NOTIFICATION_LEASE_MS: "5000",
      NOTIFICATION_SEND_TIMEOUT_MS: "2000",
      NOTIFICATION_RETRY_DELAYS_MS: "150",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const worker = {
    child,
    exited,
    output: () => output,
    async stop(signal = "SIGTERM") {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      await exited;
      workers.delete(worker);
      workerLogs.push(output);
    },
  };
  workers.add(worker);
  return worker;
}

async function until(condition, label, timeout = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await condition();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

const jobsFor = (orderId) =>
  db.notificationJob.findMany({
    where: { orderId },
    include: { attempts: { orderBy: { number: "asc" } }, recipient: { select: { email: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
const recipientsByEvent = async (orderId) => {
  const result = {};
  for (const job of await jobsFor(orderId)) (result[job.eventType] ??= []).push(job.recipient.email);
  for (const list of Object.values(result)) list.sort();
  return result;
};
const allSettled = async (orderId) => (await jobsFor(orderId)).every((job) => ["SENT", "FAILED"].includes(job.status));
const businessSnapshot = async () => ({
  orders: await db.order.findMany({ select: { id: true, status: true, version: true }, orderBy: { id: "asc" } }),
  inventory: await db.inventoryItem.findMany({ select: { variantId: true, sellable: true, reserved: true, damaged: true }, orderBy: { variantId: "asc" } }),
  movements: await db.inventoryMovement.count(),
  returns: await db.returnRequest.findMany({ select: { id: true, status: true }, orderBy: { id: "asc" } }),
});

let operator;
let lantern;
async function submitted(actor, lines) {
  const draft = await post(actor, "/orders", { lines });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const result = await post(actor, `/orders/${draft.body.id}/submit`, {
    version: 1,
    reviewedPrices: draft.body.lines.map((l) => ({ variantId: l.variantId, unitPriceMinor: l.unitPriceMinor })),
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
const confirm = async (order) => {
  const result = await post(operator, `/orders/${order.id}/confirm`, { version: order.version });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};

const STAFF = ["admin@pandora.test", "operator@pandora.test"];
const TARA = ["retailer@tabletop-lantern.test"];

try {
  operator = await login("operator@pandora.test");
  const admin = await login("admin@pandora.test");
  lantern = await login("retailer@tabletop-lantern.test");
  const keep = await login("retailer@cardboard-keep.test");
  const variant = async (sku) => (await db.productVariant.findUniqueOrThrow({ where: { sku } })).id;
  const lov = await variant("LOV-EN-STD");
  const tkc = await variant("TKC-EN-STD");
  const mbm = await variant("MBM-SR-STD");

  let lifecycle;
  await check("enqueue: every business event creates one job per active recipient, without a worker", async () => {
    assert.equal(await db.notificationJob.count(), 0, "the seed enqueues nothing");
    lifecycle = await submitted(lantern, [{ variantId: lov, quantity: 3 }, { variantId: tkc, quantity: 2 }]);
    lifecycle = await confirm(lifecycle);
    const line = (sku) => lifecycle.lines.find((l) => l.sku === sku);
    assert.equal((await post(operator, `/orders/${lifecycle.id}/shipments`, { version: 3, items: [{ orderLineId: line("LOV-EN-STD").id, quantity: 2 }] })).status, 200);
    let result = await post(lantern, `/orders/${lifecycle.id}/cancellation-requests`, { version: 4, items: [{ orderLineId: line("TKC-EN-STD").id, quantity: 1 }], reason: "Too many" });
    result = await post(operator, `/orders/${lifecycle.id}/cancellation-requests/${result.body.cancellationRequests[0].id}/approve`, { version: 5 });
    result = await post(operator, `/orders/${lifecycle.id}/shipments`, { version: 6, items: result.body.lines.filter((l) => l.outstandingQuantity > 0).map((l) => ({ orderLineId: l.id, quantity: l.outstandingQuantity })) });
    assert.equal(result.body.status, "closed_partial");
    const shipmentItem = result.body.shipments[0].items[0];
    result = await post(lantern, `/orders/${lifecycle.id}/returns`, { reason: "Damaged box", items: [{ shipmentItemId: shipmentItem.id, quantity: 1 }] });
    const returned = result.body.returns[0];
    assert.equal((await post(operator, `/orders/${lifecycle.id}/returns/${returned.id}/approve`, {})).status, 200);
    result = await post(admin, `/orders/${lifecycle.id}/returns/${returned.id}/receive`, { items: [{ returnItemId: returned.items[0].id, sellableQuantity: 1, damagedQuantity: 0 }] });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(await recipientsByEvent(lifecycle.id), {
      "order.submitted": STAFF,
      "order.confirmed": TARA,
      "shipment.recorded": [...TARA, ...TARA],
      "cancellation.requested": STAFF,
      "cancellation.decided": TARA,
      "return.requested": STAFF,
      "return.decided": TARA,
      "return.received": TARA,
    });

    const negative = await confirm(await submitted(keep, [{ variantId: mbm, quantity: 1 }]));
    const cancelled = await post(keep, `/orders/${negative.id}/cancellation-requests`, { version: 3 });
    await post(operator, `/orders/${negative.id}/cancellation-requests/${cancelled.body.cancellationRequests[0].id}/reject`, { version: 4, reason: "Already packed" });
    const rejectedOrder = await submitted(keep, [{ variantId: mbm, quantity: 1 }]);
    await post(operator, `/orders/${rejectedOrder.id}/reject`, { version: 2, reason: "Duplicate order" });
    assert.deepEqual(await recipientsByEvent(negative.id), {
      "order.submitted": STAFF,
      "order.confirmed": ["retailer@cardboard-keep.test"],
      "cancellation.requested": STAFF,
      "cancellation.decided": ["retailer@cardboard-keep.test"],
    });
    assert.deepEqual(await recipientsByEvent(rejectedOrder.id), { "order.submitted": STAFF, "order.rejected": ["retailer@cardboard-keep.test"] });
    const rejection = (await jobsFor(rejectedOrder.id)).find((job) => job.eventType === "order.rejected");
    assert.match(rejection.subject, /^PO-\d{6} rejected$/);
    assert.match(rejection.body, /Hello Kira Keep,[\s\S]*Reason: Duplicate order/);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: rejectedOrder.id, action: "rejected" } });
    assert.equal(rejection.correlationId, audit.correlationId, "job and audit share the request's correlation ID");
    const pending = await db.notificationJob.findMany({ select: { status: true, attemptCount: true, maxAttempts: true } });
    assert.ok(pending.every((job) => job.status === "PENDING" && job.attemptCount === 0 && job.maxAttempts === 5));
    assert.equal(await db.notificationJob.count({ where: { recipient: { email: "former@tabletop-lantern.test" } } }), 0, "inactive users get nothing");
  });

  await check("rollback and idempotency: an audit failure leaves no job; a replay adds none; the unique key rejects duplicates", async () => {
    const draft = await post(lantern, "/orders", { lines: [{ variantId: lov, quantity: 1 }] });
    const key = randomUUID();
    const body = { version: 1, reviewedPrices: draft.body.lines.map((l) => ({ variantId: l.variantId, unitPriceMinor: l.unitPriceMinor })) };
    await db.$executeRaw`CREATE FUNCTION reject_notifications_check_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected QA audit failure'; END; $$`;
    await db.$executeRaw`CREATE TRIGGER reject_notifications_check_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_notifications_check_audit()`;
    try {
      assertError(await post(lantern, `/orders/${draft.body.id}/submit`, body, key), 500, "INTERNAL_ERROR");
      assert.equal(await db.notificationJob.count({ where: { orderId: draft.body.id } }), 0);
    } finally {
      await db.$executeRaw`DROP TRIGGER reject_notifications_check_audit ON audit_events`;
      await db.$executeRaw`DROP FUNCTION reject_notifications_check_audit()`;
    }
    const first = await post(lantern, `/orders/${draft.body.id}/submit`, body, key);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual((await post(lantern, `/orders/${draft.body.id}/submit`, body, key)).body, first.body);
    assert.equal(await db.notificationJob.count({ where: { orderId: draft.body.id } }), 2);
    const job = await db.notificationJob.findFirstOrThrow({ where: { orderId: draft.body.id } });
    await assert.rejects(
      db.$executeRaw`INSERT INTO notification_jobs (event_type, event_key, order_id, recipient_user_id, recipient_email, subject, body, status, max_attempts, next_attempt_at, correlation_id, created_at)
        SELECT event_type, event_key, order_id, recipient_user_id, recipient_email, subject, body, 'PENDING', 5, now(), correlation_id, now() FROM notification_jobs WHERE id = ${job.id}::uuid`,
      /unique|duplicate/i,
    );
  });

  await check("delivery: the worker sends every job over SMTP with correlation headers; business data is untouched", async () => {
    const before = await businessSnapshot();
    const total = await db.notificationJob.count();
    const worker = startWorker();
    await until(async () => (await db.notificationJob.count({ where: { status: "SENT" } })) === total, "all jobs sent");
    await worker.stop();
    assert.equal(smtp.messages.length, total);
    const jobs = await db.notificationJob.findMany({ include: { attempts: true } });
    const byId = new Map(smtp.messages.map((message) => [message.headers["x-pandora-notification"], message]));
    assert.equal(byId.size, total, "each job delivered once");
    for (const job of jobs) {
      const message = byId.get(job.id);
      assert.deepEqual(message.to, [job.recipientEmail]);
      assert.equal(message.headers["x-correlation-id"], job.correlationId);
      assert.equal(message.headers["x-pandora-event"], job.eventType);
      assert.equal(message.headers.subject, job.subject);
      assert.ok(job.sentAt && job.leaseOwner === null && job.lastError === null && job.attemptCount === 1);
      assert.deepEqual(job.attempts.map((a) => a.outcome), ["SENT"]);
    }
    assert.deepEqual(await businessSnapshot(), before, "delivery never writes business tables");
    assert.match(worker.output(), /Notification sent/);
    assert.doesNotMatch(worker.output(), /@pandora\.test|@tabletop-lantern\.test|Hello /, "logs carry IDs, not addresses or bodies");
  });

  await check("retries: transient failures then success; a permanent failure stops at once; exhausted retries end failed", async () => {
    smtp.setMode("transient");
    const order = await submitted(lantern, [{ variantId: lov, quantity: 1 }]);
    const worker = startWorker();
    await until(async () => (await jobsFor(order.id)).every((job) => job.attemptCount >= 2), "two failed attempts each");
    smtp.setMode("accept");
    await until(() => allSettled(order.id), "sent after recovery");
    for (const job of await jobsFor(order.id)) {
      assert.equal(job.status, "SENT");
      assert.equal(job.attempts.at(-1).outcome, "SENT");
      assert.ok(job.attempts.slice(0, -1).every((a) => a.outcome === "FAILED" && /451/.test(a.error)));
      assert.equal(job.lastError, null);
    }

    smtp.setMode("permanent");
    const permanent = await submitted(lantern, [{ variantId: tkc, quantity: 1 }]);
    await until(() => allSettled(permanent.id), "permanent failure settles");
    for (const job of await jobsFor(permanent.id)) {
      assert.deepEqual([job.status, job.attemptCount, job.attempts.map((a) => a.outcome)], ["FAILED", 1, ["FAILED"]]);
      assert.match(job.lastError, /550/);
    }

    smtp.setMode("transient");
    const exhausted = await confirm(order);
    const confirmed = await until(async () => (await jobsFor(exhausted.id)).find((job) => job.eventType === "order.confirmed" && job.status === "FAILED"), "retries exhausted");
    assert.equal(confirmed.attemptCount, 5);
    assert.deepEqual(confirmed.attempts.map((a) => a.outcome), ["FAILED", "FAILED", "FAILED", "FAILED", "FAILED"]);
    assert.equal((await db.order.findUniqueOrThrow({ where: { id: exhausted.id } })).status, "CONFIRMED", "failed delivery never undoes the change");
    await worker.stop();
    smtp.setMode("accept");
  });

  await check("ambiguous attempt: a worker killed mid-send loses its lease; the next worker marks the attempt ambiguous and delivers", async () => {
    smtp.setMode("hang");
    const order = await confirm(await submitted(keep, [{ variantId: mbm, quantity: 1 }]));
    await db.notificationJob.updateMany({ where: { orderId: order.id, eventType: "order.submitted" }, data: { status: "FAILED" } });
    const timing = { NOTIFICATION_LEASE_MS: "1500", NOTIFICATION_SEND_TIMEOUT_MS: "1400" };
    const hanging = smtp.dataReceived;
    const first = startWorker(timing);
    await until(() => smtp.dataReceived > hanging, "message data reached the hanging server");
    await first.stop("SIGKILL");
    const [held] = (await jobsFor(order.id)).filter((job) => job.eventType === "order.confirmed");
    assert.deepEqual([held.status, held.attempts.map((a) => a.outcome)], ["SENDING", ["IN_PROGRESS"]]);
    smtp.setMode("accept");
    const second = startWorker(timing);
    const [done] = await until(async () => {
      const jobs = (await jobsFor(order.id)).filter((job) => job.eventType === "order.confirmed" && job.status === "SENT");
      return jobs.length ? jobs : null;
    }, "delivered by the second worker");
    await second.stop();
    assert.deepEqual(done.attempts.map((a) => a.outcome), ["AMBIGUOUS", "SENT"]);
    assert.match(done.attempts[0].error, /may or may not have been delivered/);
    assert.notEqual(done.attempts[0].workerId, done.attempts[1].workerId);
  });

  await check("graceful stop: the job in flight finishes, claimed but unsent jobs are released at once, none stays sending", async () => {
    smtp.setMode("hang");
    const order = await submitted(lantern, [{ variantId: tkc, quantity: 1 }]);
    const ids = (await jobsFor(order.id)).map((job) => job.id);
    const hanging = smtp.dataReceived;
    const worker = startWorker({ NOTIFICATION_SEND_TIMEOUT_MS: "1000" });
    await until(() => smtp.dataReceived > hanging, "first message hangs");
    await worker.stop("SIGTERM");
    assert.match(worker.output(), /Released unsent notifications on shutdown/);
    const jobs = await jobsFor(order.id);
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every((job) => job.status === "PENDING" && job.leaseOwner === null), "nothing left sending");
    const outcomes = jobs.map((job) => job.attempts.map((a) => `${a.outcome}:${/stopped before/.test(a.error ?? "") ? "released" : "timeout"}`)[0]).sort();
    assert.deepEqual(outcomes, ["FAILED:released", "FAILED:timeout"]);
    smtp.setMode("accept");
    const next = startWorker();
    await until(async () => (await db.notificationJob.count({ where: { id: { in: ids }, status: "SENT" } })) === 2, "delivered after restart");
    await next.stop();
  });

  await check("concurrency: two workers in parallel deliver each job exactly once", async () => {
    smtp.setMode("accept");
    const orders = [];
    for (let i = 0; i < 6; i += 1) orders.push(await submitted(lantern, [{ variantId: lov, quantity: 1 }]));
    const ids = (await db.notificationJob.findMany({ where: { orderId: { in: orders.map((o) => o.id) } }, select: { id: true } })).map((j) => j.id);
    assert.equal(ids.length, 12);
    const before = smtp.messages.length;
    const pair = [startWorker({ NOTIFICATION_BATCH_SIZE: "2" }), startWorker({ NOTIFICATION_BATCH_SIZE: "2" })];
    await until(async () => (await db.notificationJob.count({ where: { id: { in: ids }, status: "SENT" } })) === ids.length, "all sent");
    await Promise.all(pair.map((worker) => worker.stop()));
    const delivered = smtp.messages.slice(before).map((m) => m.headers["x-pandora-notification"]).filter((id) => ids.includes(id));
    assert.equal(delivered.length, ids.length);
    assert.equal(new Set(delivered).size, ids.length, "no job delivered twice");
    assert.equal(await db.notificationAttempt.count({ where: { jobId: { in: ids } } }), ids.length);
    const owners = await db.notificationAttempt.findMany({ where: { jobId: { in: ids } }, distinct: ["workerId"], select: { workerId: true } });
    assert.ok(owners.length >= 1);
  });

  await check("diagnostics: staff only; operators get no addresses or bodies; filters, pagination, and detail attempts", async () => {
    assertError(await call("/notifications", { actor: lantern }), 403, "FORBIDDEN");
    assertError(await call("/notifications"), 401, "UNAUTHENTICATED");
    const total = await db.notificationJob.count();
    const operatorList = notificationListResponseSchema.parse((await call("/notifications?pageSize=100", { actor: operator })).body);
    assert.equal(operatorList.total, total);
    assert.ok(operatorList.items.every((item) => item.recipientEmail === null));
    const adminList = notificationListResponseSchema.parse((await call("/notifications?pageSize=100", { actor: admin })).body);
    assert.ok(adminList.items.every((item) => /@/.test(item.recipientEmail)));
    const sorted = [...adminList.items].sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
    assert.deepEqual(adminList.items.map((i) => i.id), sorted.map((i) => i.id), "newest first with an ID tie-breaker");
    const failed = (await call("/notifications?status=failed&eventType=order.submitted", { actor: operator })).body;
    assert.ok(failed.total >= 2 && failed.items.every((i) => i.status === "failed" && i.eventType === "order.submitted"));
    const pageTwo = (await call("/notifications?pageSize=20&page=2", { actor: admin })).body;
    assert.deepEqual(pageTwo.items.map((i) => i.id), adminList.items.slice(20, 40).map((i) => i.id));
    assertError(await call("/notifications?status=lost", { actor: admin }), 422, "VALIDATION_FAILED");
    assertError(await call("/notifications?eventType=order.drafted", { actor: admin }), 422, "VALIDATION_FAILED");
    const id = failed.items.find((item) => item.attemptCount > 0).id;
    const asOperator = notificationSchema.parse((await call(`/notifications/${id}`, { actor: operator })).body);
    assert.deepEqual([asOperator.recipientEmail, asOperator.body], [null, null]);
    assert.ok(asOperator.attempts.length >= 1 && asOperator.attempts.every((a) => a.workerId && a.startedAt));
    const asAdmin = notificationSchema.parse((await call(`/notifications/${id}`, { actor: admin })).body);
    assert.match(asAdmin.body, /^Hello /);
    assertError(await call(`/notifications/${randomUUID()}`, { actor: admin }), 404, "NOT_FOUND");
  });

  await check("manual retry: one more attempt, replay-safe and audited; other states refuse; key and role required", async () => {
    const job = await db.notificationJob.findFirstOrThrow({ where: { status: "FAILED", eventType: "order.confirmed" } });
    assertError(await call(`/notifications/${job.id}/retry`, { actor: operator, method: "POST", body: {} }), 400, "IDEMPOTENCY_KEY_REQUIRED");
    assertError(await post(lantern, `/notifications/${job.id}/retry`, {}), 403, "FORBIDDEN");
    assertError(await call(`/notifications/${job.id}/retry`, { actor: operator, method: "POST", body: {}, key: randomUUID(), csrf: false }), 403, "CSRF_TOKEN_INVALID");
    const key = randomUUID();
    const retried = await post(operator, `/notifications/${job.id}/retry`, {}, key);
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.deepEqual([retried.body.status, retried.body.attemptCount, retried.body.maxAttempts], ["pending", 5, 6]);
    assert.deepEqual((await post(operator, `/notifications/${job.id}/retry`, {}, key)).body, retried.body, "replay");
    const again = await post(admin, `/notifications/${job.id}/retry`, {});
    assertError(again, 409, "NOTIFICATION_NOT_RETRYABLE");
    const audit = await db.auditEvent.findMany({ where: { entityType: "notification", entityId: job.id } });
    assert.deepEqual(audit.map((event) => event.action), ["retry_requested"]);
    const visible = (await call(`/audit-events?entityType=notification&entityId=${job.id}`, { actor: operator })).body;
    assert.equal(visible.total, 1, "operators see notification audit");
    const worker = startWorker();
    const sent = await until(async () => {
      const current = await db.notificationJob.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: { orderBy: { number: "asc" } } } });
      return current.status === "SENT" ? current : null;
    }, "retried job sent");
    await worker.stop();
    assert.deepEqual(sent.attempts.map((a) => a.outcome), ["FAILED", "FAILED", "FAILED", "FAILED", "FAILED", "SENT"]);
    assertError(await post(operator, `/notifications/${job.id}/retry`, {}), 409, "NOTIFICATION_NOT_RETRYABLE");
  });

  await check("worker configuration: Bug Lab misconfiguration and production failure modes are refused; the failure adapter fails without SMTP", async () => {
    const refusals = [
      [{ BUG_LAB_DEFECT: "BUG-001" }, /pandora_buglab/],
      [{ BUG_LAB_DEFECT: "BUG-001", NODE_ENV: "production" }, /refused when NODE_ENV is production/],
      [{ NOTIFICATION_FAILURE_MODE: "permanent", NODE_ENV: "production" }, /controlled failures are refused/],
      [{ BUG_LAB_DEFECT: "BUG-999" }, /BUG_LAB_DEFECT/],
      [{ NOTIFICATION_SEND_TIMEOUT_MS: "5000", NOTIFICATION_LEASE_MS: "5000" }, /shorter than NOTIFICATION_LEASE_MS/],
      [{ NOTIFICATION_SMTP_URL: "http://127.0.0.1:1025" }, /NOTIFICATION_SMTP_URL/],
    ];
    for (const [env, message] of refusals) {
      const worker = startWorker(env);
      assert.equal(await worker.exited, 1, JSON.stringify(env));
      await worker.stop();
      assert.match(worker.output(), message);
    }
    const order = await submitted(lantern, [{ variantId: tkc, quantity: 1 }]);
    const before = smtp.messages.length;
    const failing = startWorker({ NOTIFICATION_FAILURE_MODE: "permanent" });
    await until(() => allSettled(order.id), "controlled failures settle");
    await failing.stop();
    assert.equal(smtp.messages.length, before, "nothing reaches SMTP");
    for (const job of await jobsFor(order.id)) {
      assert.equal(job.status, "FAILED");
      assert.match(job.lastError, /Controlled permanent delivery failure/);
    }
  });

  await check("database rejects invalid job states, edited content, deletions, and rewritten attempts", async () => {
    const job = await db.notificationJob.findFirstOrThrow({ where: { status: "SENT" }, include: { attempts: true } });
    const pending = await db.notificationJob.findFirstOrThrow({ where: { status: "FAILED" } });
    await assert.rejects(db.$executeRaw`UPDATE notification_jobs SET status = 'PENDING', sent_at = NULL WHERE id = ${job.id}::uuid`, /sent notification cannot change/);
    await assert.rejects(db.$executeRaw`UPDATE notification_jobs SET body = 'Edited' WHERE id = ${pending.id}::uuid`, /immutable/);
    await assert.rejects(db.$executeRaw`UPDATE notification_jobs SET status = 'SENDING' WHERE id = ${pending.id}::uuid`, "sending needs a lease");
    await assert.rejects(db.$executeRaw`UPDATE notification_jobs SET attempt_count = 9 WHERE id = ${pending.id}::uuid`, "attempts within budget");
    await assert.rejects(db.$executeRaw`DELETE FROM notification_jobs WHERE id = ${pending.id}::uuid`, /never deleted/);
    await assert.rejects(db.$executeRaw`UPDATE notification_attempts SET outcome = 'FAILED', error = 'x' WHERE id = ${job.attempts[0].id}::uuid`, /once/);
    await assert.rejects(db.$executeRaw`DELETE FROM notification_attempts WHERE id = ${job.attempts[0].id}::uuid`, /never deleted/);
  });

  await check("OpenAPI documents the diagnostics routes and the retry Idempotency-Key header", async () => {
    const document = await (await fetch(`${qa.origin}/openapi.json`)).json();
    assert.ok(document.paths["/api/notifications"]?.get);
    assert.ok(document.paths["/api/notifications/{notificationId}"]?.get);
    const retry = document.paths["/api/notifications/{notificationId}/retry"]?.post;
    assert.ok(retry?.parameters.some((p) => p.in === "header" && p.name === "Idempotency-Key"));
  });

  assert.ok(!/pandora-demo|argon2|pandora_session=/.test(qa.logs() + workerLogs.join("")), "logs must not contain credentials or tokens");
  console.log(`\n${qa.passed} notification check groups passed.`);
} catch (error) {
  console.error(qa.logs().slice(-3000));
  console.error([...workers].map((worker) => worker.output()).concat(workerLogs).join("\n").slice(-4000));
  throw error;
} finally {
  await Promise.all([...workers].map((worker) => worker.stop("SIGKILL")));
  await smtp.stop();
  await qa.stop();
}
