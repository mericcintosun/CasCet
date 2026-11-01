import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FACILITATOR_URL,
  DEFAULT_SELF_HOSTED_FACILITATOR_URL,
  KNOWN_CEP3009_ASSETS,
  NETWORK_CASPER_MAINNET,
  NETWORK_CASPER_TESTNET,
  isKnownCep3009Asset,
} from "./constants.js";

const WCSPR_MAINNET = "8df5d26790e18cf0404502c62ce5dc9025800ad6975c97466e20506c39c505b6";
const WCSPR_TESTNET = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";
// CasCet's own x402 tokens take `amount`, so the hosted facilitator cannot settle them.
const CASCET_X402_TESTNET = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
const CASCET_X402_MAINNET = "8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41";

describe("isKnownCep3009Asset", () => {
  it("knows the official Wrapped CSPR on each network, with or without hash-", () => {
    assert.equal(isKnownCep3009Asset(NETWORK_CASPER_MAINNET, WCSPR_MAINNET), true);
    assert.equal(isKnownCep3009Asset(NETWORK_CASPER_MAINNET, `hash-${WCSPR_MAINNET.toUpperCase()}`), true);
    assert.equal(isKnownCep3009Asset(NETWORK_CASPER_TESTNET, `hash-${WCSPR_TESTNET}`), true);
  });

  it("does not mix networks", () => {
    assert.equal(isKnownCep3009Asset(NETWORK_CASPER_TESTNET, WCSPR_MAINNET), false);
    assert.equal(isKnownCep3009Asset(NETWORK_CASPER_MAINNET, WCSPR_TESTNET), false);
    assert.equal(isKnownCep3009Asset("casper:unknown", WCSPR_MAINNET), false);
  });

  it("does not list CasCet's amount-style x402 tokens", () => {
    assert.equal(isKnownCep3009Asset(NETWORK_CASPER_TESTNET, `hash-${CASCET_X402_TESTNET}`), false);
    assert.equal(isKnownCep3009Asset(NETWORK_CASPER_MAINNET, `hash-${CASCET_X402_MAINNET}`), false);
  });

  it("is frozen", () => {
    assert.ok(Object.isFrozen(KNOWN_CEP3009_ASSETS));
    assert.ok(Object.isFrozen(KNOWN_CEP3009_ASSETS[NETWORK_CASPER_MAINNET]));
  });
});

describe("facilitator defaults", () => {
  it("keeps the hosted URL and offers a loopback self-hosted URL", () => {
    assert.equal(DEFAULT_FACILITATOR_URL, "https://x402-facilitator.cspr.cloud");
    assert.equal(new URL(DEFAULT_SELF_HOSTED_FACILITATOR_URL).hostname, "127.0.0.1");
  });
});
