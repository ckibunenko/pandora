import type { AuthContext } from "../modules/auth/auth-context.js";

declare global {
  namespace Express {
    interface Request {
      /** Set by SessionGuard for authenticated requests. */
      auth?: AuthContext;
    }
  }
}
