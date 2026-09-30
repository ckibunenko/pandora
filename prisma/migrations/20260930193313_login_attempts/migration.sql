-- CreateTable
CREATE TABLE "login_attempts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "key_hash" CHAR(64) NOT NULL,
    "attempted_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "login_attempts_key_hash_attempted_at_idx" ON "login_attempts"("key_hash", "attempted_at");

-- Only a hex SHA-256 digest may be stored, never a raw email address.

ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_key_hash_format" CHECK ("key_hash" ~ '^[0-9a-f]{64}$');
