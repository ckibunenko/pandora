import { Prisma } from "../../generated/prisma/client.js";

/** Prisma's PostgreSQL `contains` filter uses LIKE patterns; escape them for a literal substring search. */
export const literalSearch = (value: string): string => value.replace(/[\\%_]/g, (character) => `\\${character}`);

export function statusWhere(status: "all" | "active" | "inactive"): { isActive?: boolean } {
  return status === "all" ? {} : { isActive: status === "active" };
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
