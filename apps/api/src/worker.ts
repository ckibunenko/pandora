import "reflect-metadata";
import { ConsoleLogger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { InvalidConfigError } from "./common/config/app-config.js";
import { loadWorkerConfig } from "./common/config/worker-config.js";
import { WorkerModule } from "./worker/worker.module.js";

/** Notification worker: a separate process that delivers outbox jobs; run with `node dist/worker.js`. */
async function bootstrap(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), {
    logger: new ConsoleLogger({ json: true }),
  });
  app.enableShutdownHooks();
}

try {
  await bootstrap();
} catch (error: unknown) {
  if (error instanceof InvalidConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
