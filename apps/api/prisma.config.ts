import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

const ROOT_ENV_FILE = "../../.env";

if (existsSync(ROOT_ENV_FILE)) {
  process.loadEnvFile(ROOT_ENV_FILE);
}

export default defineConfig({
  schema: "../../prisma/schema.prisma",
  migrations: {
    path: "../../prisma/migrations",
  },
  datasource: {
    // Read lazily so `prisma generate` works without a database; the API validates this at startup.
    url: process.env["DATABASE_URL"],
  },
});
