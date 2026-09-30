import type { OrganizationType, SessionUser, UserRole } from "@pandora/contracts";
import type { OrganizationType as DbOrganizationType, UserRole as DbUserRole } from "../../generated/prisma/client.js";

interface UserWithOrganization {
  id: string;
  email: string;
  displayName: string;
  role: DbUserRole;
  organization: { id: string; name: string; type: DbOrganizationType };
}

export function toUserRole(role: DbUserRole): UserRole {
  switch (role) {
    case "RETAILER":
      return "retailer";
    case "OPERATOR":
      return "operator";
    case "ADMINISTRATOR":
      return "administrator";
  }
}

export function fromUserRole(role: UserRole): DbUserRole {
  switch (role) {
    case "retailer":
      return "RETAILER";
    case "operator":
      return "OPERATOR";
    case "administrator":
      return "ADMINISTRATOR";
  }
}

export function toOrganizationType(type: DbOrganizationType): OrganizationType {
  switch (type) {
    case "DISTRIBUTOR":
      return "distributor";
    case "RETAILER":
      return "retailer";
  }
}

/** Selects only public fields; never pass a full user record (it includes the password hash). */
export function toSessionUser(user: UserWithOrganization): SessionUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: toUserRole(user.role),
    organization: {
      id: user.organization.id,
      name: user.organization.name,
      type: toOrganizationType(user.organization.type),
    },
  };
}
