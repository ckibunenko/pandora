import { Injectable, type PipeTransform } from "@nestjs/common";
import type { ErrorDetail } from "@pandora/contracts";
import type { z } from "zod";
import { ApiException } from "../errors/api-exception.js";

function fieldPath(path: readonly PropertyKey[]): string {
  return path.length > 0 ? path.map(String).join(".") : "(root)";
}

function toErrorDetails(issue: z.core.$ZodIssue): ErrorDetail[] {
  // Report each unexpected key as its own field instead of one error on the parent object.
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => ({ field: fieldPath([...issue.path, key]), message: "Unexpected field." }));
  }
  return [{ field: fieldPath(issue.path), message: issue.message }];
}

@Injectable()
export class ZodValidationPipe<TSchema extends z.ZodType> implements PipeTransform<unknown, z.infer<TSchema>> {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): z.infer<TSchema> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw ApiException.validationFailed(result.error.issues.flatMap(toErrorDetails));
    }
    return result.data;
  }
}
