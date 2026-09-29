import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { InvalidConfigError, loadAppConfig } from "./common/config/app-config.js";

async function bootstrap(): Promise<void> {
  const config = loadAppConfig(process.env);
  const app = await NestFactory.create(AppModule.forRoot(config));
  app.setGlobalPrefix("api");
  app.enableShutdownHooks();
  await app.listen(config.port);
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
