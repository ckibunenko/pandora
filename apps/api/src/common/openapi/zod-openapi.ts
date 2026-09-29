import type { SchemaObject } from "@nestjs/swagger";
import { z } from "zod";

/** Converts a contract schema so OpenAPI documents the same rules the API enforces at runtime. */
export function openApiSchema(schema: z.ZodType, io: "input" | "output" = "output"): SchemaObject {
  const jsonSchema = z.toJSONSchema(schema, { target: "openapi-3.0", io });
  delete jsonSchema.$schema;
  // Zod's openapi-3.0 target emits OpenAPI-compatible JSON Schema; Swagger's SchemaObject type is only narrower.
  return jsonSchema as SchemaObject;
}
