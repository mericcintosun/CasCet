import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONTRACT_PAYEE_REASON,
  DEFAULT_MAX_AUTHORIZATION_SECONDS,
  MAX_TOKEN_NAME_LENGTH,
  MAX_TOKEN_VERSION_LENGTH,
  normalizeAllowedPayTo,
  normalizeAssetHash,
  normalizeNetworks,
  normalizePreferStyles,
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

describe("normalizeAllowedPayTo", () => {
  it("accepts account hashes in both forms", () => {
    assert.equal(normalizeAllowedPayTo(SELLER.toUpperCase()), SELLER);
    assert.equal(normalizeAllowedPayTo(` account-hash-${SELLER.slice(2)} `), SELLER);
  });

  it("rejects a contract package, which no facilitator can settle today", () => {
    for (const entry of [`hash-${CONTRACT}`, `package-hash-${CONTRACT}`]) {
      assert.throws(
        () => normalizeAllowedPayTo(entry),
        (err: Error) => {
          assert.match(err.message, /is a contract-package payee/);
          assert.ok(err.message.includes(CONTRACT_PAYEE_REASON));
          return true;
        },
      );
    }
  });

  it("still rejects a public key with the account-hash hint", () => {
    assert.throws(() => normalizeAllowedPayTo(`01${CONTRACT}`), /public key.*account-hash/);
  });
});

