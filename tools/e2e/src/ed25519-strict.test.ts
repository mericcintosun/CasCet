import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import casperSdk from "casper-js-sdk";
import { ED25519_VECTORS, ORDER_8_POINT, WEAK_KEY_SIGNATURE } from "./ed25519-fixtures.js";
import { ed25519StrictProblem, verifyEd25519Strict } from "./ed25519-strict.js";

const { PrivateKey, PublicKey, KeyAlgorithm } = casperSdk;

const hex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

/** casper-js-sdk's check (it throws instead of answering false). */
function sdkAccepts(publicKey: string, message: string, signature: string): boolean {
  try {
    return PublicKey.fromHex(`01${publicKey}`).verifySignature(hex(message), hex(`01${signature}`));
  } catch {
    return false;
  }
}

describe("ed25519 as the chain verifies it (ed25519-dalek verify_strict)", () => {
  test("agrees with casper-types 6.1.0 crypto::verify on every recorded vector", () => {
    for (const v of ED25519_VECTORS) {
      assert.equal(verifyEd25519Strict(hex(v.publicKey), hex(v.message), hex(v.signature)), v.chain, v.label);
    }
  });

  test("casper-js-sdk's cofactored check accepts signatures the chain refuses (why this check exists)", () => {
    for (const v of ED25519_VECTORS) assert.equal(sdkAccepts(v.publicKey, v.message, v.signature), v.sdk, v.label);
    const gap = ED25519_VECTORS.filter(v => v.sdk && !v.chain).map(v => v.label);
    assert.deepEqual(gap, [
      "weak key, small-order R, s = 0 (any message)",
      "identity key encoded with x's sign bit set, small-order R, s = 0",
      "mixed-order R (rB + an order-8 point), s = r + k·a",
      "small-order R, s = k·a",
      "weak key, R = [s]B (any message)",
    ]);
  });

  test("the weak key's signature passes casper-js-sdk for any message, and the strict check for none", () => {
    for (let i = 0; i < 4; i++) {
      const message = randomBytes(32).toString("hex");
      assert.equal(sdkAccepts(ORDER_8_POINT, message, WEAK_KEY_SIGNATURE.slice(2)), true);
      assert.equal(ed25519StrictProblem(hex(ORDER_8_POINT), hex(message), hex(WEAK_KEY_SIGNATURE.slice(2))), "the public key has small order");
    }
  });

  test("accepts every signature a casper-js-sdk key makes, and nothing once the message changes", () => {
    for (let i = 0; i < 12; i++) {
      const key = PrivateKey.generate(KeyAlgorithm.ED25519);
      const publicKey = hex(key.publicKey.toHex().slice(2));
      const message = randomBytes(32);
      const signature = key.sign(message);
      assert.equal(signature.length, 64);
      assert.equal(ed25519StrictProblem(publicKey, message, signature), undefined);
      message[i % 32] = message[i % 32]! ^ 1;
      assert.equal(ed25519StrictProblem(publicKey, message, signature), "[s]B − [k]A is not R");
    }
  });

  test("names what the chain refuses", () => {
    const problem = (label: string) => {
      const v = ED25519_VECTORS.find(x => x.label === label)!;
      return ed25519StrictProblem(hex(v.publicKey), hex(v.message), hex(v.signature));
    };
    assert.equal(problem("TEST 1 with s + L (non-canonical s)"), "s is not below the group order");
    assert.equal(problem("weak key, small-order R, s = 0 (any message)"), "R has small order");
    assert.equal(problem("small-order R, s = k·a"), "R has small order");
    assert.equal(problem("weak key, R = [s]B (any message)"), "the public key has small order");
    assert.equal(problem("mixed-order R (rB + an order-8 point), s = r + k·a"), "[s]B − [k]A is not R");

    const test1 = ED25519_VECTORS[0]!;
    // y = 2 has no x on the curve.
    const notOnCurve = `02${"00".repeat(31)}`;
    assert.equal(ed25519StrictProblem(hex(notOnCurve), hex(test1.message), hex(test1.signature)), "the public key is not a curve point");
    assert.equal(
      ed25519StrictProblem(hex(test1.publicKey), hex(test1.message), hex(`${notOnCurve}${test1.signature.slice(64)}`)),
      "R is not a curve point",
    );
    assert.equal(ed25519StrictProblem(hex(test1.publicKey.slice(2)), hex(""), hex(test1.signature)), "the public key is not 32 bytes");
    assert.equal(ed25519StrictProblem(hex(test1.publicKey), hex(""), hex(test1.signature.slice(2))), "the signature is not 64 bytes");
  });
});
