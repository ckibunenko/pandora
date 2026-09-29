import "reflect-metadata";
import { ConsoleLogger, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module.js";
import { InvalidConfigError, loadAppConfig } from "./common/config/app-config.js";
import { correlationIdMiddleware } from "./common/request-context/request-context.js";
import { SESSION_COOKIE_NAME } from "./modules/auth/auth.constants.js";

function setupOpenApi(app: INestApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle("Pandora API").setVersion("0.1.0").addCookieAuth(SESSION_COOKIE_NAME).build(),
  );
  SwaggerModule.setup("api/docs", app, document, { jsonDocumentUrl: "api/openapi.json" });
}

async function bootstrap(): Promise<void> {
  const config = loadAppConfig(process.env);
  const app = await NestFactory.create(AppModule.forRoot(config), {
    logger: new ConsoleLogger({ json: true }),
  });
  // Registered before the body parser so even malformed requests carry a correlation ID.
  app.use(correlationIdMiddleware);
  app.use(cookieParser());
  app.setGlobalPrefix("api");
  app.enableShutdownHooks();
  if (config.environment !== "production") {
    setupOpenApi(app);
  }
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
