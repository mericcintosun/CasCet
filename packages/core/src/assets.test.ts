import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTHORIZATION_STYLE_EXTRA_KEY,
  AUTHORIZATION_STYLES,
  DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE,
  defaultAuthorizationStyle,
  isAuthorizationStyle,
  isLegacyAmountToken,
  isPackageHash,
  LEGACY_AMOUNT_TOKENS,
  normalizePackageHash,
} from "./assets.js";
import { DEFAULT_FACILITATOR_URL, HOSTED_FACILITATOR_HOST, isHostedFacilitatorUrl } from "./constants.js";

const LEGACY_TESTNET = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
const LEGACY_MAINNET = "8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41";
const WCSPR_TESTNET = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";

describe("authorization styles", () => {
  it("names exactly the two transfer_with_authorization ABIs", () => {
    assert.deepEqual([...AUTHORIZATION_STYLES], ["legacy-amount", "cep3009-value"]);
    assert.equal(AUTHORIZATION_STYLE_EXTRA_KEY, "authorizationStyle");
    assert.equal(isAuthorizationStyle("legacy-amount"), true);
    assert.equal(isAuthorizationStyle("cep3009-value"), true);
    for (const other of ["value", "amount", "LEGACY-AMOUNT", "", undefined, null, 1]) {
      assert.equal(isAuthorizationStyle(other), false, String(other));
    }
  });

  it("knows CasCet's two legacy tokens, by network", () => {
    assert.deepEqual(LEGACY_AMOUNT_TOKENS, { [LEGACY_TESTNET]: "casper:casper-test", [LEGACY_MAINNET]: "casper:casper" });
    assert.ok(Object.isFrozen(LEGACY_AMOUNT_TOKENS));
  });

  it("defaults known legacy tokens to legacy-amount and every other token to cep3009-value", () => {
    for (const spelling of [LEGACY_TESTNET, `hash-${LEGACY_TESTNET}`, `HASH-${LEGACY_TESTNET.toUpperCase()}`, ` 0x${LEGACY_MAINNET} `]) {
      assert.equal(defaultAuthorizationStyle(spelling), "legacy-amount", spelling);
      assert.equal(isLegacyAmountToken(spelling), true, spelling);
    }
    assert.equal(defaultAuthorizationStyle(WCSPR_TESTNET), "cep3009-value");
    assert.equal(defaultAuthorizationStyle("ab".repeat(32)), "cep3009-value");
    assert.equal(isLegacyAmountToken("toString"), false, "own keys only");
  });

  it("never settles a legacy token with @x402/casper's 2.5 CSPR default gas limit", () => {
    assert.equal(DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE["legacy-amount"], 4_000_000_000);
    assert.equal(DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE["cep3009-value"], 3_500_000_000);
    assert.ok(DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE["legacy-amount"] > 2_700_000_000, "above the measured ~2.70 CSPR");
    assert.ok(Object.isFrozen(DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE));
  });
});

describe("normalizePackageHash", () => {
  it("strips the usual prefixes, trims and lower-cases", () => {
    const hex = "AB".repeat(32);
    for (const spelling of [hex, `hash-${hex}`, `contract-package-${hex}`, `package-${hex}`, `0x${hex}`, `  hash-${hex}\n`]) {
      assert.equal(normalizePackageHash(spelling), "ab".repeat(32), spelling);
    }
    assert.equal(isPackageHash(normalizePackageHash(`hash-${hex}`)), true);
    assert.equal(isPackageHash("ab".repeat(31)), false);
    assert.equal(isPackageHash(`hash-${"ab".repeat(32)}`), false, "isPackageHash wants the bare form");
  });
});

describe("hosted facilitator", () => {
  it("is recognized by host, whatever the path, case or trailing dot", () => {
    assert.equal(HOSTED_FACILITATOR_HOST, "x402-facilitator.cspr.cloud");
    for (const url of [DEFAULT_FACILITATOR_URL, `${DEFAULT_FACILITATOR_URL}/`, "https://X402-Facilitator.CSPR.cloud/v2", "https://x402-facilitator.cspr.cloud./"]) {
      assert.equal(isHostedFacilitatorUrl(url), true, url);
    }
    for (const url of ["http://127.0.0.1:4501", "https://facilitator.example", "https://x402-facilitator.cspr.cloud.example", "not a url"]) {
      assert.equal(isHostedFacilitatorUrl(url), false, url);
    }
  });
});
