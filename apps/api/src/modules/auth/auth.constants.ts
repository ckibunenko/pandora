export const SESSION_COOKIE_NAME = "pandora_session";
export const CSRF_HEADER_NAME = "x-csrf-token";

export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000;
/** Sliding-expiry writes are throttled; the idle limit is still enforced on every request. */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;
