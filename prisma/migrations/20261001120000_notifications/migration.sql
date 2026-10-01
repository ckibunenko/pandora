-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationAttemptOutcome" AS ENUM ('IN_PROGRESS', 'SENT', 'FAILED', 'AMBIGUOUS');

-- CreateTable
CREATE TABLE "notification_jobs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "event_type" VARCHAR(64) NOT NULL,
    "event_key" VARCHAR(160) NOT NULL,
    "order_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "recipient_email" VARCHAR(320) NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "body" VARCHAR(4000) NOT NULL,
    "status" "NotificationStatus" NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL,
    "lease_owner" VARCHAR(64),
    "lease_expires_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(500),
    "correlation_id" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "notification_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_attempts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "job_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "worker_id" VARCHAR(64) NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    "outcome" "NotificationAttemptOutcome" NOT NULL,
    "error" VARCHAR(500),

    CONSTRAINT "notification_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_jobs_status_next_attempt_at_idx" ON "notification_jobs"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "notification_jobs_created_at_id_idx" ON "notification_jobs"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "notification_jobs_order_id_idx" ON "notification_jobs"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_jobs_event_key_recipient_user_id_key" ON "notification_jobs"("event_key", "recipient_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_attempts_job_id_number_key" ON "notification_attempts"("job_id", "number");

-- AddForeignKey
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_attempts" ADD CONSTRAINT "notification_attempts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "notification_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written invariants that the Prisma schema cannot express.

-- A lease exists exactly while a worker is sending; a sent job records when; attempts stay within the budget.
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_state" CHECK (
  "attempt_count" >= 0 AND "max_attempts" >= 1 AND "attempt_count" <= "max_attempts"
  AND (("status" = 'SENDING') = ("lease_owner" IS NOT NULL))
  AND (("lease_owner" IS NULL) = ("lease_expires_at" IS NULL))
  AND (("status" = 'SENT') = ("sent_at" IS NOT NULL))
  AND ("status" <> 'SENDING' OR "attempt_count" >= 1)
);

ALTER TABLE "notification_attempts" ADD CONSTRAINT "notification_attempts_state" CHECK (
  "number" >= 1
  AND (("outcome" = 'IN_PROGRESS') = ("finished_at" IS NULL))
  AND ("outcome" NOT IN ('FAILED', 'AMBIGUOUS') OR "error" IS NOT NULL)
);

-- Rendered content and identity never change after enqueue; jobs are kept as delivery history.
CREATE FUNCTION enforce_notification_job_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Notification jobs are never deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.event_type IS DISTINCT FROM OLD.event_type OR NEW.event_key IS DISTINCT FROM OLD.event_key
    OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
    OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email OR NEW.subject IS DISTINCT FROM OLD.subject
    OR NEW.body IS DISTINCT FROM OLD.body OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Notification content and identity are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'SENT' THEN
    RAISE EXCEPTION 'A sent notification cannot change' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'Attempt counts only grow' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notification_jobs_rules BEFORE UPDATE OR DELETE ON "notification_jobs"
  FOR EACH ROW EXECUTE FUNCTION enforce_notification_job_rules();

-- An attempt records its outcome once; attempts are never deleted.
CREATE FUNCTION enforce_notification_attempt_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Notification attempts are never deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.outcome <> 'IN_PROGRESS' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.number IS DISTINCT FROM OLD.number OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
    OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'A notification attempt records its outcome once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notification_attempts_rules BEFORE UPDATE OR DELETE ON "notification_attempts"
  FOR EACH ROW EXECUTE FUNCTION enforce_notification_attempt_rules();
