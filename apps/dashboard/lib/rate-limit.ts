/**
 * A small fixed-window rate limiter for the RPC relay routes (finding L33).
 *
 * In memory, so it is per server instance and best effort: on a serverless
 * host every warm instance counts on its own. That is enough to stop one client
 * from turning /api/revenue/* into a free relay to the Casper node. It is not a
 * quota system.
 */

export interface RateLimitOptions {
  /** Requests allowed per key and window. */
  limit: number;
  windowMs: number;
  /** Most keys tracked at once. When full, expired windows are dropped first, then the oldest. */
  maxKeys?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export type RateLimitDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface RateLimiter {
  check(key: string): RateLimitDecision;
}

export function createRateLimiter(o: RateLimitOptions): RateLimiter {
  const now = o.now ?? Date.now;
  const maxKeys = o.maxKeys ?? 10_000;
  const windows = new Map<string, { count: number; resetAt: number }>();

  const makeRoom = (t: number) => {
    for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
    // Still full: drop the oldest windows (Map keeps insertion order).
    for (const k of windows.keys()) {
      if (windows.size < maxKeys) break;
      windows.delete(k);
    }
  };

  return {
    check(key) {
      const t = now();
      let w = windows.get(key);
      if (!w || w.resetAt <= t) {
        if (w) windows.delete(key);
        else if (windows.size >= maxKeys) makeRoom(t);
        w = { count: 0, resetAt: t + o.windowMs };
        windows.set(key, w);
      }
      w.count += 1;
      if (w.count > o.limit) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - t) / 1000)) };
      return { ok: true };
    },
  };
}

/**
 * The client address a request came from, as the platform reports it (Vercel
 * sets both headers). A missing header shares one "unknown" bucket.
 */
export function clientKey(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

/** The 429 answer for a refused request. */
export function tooManyRequests(retryAfterSeconds: number): Response {
  return Response.json(
    { error: `too many requests: try again in ${retryAfterSeconds} s` },
    { status: 429, headers: { "retry-after": String(retryAfterSeconds) } },
  );
}
