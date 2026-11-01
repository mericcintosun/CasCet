import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_AUTHORIZATION_SECONDS,
  normalizeAssetHash,
  normalizeNetworks,
  parseRawAmount,
  SpendPolicy,
  type SpendDecision,
} from "./policy.js";

const SELLER = "00" + "a1".repeat(32);
const OTHER_SELLER = "00" + "b2".repeat(32);
const CONTRACT = "c3".repeat(32);
const ASSET_A = "d4".repeat(32);
const ASSET_B = "e5".repeat(32);

function requirements(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "exact",
    network: "casper:casper-test",
    asset: ASSET_A,
    amount: "100",
    payTo: SELLER,
    maxTimeoutSeconds: 300,
    extra: { name: "CasCet X402 Token", version: "1" },
    ...overrides,
  };
}

function refused(decision: SpendDecision, pattern: RegExp): void {
  assert.equal(decision.ok, false, "expected the payment to be refused");
  if (!decision.ok) assert.match(decision.reason, pattern);
}

describe("parseRawAmount", () => {
  it("accepts plain decimal digits", () => {
    assert.equal(parseRawAmount("1", "amount"), 1n);
    assert.equal(parseRawAmount("000123", "amount"), 123n);
    assert.equal(parseRawAmount("9".repeat(40), "amount"), 10n ** 40n - 1n);
  });

  it("rejects negative, signed, hex, octal, padded, empty, decimal, scientific and huge values", () => {
    for (const bad of ["-5", "+5", "0x10", "0o17", "0b1", " 5", "5 ", "", "5.0", "1e5", "1E5", "\u0661\u0662", "9".repeat(41)]) {
      assert.throws(() => parseRawAmount(bad, "amount"), /amount must be a whole number/, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  it("rejects zero and non-strings", () => {
    assert.throws(() => parseRawAmount("0", "amount"), /greater than zero/);
    assert.throws(() => parseRawAmount("000", "amount"), /greater than zero/);
    for (const bad of [5, 5n, null, undefined, ["5"], { amount: "5" }]) {
      assert.throws(() => parseRawAmount(bad, "amount"), /whole number/);
    }
  });
});

describe("normalizeNetworks", () => {
  it("defaults to Casper testnet only", () => {
    assert.deepEqual(normalizeNetworks(undefined), ["casper:casper-test"]);
  });

  it("accepts explicit CAIP-2 Casper networks and de-duplicates", () => {
    assert.deepEqual(normalizeNetworks(["casper:casper", " casper:casper ", "casper:casper-test"]), [
      "casper:casper",
      "casper:casper-test",
    ]);
  });

  it("rejects wildcards, other namespaces and empty lists", () => {
    for (const bad of [["casper:*"], ["*"], ["casper:"], ["eip155:8453"], ["casper-test"], [""], []]) {
      assert.throws(() => normalizeNetworks(bad), /network/);
    }
  });
});

describe("normalizeAssetHash", () => {
  it("strips hash- and lower-cases", () => {
    assert.equal(normalizeAssetHash(`hash-${ASSET_A.toUpperCase()}`), ASSET_A);
    assert.equal(normalizeAssetHash(ASSET_A), ASSET_A);
  });

  it("rejects malformed hashes", () => {
    assert.throws(() => normalizeAssetHash("hash-1234"), /invalid asset/);
  });
});

describe("SpendPolicy construction", () => {
  it("validates budget caps up front", () => {
    for (const bad of ["-1", "0", "", "0x10", "1e9", "1.5", " 10", "9".repeat(41)]) {
      assert.throws(() => new SpendPolicy({ maxPerCallRaw: bad }), /budget\.maxPerCallRaw/, `maxPerCallRaw ${JSON.stringify(bad)}`);
      assert.throws(() => new SpendPolicy({ maxSessionRaw: bad }), /budget\.maxSessionRaw/, `maxSessionRaw ${JSON.stringify(bad)}`);
    }
  });

  it("rejects empty allowlists and public keys in allowedPayTo", () => {
    assert.throws(() => new SpendPolicy({ allowedPayTo: [] }), /allowedPayTo must be a non-empty list/);
    assert.throws(() => new SpendPolicy({ allowedAssets: [] }), /allowedAssets must be a non-empty list/);
    assert.throws(() => new SpendPolicy({ allowedPayTo: ["01" + "ab".repeat(32)] }), /public key.*account-hash/);
    assert.throws(() => new SpendPolicy({ allowedAssets: ["nope"] }), /allowedAssets: invalid asset/);
  });

  it("rejects a bad authorization window", () => {
    assert.throws(() => new SpendPolicy({ maxAuthorizationSeconds: 0 }), /maxAuthorizationSeconds/);
    assert.throws(() => new SpendPolicy({ maxAuthorizationSeconds: 1.5 }), /maxAuthorizationSeconds/);
  });
});

describe("SpendPolicy.authorize", () => {
  it("accepts a valid option and reserves its amount", () => {
    const policy = new SpendPolicy({ allowedPayTo: [SELLER], allowedAssets: [`hash-${ASSET_A}`] });
    const decision = policy.authorize(requirements());
    assert.deepEqual(decision, { ok: true, network: "casper:casper-test", payTo: SELLER, asset: ASSET_A, amount: 100n });
    assert.deepEqual(policy.spentByAsset(), { [ASSET_A]: "100" });
  });

  it("refuses malformed amounts without touching the session counter (M32)", () => {
    const policy = new SpendPolicy({ maxSessionRaw: "1000" });
    for (const amount of ["-1000000", "0x10", "", "1e5", "5.0", " 5", "0", "9".repeat(41), 100, null]) {
      refused(policy.authorize(requirements({ amount })), /malformed price/);
    }
    assert.deepEqual(policy.spentByAsset(), {});
    // The bypass from M32: a negative price must not lower the counter so later payments fit.
    assert.equal(policy.authorize(requirements({ amount: "900" })).ok, true);
    refused(policy.authorize(requirements({ amount: "200" })), /session budget/);
  });

  it("enforces the per-call budget", () => {
    const policy = new SpendPolicy({ maxPerCallRaw: "100" });
    assert.equal(policy.authorize(requirements({ amount: "100" })).ok, true);
    refused(policy.authorize(requirements({ amount: "101" })), /per-call budget 100/);
  });

  it("enforces the session budget per asset", () => {
    const policy = new SpendPolicy({ maxSessionRaw: "250" });
    assert.equal(policy.authorize(requirements({ amount: "100" })).ok, true);
    assert.equal(policy.authorize(requirements({ amount: "100" })).ok, true);
    refused(policy.authorize(requirements({ amount: "100" })), new RegExp(`session budget 250 for asset ${ASSET_A}`));
    // Another asset has its own session budget.
    assert.equal(policy.authorize(requirements({ asset: ASSET_B, amount: "250" })).ok, true);
    refused(policy.authorize(requirements({ asset: ASSET_B, amount: "1" })), /session budget/);
    assert.deepEqual(policy.spentByAsset(), { [ASSET_A]: "200", [ASSET_B]: "250" });
    assert.equal(policy.spentTotal(), 450n);
  });

  it("releases a reservation when no authorization was created", () => {
    const policy = new SpendPolicy({ maxSessionRaw: "100" });
    assert.equal(policy.authorize(requirements({ amount: "100" })).ok, true);
    policy.release(ASSET_A, 100n);
    assert.deepEqual(policy.spentByAsset(), {});
    assert.equal(policy.authorize(requirements({ amount: "100" })).ok, true);
  });

  it("refuses payees and assets that are not allowlisted", () => {
    const policy = new SpendPolicy({ allowedPayTo: [`account-hash-${SELLER.slice(2)}`], allowedAssets: [ASSET_A] });
    assert.equal(policy.authorize(requirements({ payTo: SELLER.toUpperCase() })).ok, true);
    refused(policy.authorize(requirements({ payTo: OTHER_SELLER })), /payTo .* is not allowlisted/);
    refused(policy.authorize(requirements({ asset: ASSET_B })), /asset .* is not allowlisted/);
  });

  it("refuses a 01-prefixed payee unless it is allowlisted as a contract package", () => {
    refused(new SpendPolicy().authorize(requirements({ payTo: `01${CONTRACT}` })), /not an account hash/);
    const policy = new SpendPolicy({ allowedPayTo: [`hash-${CONTRACT}`] });
    assert.equal(policy.authorize(requirements({ payTo: `01${CONTRACT}` })).ok, true);
  });

  it("refuses a network that is not listed (no casper:* wildcard)", () => {
    refused(new SpendPolicy().authorize(requirements({ network: "casper:casper" })), /network "casper:casper" is not allowed/);
    const mainnet = new SpendPolicy({ networks: ["casper:casper"] });
    assert.equal(mainnet.authorize(requirements({ network: "casper:casper" })).ok, true);
    refused(mainnet.authorize(requirements()), /only pays on casper:casper$/);
  });

  it("refuses long-lived or malformed authorization windows", () => {
    const policy = new SpendPolicy();
    assert.equal(policy.authorize(requirements({ maxTimeoutSeconds: DEFAULT_MAX_AUTHORIZATION_SECONDS })).ok, true);
    refused(policy.authorize(requirements({ maxTimeoutSeconds: DEFAULT_MAX_AUTHORIZATION_SECONDS + 1 })), /stay valid/);
    refused(policy.authorize(requirements({ maxTimeoutSeconds: "99999999999" })), /malformed maxTimeoutSeconds/);
    refused(policy.authorize(requirements({ maxTimeoutSeconds: -1 })), /malformed maxTimeoutSeconds/);
  });

  it("refuses malformed requirements", () => {
    const policy = new SpendPolicy();
    refused(policy.authorize(null), /malformed payment requirements/);
    refused(policy.authorize(requirements({ scheme: "upto" })), /unsupported payment scheme/);
    refused(policy.authorize(requirements({ payTo: "01" + "ab".repeat(33) })), /malformed payTo/);
    refused(policy.authorize(requirements({ asset: `hash-${ASSET_A}` })), /malformed asset/);
  });
});
