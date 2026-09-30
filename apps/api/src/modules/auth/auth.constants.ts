export const SESSION_COOKIE_NAME = "pandora_session";
export const CSRF_HEADER_NAME = "x-csrf-token";

export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000;
/** Sliding-expiry writes are throttled; the idle limit is still enforced on every request. */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;
/** Unusable sessions are kept this long for diagnostics before cleanup removes them. */
export const SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

/** At most this many sign-in attempts per normalized email within the rolling window. */
export const LOGIN_ATTEMPT_LIMIT = 5;
export const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