describe("normalizePreferStyles", () => {
  it("keeps known styles in order, trimmed and de-duplicated", () => {
    assert.equal(normalizePreferStyles(undefined), undefined);
    assert.deepEqual(normalizePreferStyles([" cep3009-value", "legacy-amount", "cep3009-value"]), ["cep3009-value", "legacy-amount"]);
    assert.deepEqual(normalizePreferStyles(["legacy-amount"]), ["legacy-amount"]);
  });

  it("rejects unknown styles and empty lists, naming the setting", () => {
    assert.throws(() => normalizePreferStyles([]), /preferStyles must list at least one authorization style/);
    for (const bad of ["permit2", "", "AMOUNT", "Cep3009-Value", 1, null]) {
      assert.throws(() => normalizePreferStyles([bad]), /preferStyles: unknown authorization style/, JSON.stringify(bad));
    }
    assert.throws(() => normalizePreferStyles(["value"], "CASCET_PREFER_STYLES"), /^Error: CASCET_PREFER_STYLES: unknown authorization style "value"/);
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

  it("rejects empty allowlists, public keys and contract packages in allowedPayTo", () => {
    assert.throws(() => new SpendPolicy({ allowedPayTo: [] }), /allowedPayTo must be a non-empty list/);
    assert.throws(() => new SpendPolicy({ allowedAssets: [] }), /allowedAssets must be a non-empty list/);
    assert.throws(() => new SpendPolicy({ allowedPayTo: ["01" + "ab".repeat(32)] }), /public key.*account-hash/);
    assert.throws(() => new SpendPolicy({ allowedPayTo: [SELLER, `hash-${CONTRACT}`] }), /allowedPayTo: .*contract-package payee/);
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

  it("refuses every 01-prefixed payee, with or without an allowlist", () => {
    for (const policy of [new SpendPolicy(), new SpendPolicy({ allowedPayTo: [SELLER] })]) {
      for (const payTo of [`01${CONTRACT}`, `01${CONTRACT.toUpperCase()}`]) {
        const decision = policy.authorize(requirements({ payTo }));
        refused(decision, /is not an account hash \(a contract package, or a public key\)/);
        if (!decision.ok) assert.ok(decision.reason.includes(CONTRACT_PAYEE_REASON));
      }
      assert.deepEqual(policy.spentByAsset(), {});
    }
    // An allowlist can never make a contract package payable: it is rejected when the policy is built.
    assert.throws(() => new SpendPolicy({ allowedPayTo: [`hash-${CONTRACT}`] }), /contract-package payee/);
  });

  it("never tells the model how to get a refused payee paid", () => {
    const decision = new SpendPolicy({ allowedPayTo: [SELLER] }).authorize(requirements({ payTo: `01${CONTRACT}` }));
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.doesNotMatch(decision.reason, /allowlist it|explicitly/i);
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

  it("reports a known authorization style and refuses one it does not know", () => {
    const policy = new SpendPolicy();
    const extra = (authorizationStyle: unknown) => ({ extra: { name: "Wrapped CSPR", version: "1", authorizationStyle } });
    for (const style of ["legacy-amount", "cep3009-value"]) {
      const decision = policy.authorize(requirements(extra(style)));
      assert.equal(decision.ok && decision.authorizationStyle, style);
    }
    const plain = policy.authorize(requirements());
    assert.equal(plain.ok, true);
    assert.equal("authorizationStyle" in plain, false, "no style advertised, none reported");
    for (const style of ["permit2", "", "AMOUNT", 1, null]) {
      refused(policy.authorize(requirements(extra(style))), /unknown authorization style/);
    }
    assert.deepEqual(policy.spentByAsset(), { [ASSET_A]: "300" }, "refusals reserve nothing");
  });

  it("refuses an option without a usable EIP-712 domain, naming the field and the problem", () => {
    const policy = new SpendPolicy();
    const NAME = "Wrapped CSPR";
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ version: "1" }, "extra.name is missing"],
      [{ name: 42, version: "1" }, "extra.name must be a string; got 42"],
      [{ name: null, version: "1" }, "extra.name must be a string; got null"],
      [{ name: ["Wrapped CSPR"], version: "1" }, 'extra.name must be a string; got ["Wrapped CSPR"]'],
      [{ name: "", version: "1" }, "extra.name is empty"],
      [{ name: "Wrapped \ud800CSPR", version: "1" }, "extra.name contains lone UTF-16 surrogates, which have no UTF-8 form to sign over"],
      [{ name: "x".repeat(101), version: "1" }, "extra.name is 101 characters long, above this client's 100-character limit"],
      // UTF-16 code units, as the Python client counts them too: a character outside the BMP counts twice.
      [{ name: "\u{1FA99}".repeat(51), version: "1" }, "extra.name is 102 characters long, above this client's 100-character limit"],
      [{ name: NAME }, "extra.version is missing"],
      [{ name: NAME, version: 1 }, "extra.version must be a string; got 1"],
      [{ name: NAME, version: "" }, "extra.version is empty"],
      [{ name: NAME, version: "\udc00" }, "extra.version contains lone UTF-16 surrogates, which have no UTF-8 form to sign over"],
      [{ name: NAME, version: "1".repeat(21) }, "extra.version is 21 characters long, above this client's 20-character limit"],
    ];
    for (const [extra, reason] of cases) {
      const decision = policy.authorize(requirements({ extra: { authorizationStyle: "cep3009-value", ...extra } }));
      assert.deepEqual(decision, { ok: false, reason: `malformed EIP-712 domain: ${reason}` }, reason);
    }
    // No extra at all, or one that is not an object, names no domain either.
    for (const extra of [undefined, null, NAME, [NAME, "1"]]) {
      refused(policy.authorize(requirements({ extra })), /^malformed EIP-712 domain: extra\.name is missing$/);
    }
    assert.deepEqual(policy.spentByAsset(), {}, "refusals reserve nothing");
  });

  it("quotes what the gateway sent with control, separator and bidi characters escaped", () => {
    const policy = new SpendPolicy();
    const esc = (code: number): string => "\\" + "u" + code.toString(16).padStart(4, "0");
    // A line separator, a right-to-left override, C1 NEL and CSI, and DEL: JSON.stringify leaves each raw.
    const codes = [0x2028, 0x202e, 0x0085, 0x009b, 0x007f];
    const hostile = `x${codes.map(code => String.fromCharCode(code)).join("")}[cascet] authorized 1 raw units`;
    const expected = `x${codes.map(esc).join("")}[cascet] authorized 1 raw units`;
    for (const [overrides, field] of [
      [{ network: `casper:casper${hostile}` }, "network"],
      [{ scheme: hostile }, "scheme"],
      [{ payTo: hostile }, "payTo"],
      [{ asset: hostile }, "asset"],
      [{ extra: { name: "Wrapped CSPR", version: "1", authorizationStyle: hostile } }, "authorization style"],
      [{ extra: { name: [hostile], version: "1" } }, "extra.name"],
      [{ amount: hostile }, "price"],
    ] as const) {
      const decision = policy.check(requirements(overrides));
      assert.equal(decision.ok, false, field);
      if (decision.ok) continue;
      assert.ok(decision.reason.includes(expected), `${field}: ${decision.reason}`);
      for (const code of codes) assert.ok(!decision.reason.includes(String.fromCharCode(code)), `${field}: U+${code.toString(16)} is escaped`);
    }
  });

  it("accepts any EIP-712 domain name and version within the bounds", () => {
    assert.equal(MAX_TOKEN_NAME_LENGTH, 100);
    assert.equal(MAX_TOKEN_VERSION_LENGTH, 20);
    const policy = new SpendPolicy();
    for (const extra of [
      { name: "x".repeat(MAX_TOKEN_NAME_LENGTH), version: "1".repeat(MAX_TOKEN_VERSION_LENGTH) },
      { name: "C", version: "1.0.0" },
      // Non-ASCII, and a surrogate pair (one code point, two UTF-16 code units).
      { name: "Jeton été \u{1FA99}", version: "2" },
      { name: "\u{1FA99}".repeat(50), version: "1" },
    ]) {
      assert.equal(policy.check(requirements({ extra })).ok, true, JSON.stringify(extra));
    }
  });
});

describe("SpendPolicy.check", () => {
  it("applies every rule, the session budget included, without reserving", () => {
    const policy = new SpendPolicy({ allowedAssets: [ASSET_A], maxSessionRaw: "150" });
    assert.equal(policy.check(requirements()).ok, true);
    assert.equal(policy.check(requirements()).ok, true, "checking twice reserves nothing");
    assert.deepEqual(policy.spentByAsset(), {});
    refused(policy.check(requirements({ asset: ASSET_B })), /not allowlisted/);
    assert.equal(policy.authorize(requirements()).ok, true);
    refused(policy.check(requirements()), /would exceed the session budget 150/);
  });
});
