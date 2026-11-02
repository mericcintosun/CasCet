import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accountHashFromPublicKey } from "./account-hash.js";

// Expected values computed independently of casper-js-sdk:
// blake2b-256(algorithm name || 0x00 || public key bytes), e.g. with Python's hashlib.
const VECTORS = [
  {
    publicKey: "01" + "11".repeat(32),
    payTo: "0033b261261c76ab5a249ae145461cadc722dc67ed59cf0e9c538b6c2b366ec463",
  },
  {
    publicKey: "01387d7df88b0d2a1b3816e35b8a86644c619b94fd9bb953451695050c38d6413f",
    payTo: "00183e1b2597d160622d3625575ece47417958d4b5b45476f6f2b3130e41169382",
  },
  {
    publicKey: "0202bf97ba5eb20b003c90ca794275a341b205e969cfc24b05d4247bda851d37b1db",
    payTo: "00d885e15a799cf3f092ed83f24058de13454e30710ae9a1dd82f768e0372f88b1",
  },
];

describe("accountHashFromPublicKey", () => {
  it("derives the 00-prefixed account hash of ed25519 and secp256k1 keys", () => {
    for (const { publicKey, payTo } of VECTORS) {
      assert.equal(accountHashFromPublicKey(publicKey), payTo);
      assert.equal(accountHashFromPublicKey(` ${publicKey.toUpperCase()} `), payTo);
    }
  });

  it("normalizes an account hash that is passed in already", () => {
    const hash = VECTORS[0]!.payTo.slice(2);
    assert.equal(accountHashFromPublicKey(`account-hash-${hash}`), `00${hash}`);
    assert.equal(accountHashFromPublicKey(`00${hash.toUpperCase()}`), `00${hash}`);
  });

  it("rejects anything that is not a public key", () => {
    for (const bad of ["", "01abcd", "03" + "ab".repeat(32), "02" + "ab".repeat(32), "hash-" + "ab".repeat(32), "01" + "zz".repeat(32)]) {
      assert.throws(() => accountHashFromPublicKey(bad), /public key/, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });
});
