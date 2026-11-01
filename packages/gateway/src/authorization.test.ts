import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCasperAuthorization } from "./authorization.js";

const from = `00${"aa".repeat(32)}`;
const to = `00${"bb".repeat(32)}`;
const nonce = "cc".repeat(32);

function payload(authorization: Record<string, unknown>, x402Version: unknown = 2) {
  return { x402Version, payload: { signature: "00", publicKey: "00", authorization } };
}

const valid = { from, to, value: "500", validAfter: "100", validBefore: "200", nonce };

describe("parseCasperAuthorization", () => {
  it("extracts a normalized authorization", () => {
    const parsed = parseCasperAuthorization(payload({ ...valid, from: from.toUpperCase(), nonce: `0x${nonce.toUpperCase()}` }));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.authorization, { from, to, value: "500", validAfter: 100, validBefore: 200, nonce });
  });

  it("rejects anything that is not an x402 v2 Casper authorization", () => {
    const bad: Array<[unknown, RegExp]> = [
      [null, /not an object/],
      [payload(valid, 1), /x402Version 2/],
      [{ x402Version: 2, payload: {} }, /missing authorization/],
      [payload({ ...valid, from: `02${"aa".repeat(33)}` }), /from is not a Casper address/],
      [payload({ ...valid, to: "00abc" }), /to is not a Casper address/],
      [payload({ ...valid, value: "-5" }), /positive integer/],
      [payload({ ...valid, value: "0" }), /positive integer/],
      [payload({ ...valid, value: "0x10" }), /positive integer/],
      [payload({ ...valid, value: 5 }), /positive integer/],
      [payload({ ...valid, validBefore: "1e9" }), /unix seconds/],
      [payload({ ...valid, nonce: "cc" }), /32 bytes/],
    ];
    for (const [input, reason] of bad) {
      const parsed = parseCasperAuthorization(input);
      assert.equal(parsed.ok, false);
      if (!parsed.ok) assert.match(parsed.reason, reason);
    }
  });
});
