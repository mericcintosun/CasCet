import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { x402Client } from "@x402/core/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { ExactCasperScheme } from "@x402/casper/exact/client";
import casperSdk from "casper-js-sdk";
import { assetAmountFor, createPaymentRail, gatewayAsset, gatewayTimeouts, maxTimeoutSecondsFor, requiredValiditySeconds } from "./paywall.js";
import { startFakeFacilitator } from "./testing/fake-facilitator.js";
import { ASSET, callPaid, challengeOf, receipts, startHarness, testConfig } from "./testing/harness.js";

const LEGACY_TESTNET = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
const testAsset = { packageHash: `hash-${ASSET}`, name: "Test Token", symbol: "TST", decimals: 9, version: "1", tokensPerUsd: 50 };

describe("accepts entries carry the asset's authorization style", () => {
  it("assetAmountFor builds the x402 price with the EIP-712 domain, display fields and style", () => {
    const cfg = testConfig();
    assert.deepEqual(assetAmountFor(cfg.asset, "500000000"), {
      asset: ASSET,
      amount: "500000000",
      extra: { name: "Test Token", symbol: "TST", version: "1", decimals: "9", authorizationStyle: "cep3009-value" },
    });
  });

  it("the 402 challenge advertises cep3009-value for a CEP-3009 token and legacy-amount for CasCet's token", async () => {
    const cep = await startHarness();
    try {
      const challenge = challengeOf(await cep.rpc("tools/call", { name: "paid_tool", arguments: {} }));
      assert.equal(challenge.accepts.length, 1);
      assert.equal(challenge.accepts[0]?.extra?.authorizationStyle, "cep3009-value");
    } finally {
      await cep.close();
    }
    const legacy = await startHarness({
      config: { asset: { ...testAsset, packageHash: `hash-${LEGACY_TESTNET}`, name: "CasCet X402 Token", symbol: "WCSPR" } },
    });
    try {
      const challenge = challengeOf(await legacy.rpc("tools/call", { name: "paid_tool", arguments: {} }));
      assert.equal(challenge.accepts[0]?.asset, LEGACY_TESTNET);
      assert.equal(challenge.accepts[0]?.extra?.authorizationStyle, "legacy-amount");
    } finally {
      await legacy.close();
    }
  });
});

describe("the payment rail uses the asset's own facilitator", () => {
  it("sends a named facilitator's key with its auth scheme and never contacts the unused default", async () => {
    const fake = await startFakeFacilitator();
    try {
      const cfg = testConfig({
        asset: undefined,
        assets: [{ ...testAsset, facilitator: "self" }],
        facilitator: { url: "http://127.0.0.1:9" },
        facilitators: { self: { url: fake.url, apiKey: "secret-token", authScheme: "bearer" } },
      });
      const rail = await createPaymentRail(cfg);
      assert.equal(rail.asset, ASSET);
      assert.deepEqual(
        fake.calls.map(call => [call.op, call.authorization]),
        [["supported", "Bearer secret-token"]],
      );
    } finally {
      await fake.close();
    }
  });

  it("sends the raw key by default (what the hosted facilitator expects)", async () => {
    const fake = await startFakeFacilitator();
    try {
      await createPaymentRail(testConfig({ facilitator: { url: fake.url, apiKey: "cspr-cloud-key" } }));
      assert.equal(fake.calls[0]?.authorization, "cspr-cloud-key");
    } finally {
      await fake.close();
    }
  });

  it("refuses a config with several assets at startup, before any facilitator is contacted", async () => {
    const cfg = testConfig({
      asset: undefined,
      assets: [testAsset, { ...testAsset, id: "other", packageHash: "33".repeat(32) }],
      facilitator: { url: "http://127.0.0.1:9" },
    });
    assert.throws(() => gatewayAsset(cfg), /accepts one asset per gateway.*\(tst, other\)/);
    await assert.rejects(createPaymentRail(cfg), /accepts one asset per gateway/);
  });

  it("sizes the signing window with a facilitator's own timeout", () => {
    const own = testConfig({ facilitator: { url: "http://127.0.0.1:9", timeoutMs: 120_000 }, timeouts: { upstreamMs: 60_000 } });
    assert.deepEqual(gatewayTimeouts(own), { facilitatorMs: 120_000, settleMs: 120_000, upstreamMs: 60_000 });
    assert.equal(requiredValiditySeconds(own, false), 120 + 60 + 30);
    assert.equal(maxTimeoutSecondsFor(own), 120 + 60 + 120 + 30);
    assert.deepEqual(gatewayTimeouts(testConfig()), { facilitatorMs: 15_000, settleMs: 90_000, upstreamMs: 60_000 });
  });
});

describe("@x402 2.29 buyers pay a CasCet gateway", () => {
  it("a payment made by @x402/casper's client scheme matches the 402 (style echoed) and settles", async () => {
    const h = await startHarness();
    try {
      const key = casperSdk.PrivateKey.generate(casperSdk.KeyAlgorithm.ED25519);
      const signer = {
        accountAddress: () => `00${key.publicKey.accountHash().toHex()}`,
        publicKey: () => key.publicKey.toHex(),
        signEIP712: async (digest: Uint8Array) => key.signAndAddAlgorithmBytes(digest),
      };
      const client = new x402Client()
        .register("casper:casper-test", new ExactCasperScheme(signer))
        .setSpendControls({ allowedAssets: true, maxAmountPerPayment: false });
      const paymentRequired = challengeOf(await h.rpc("tools/call", { name: "paid_tool", arguments: {} }));
      const payment = await client.createPaymentPayload(paymentRequired);
      assert.equal(payment.accepted.extra?.authorizationStyle, "cep3009-value", "the buyer echoes the server-owned style");
      const paid = await callPaid(h, "paid_tool", encodePaymentSignatureHeader(payment));
      assert.equal(paid.status, 200, JSON.stringify(paid.body));
      assert.equal(h.facilitator.count("settle"), 1);
      const [receipt] = await receipts(h);
      assert.equal(receipt?.status, "settled");
      assert.equal(receipt?.payer, signer.accountAddress());
    } finally {
      await h.close();
    }
  });
});
