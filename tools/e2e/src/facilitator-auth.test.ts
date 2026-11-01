import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import crypto from "node:crypto";
import { assertUsableToken, authorizationMatches, MIN_MAINNET_TOKEN_LENGTH } from "./facilitator-auth.js";

const TOKEN = "3f1c9a7e5b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d2f4a";

describe("facilitator bearer token (CodeQL js/user-controlled-bypass)", () => {
  test("accepts the raw token (gateway facilitator.apiKey) and Bearer <token>", () => {
    assert.equal(authorizationMatches(TOKEN, TOKEN), true);
    assert.equal(authorizationMatches(`Bearer ${TOKEN}`, TOKEN), true);
    assert.equal(authorizationMatches(`bearer   ${TOKEN}`, TOKEN), true);
  });

  test("rejects missing, wrong, truncated and extended tokens", () => {
    for (const header of [undefined, "", "Bearer", "Bearer ", TOKEN.slice(0, -1), `${TOKEN}x`, `Basic ${TOKEN}`, TOKEN.toUpperCase()]) {
      assert.equal(authorizationMatches(header, TOKEN), false, `header ${String(header)}`);
    }
  });

  test("compares with crypto.timingSafeEqual on equal-length digests, both forms every time", () => {
    const spy = mock.method(crypto, "timingSafeEqual");
    try {
      for (const header of ["x", "x".repeat(10_000), TOKEN, `Bearer ${TOKEN}`]) {
        spy.mock.resetCalls();
        authorizationMatches(header, TOKEN);
        assert.equal(spy.mock.callCount(), 2, "raw and bearer forms are both compared (no early exit)");
        for (const call of spy.mock.calls) {
          const [a, b] = call.arguments as [Buffer, Buffer];
          assert.equal(a.length, 32);
          assert.equal(b.length, 32);
        }
      }
    } finally {
      spy.mock.restore();
    }
  });

  test("an empty configured token is a configuration error, never a match", () => {
    assert.throws(() => authorizationMatches("", ""));
  });

  test("token rules: required on mainnet, minimum length, no whitespace", () => {
    const mainnet = { required: true, minLength: MIN_MAINNET_TOKEN_LENGTH, label: "token" };
    assert.throws(() => assertUsableToken(undefined, mainnet), /required/);
    assert.throws(() => assertUsableToken("short", mainnet), /at least 32/);
    assert.throws(() => assertUsableToken(`${TOKEN} x`, mainnet), /whitespace/);
    assert.doesNotThrow(() => assertUsableToken(TOKEN, mainnet));
    assert.doesNotThrow(() => assertUsableToken(undefined, { required: false, minLength: 1, label: "token" }));
  });
});
