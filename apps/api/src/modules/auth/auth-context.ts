import type { SessionUser } from "@pandora/contracts";

export interface AuthContext {
  readonly sessionId: string;
  readonly csrfToken: string;
  readonly user: SessionUser;
}
