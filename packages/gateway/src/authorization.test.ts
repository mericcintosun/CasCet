import assert from "node:assert/strict";
import { describe, it } from "node:test";
import casperSdk from "casper-js-sdk";
import { toClientCasperSigner } from "@make-software/casper-x402";
import { ExactCasperScheme as ExactCasperClientScheme } from "@make-software/casper-x402/exact/client";
import { normalizeAccountAddress, parseCasperAuthorization } from "./authorization.js";

const ed25519Key = `01${"44".repeat(32)}`;
const secp256k1Key = `0203${"44".repeat(32)}`;
const accountHash = (publicKey: string) => casperSdk.PublicKey.fromHex(publicKey).accountHash().toHex();
const from = `00${accountHash(ed25519Key)}`;
const to = `00${"bb".repeat(32)}`;
const nonce = "cc".repeat(32);
const ed25519Signature = `01${"00".repeat(64)}`;

function payload(
  authorization: Record<string, unknown>,
  opts: { x402Version?: unknown; signature?: unknown; publicKey?: unknown } = {},
) {
  return {
    x402Version: "x402Version" in opts ? opts.x402Version : 2,
    payload: {
      signature: "signature" in opts ? opts.signature : ed25519Signature,
      publicKey: "publicKey" in opts ? opts.publicKey : ed25519Key,
      authorization,
    },
  };
}

const valid = { from, to, value: "500", validAfter: "100", validBefore: "200", nonce };

describe("parseCasperAuthorization", () => {
  it("extracts a normalized authorization", () => {
    const parsed = parseCasperAuthorization(payload({ ...valid, from: from.toUpperCase(), nonce: `0x${nonce.toUpperCase()}` }));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.authorization, { from, to, value: "500", validAfter: 100, validBefore: 200, nonce });
  });

  it("accepts a secp256k1 key with a secp256k1 signature", () => {
    const secpFrom = `00${accountHash(secp256k1Key)}`;
    const parsed = parseCasperAuthorization(
      payload({ ...valid, from: secpFrom }, { publicKey: secp256k1Key, signature: `02${"11".repeat(64)}` }),
    );
    assert.ok(parsed.ok);
  });

  it("rejects anything that is not an x402 v2 Casper authorization", () => {
    const bad: Array<[unknown, RegExp]> = [
      [null, /not an object/],
      [payload(valid, { x402Version: 1 }), /x402Version 2/],
      [{ x402Version: 2, payload: {} }, /missing authorization/],
      [payload({ ...valid, from: `02${"aa".repeat(33)}` }), /from must be an account address/],
      [payload({ ...valid, to: "00abc" }), /to is not a Casper address/],
      [payload({ ...valid, value: "-5" }), /positive integer/],
      [payload({ ...valid, value: "0" }), /positive integer/],
      [payload({ ...valid, value: "0x10" }), /positive integer/],
      [payload({ ...valid, value: 5 }), /positive integer/],
      [payload({ ...valid, validBefore: "1e9" }), /unix seconds/],
      [payload({ ...valid, nonce: "cc" }), /32 bytes/],
      [payload(valid, { publicKey: "01abcd" }), /publicKey must be a Casper public key/],
      [payload(valid, { publicKey: undefined, signature: ed25519Signature }), /publicKey must be a Casper public key/],
      [payload(valid, { signature: `01${"00".repeat(63)}` }), /signature must be 65 bytes/],
    ];
    for (const [input, reason] of bad) {
      const parsed = parseCasperAuthorization(input);
      assert.equal(parsed.ok, false);
      if (!parsed.ok) assert.match(parsed.reason, reason);
    }
  });

  it("refuses shapes that casper-x402 1.0.0 verifies but that always revert on-chain (M18)", () => {
    // "01" + the payer's account hash: the facilitator compares only the hash part.
    const contractTagged = parseCasperAuthorization(payload({ ...valid, from: `01${from.slice(2)}` }));
    assert.equal(contractTagged.ok, false);
    if (!contractTagged.ok) assert.match(contractTagged.reason, /only accounts sign authorizations/);

    // A secp256k1-tagged signature next to an ed25519 key: casper-js-sdk drops the tag when it verifies.
    const mixedTags = parseCasperAuthorization(payload(valid, { signature: `02${"00".repeat(64)}` }));
    assert.equal(mixedTags.ok, false);
    if (!mixedTags.ok) assert.match(mixedTags.reason, /algorithm tag does not match/);
  });

  it("accepts what the casper-x402 client produces (random in-memory keys, fake token, nothing is sent)", async () => {
    for (const algorithm of [casperSdk.KeyAlgorithm.ED25519, casperSdk.KeyAlgorithm.SECP256K1]) {
      // casper-x402 pins casper-js-sdk 5.0.12; its signer only calls methods both versions share.
      const key = casperSdk.PrivateKey.generate(algorithm) as unknown as Parameters<typeof toClientCasperSigner>[0];
      const scheme = new ExactCasperClientScheme(toClientCasperSigner(key));
      const signed = await scheme.createPaymentPayload(2, {
        scheme: "exact",
        network: "casper:casper-test",
        asset: "22".repeat(32),
        amount: "500",
        payTo: to,
        maxTimeoutSeconds: 300,
        extra: { name: "Test Token", version: "1" },
      });
      const parsed = parseCasperAuthorization(signed);
      assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
    }
  });

  it("refuses a public key that does not belong to authorization.from", () => {
    const parsed = parseCasperAuthorization(payload({ ...valid, from: `00${"33".repeat(32)}` }));
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.reason, /publicKey does not belong to authorization.from/);
  });
});

describe("normalizeAccountAddress", () => {
  it("maps the accepted spellings of an account onto the 00-prefixed form", () => {
    const hex = "ab".repeat(32);
    for (const spelling of [`00${hex}`, `00${hex.toUpperCase()}`, `account-hash-${hex}`, `0x00${hex}`, ` 00${hex} `]) {
      assert.equal(normalizeAccountAddress(spelling), `00${hex}`, spelling);
    }
    assert.equal(normalizeAccountAddress(`01${hex}`), `01${hex}`);
  });
});
