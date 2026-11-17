import { test } from "node:test";
import assert from "node:assert/strict";
import { BodyTooLargeError, checkIngestAuth, readBodyCapped, safeEqual } from "./ingest-auth";

test("ingest fails closed when no token is configured, whatever the request sends", () => {
  assert.deepEqual(checkIngestAuth("Bearer anything", undefined), { ok: false, reason: "not_configured" });
  assert.deepEqual(checkIngestAuth("Bearer ", ""), { ok: false, reason: "not_configured" });
  assert.deepEqual(checkIngestAuth(null, "   "), { ok: false, reason: "not_configured" });
});

test("a configured token must be sent exactly as a bearer token", () => {
  const token = "s3cr3t-token-value";
  assert.deepEqual(checkIngestAuth(`Bearer ${token}`, token), { ok: true });
  assert.deepEqual(checkIngestAuth(null, token), { ok: false, reason: "missing" });
  assert.deepEqual(checkIngestAuth(token, token), { ok: false, reason: "mismatch" });
  assert.deepEqual(checkIngestAuth(`Bearer ${token}x`, token), { ok: false, reason: "mismatch" });
  assert.deepEqual(checkIngestAuth(`bearer ${token}`, token), { ok: false, reason: "mismatch" });
});

test("safeEqual compares strings of any length", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
});

test("bodies over the cap are rejected, with or without Content-Length", async () => {
  const small = new Request("http://x/api/ingest", { method: "POST", body: "{}" });
  assert.equal(await readBodyCapped(small, 16), "{}");

  const declared = new Request("http://x/api/ingest", {
    method: "POST",
    body: "x".repeat(32),
    headers: { "content-length": "32" },
  });
  await assert.rejects(readBodyCapped(declared, 16), BodyTooLargeError);

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < 4; i++) c.enqueue(new TextEncoder().encode("y".repeat(10)));
      c.close();
    },
  });
  const chunked = new Request("http://x/api/ingest", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  await assert.rejects(readBodyCapped(chunked, 16), BodyTooLargeError);
});
