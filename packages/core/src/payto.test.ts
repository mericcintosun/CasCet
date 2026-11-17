import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cascetConfigSchema } from "./config.js";
import { ACCOUNT_HASH_HINT, isValidPayTo, normalizePayTo, payToSchema } from "./payto.js";

const HEX64 = "881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36";
const ED25519_PUBLIC_KEY = "01dd710d" + "ab".repeat(29); // "01" + 64 hex
const SECP256K1_PUBLIC_KEY = "0202bf97ba5eb20b003c90ca794275a341b205e969cfc24b05d4247bda851d37b1db";

describe("normalizePayTo", () => {
  it("keeps a 00-prefixed account hash and lower-cases it", () => {
    assert.equal(normalizePayTo(`00${HEX64}`), `00${HEX64}`);
    assert.equal(normalizePayTo(`00${HEX64.toUpperCase()}`), `00${HEX64}`);
    assert.equal(normalizePayTo(`  00${HEX64}  `), `00${HEX64}`);
  });

  it("converts account-hash-<hex> to the 00 form", () => {
    assert.equal(normalizePayTo(`account-hash-${HEX64}`), `00${HEX64}`);
    assert.equal(normalizePayTo(`ACCOUNT-HASH-${HEX64.toUpperCase()}`), `00${HEX64}`);
  });

  it("converts a contract package (hash- or package-hash-) to the 01 form", () => {
    assert.equal(normalizePayTo(`hash-${HEX64}`), `01${HEX64}`);
    assert.equal(normalizePayTo(`package-hash-${HEX64}`), `01${HEX64}`);
  });

  it("rejects an ed25519 public key and explains how to get the account hash", () => {
    assert.throws(
      () => normalizePayTo(ED25519_PUBLIC_KEY),
      (err: Error) => {
        assert.match(err.message, /is a Casper public key, not an account hash/);
        assert.ok(err.message.includes(ACCOUNT_HASH_HINT));
        assert.match(err.message, /npx @cascet\/cli account-hash/);
        // The contract-package form is not offered as an alternative: no facilitator can settle it today.
        assert.doesNotMatch(err.message, /contract/);
        return true;
      },
    );
  });

  it("rejects a secp256k1 public key", () => {
    assert.equal(SECP256K1_PUBLIC_KEY.length, 68);
    assert.throws(() => normalizePayTo(SECP256K1_PUBLIC_KEY), /is a Casper public key/);
  });

  it("rejects placeholders, wrong lengths and unknown prefixes", () => {
    for (const bad of [
      "",
      "<your Casper public key>",
      `00${HEX64.slice(2)}`,
      `00${HEX64}00`,
      `0x${HEX64}`,
      `contract-${HEX64}`,
      `account-hash-${HEX64.slice(1)}`,
      `hash-${HEX64}z`,
      `03${HEX64}`,
    ]) {
      assert.throws(() => normalizePayTo(bad), /payTo/, `expected ${JSON.stringify(bad)} to be rejected`);
      assert.equal(isValidPayTo(bad), false);
    }
  });
});

describe("payTo in the config schema", () => {
  const base = {
    name: "test",
    upstream: { type: "http", url: "http://127.0.0.1:9000/mcp" },
    asset: { packageHash: `hash-${HEX64}`, name: "CasCet X402 Token", symbol: "WCSPR" },
    facilitator: {},
    pricing: {},
  };

  it("normalizes payTo on parse", () => {
    const cfg = cascetConfigSchema.parse({ ...base, payTo: `account-hash-${HEX64.toUpperCase()}` });
    assert.equal(cfg.payTo, `00${HEX64}`);
  });

  it("fails the parse for a public key with the account-hash hint", () => {
    const result = cascetConfigSchema.safeParse({ ...base, payTo: ED25519_PUBLIC_KEY });
    assert.equal(result.success, false);
    const issue = result.error?.issues.find(i => i.path.join(".") === "payTo");
    assert.ok(issue, "expected an issue on payTo");
    assert.match(issue.message, /account-hash/);
  });

  it("works as a standalone schema", () => {
    assert.equal(payToSchema.parse(`hash-${HEX64}`), `01${HEX64}`);
    assert.equal(payToSchema.safeParse(42).success, false);
  });
});
