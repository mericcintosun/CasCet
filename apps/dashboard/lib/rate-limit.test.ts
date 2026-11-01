import { test } from "node:test";
import assert from "node:assert/strict";
import { clientKey, createRateLimiter, tooManyRequests } from "./rate-limit";

test("a client gets `limit` requests per window, then a 429 with the seconds left", () => {
  let t = 0;
  const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => t });
  for (let i = 0; i < 3; i++) assert.deepEqual(limiter.check("1.2.3.4"), { ok: true });
  assert.deepEqual(limiter.check("1.2.3.4"), { ok: false, retryAfterSeconds: 60 });
  // Other clients have their own window.
  assert.deepEqual(limiter.check("5.6.7.8"), { ok: true });
  t = 59_500;
  assert.deepEqual(limiter.check("1.2.3.4"), { ok: false, retryAfterSeconds: 1 });
  // A new window starts once the old one has passed.
  t = 60_000;
  assert.deepEqual(limiter.check("1.2.3.4"), { ok: true });
});

test("memory stays bounded: expired windows go first, then the oldest", () => {
  let t = 0;
  const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 2, now: () => t });
  limiter.check("a");
  limiter.check("b");
  limiter.check("c"); // full: "a", the oldest, is dropped
  assert.deepEqual(limiter.check("a"), { ok: true }, "a starts over");
  t = 2_000; // every window expired
  assert.deepEqual(limiter.check("b"), { ok: true });
  assert.deepEqual(limiter.check("b").ok, false);
});

test("the client key comes from x-real-ip, else the first x-forwarded-for entry", () => {
  const req = (h: Record<string, string>) => new Request("https://x.test/api", { headers: h });
  assert.equal(clientKey(req({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1" })), "9.9.9.9");
  assert.equal(clientKey(req({ "x-forwarded-for": " 1.1.1.1 , 10.0.0.1" })), "1.1.1.1");
  assert.equal(clientKey(req({})), "unknown");
});

test("a refused request is a 429 with Retry-After", async () => {
  const res = tooManyRequests(12);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "12");
  assert.match(((await res.json()) as { error: string }).error, /try again in 12 s/);
});
