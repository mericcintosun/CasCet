import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  cascetConfigSchema,
  DEFAULT_FACILITATOR_URL,
  facilitatorAuthorization,
  facilitatorFor,
  isKnownCep3009Asset,
  usdPriceToTokenUnits,
} from "@cascet/core";
import { hostedPreflightAssets } from "@cascet/gateway";
import { TESTNET_WCSPR } from "./wcspr.js";

const example = (file: string) =>
  JSON.parse(readFileSync(new URL(`../../../examples/wrap-third-party/${file}`, import.meta.url), "utf8")) as Record<string, unknown>;

describe("example configs", () => {
  const wcspr = example("cascet.wcspr.config.json");
  const legacy = example("cascet.config.json");
  const filled = (raw: Record<string, unknown>) => ({
    ...raw,
    payTo: `00${"ab".repeat(32)}`,
    facilitator: { ...(raw["facilitator"] as Record<string, unknown>), apiKey: "cspr-cloud-access-key" },
  });

  test("the Wrapped CSPR example settles a CEP-3009 token through the hosted facilitator with the raw key", () => {
    const cfg = cascetConfigSchema.parse(filled(wcspr));
    assert.equal(cfg.network, "casper:casper-test");
    assert.equal(cfg.asset.packageHash, TESTNET_WCSPR.packageHash);
    assert.ok(isKnownCep3009Asset(cfg.network, cfg.asset.packageHash));
    assert.equal(cfg.asset.authorization, "cep3009-value");
    assert.equal(cfg.asset.name, TESTNET_WCSPR.name);
    assert.equal(cfg.facilitator.url, DEFAULT_FACILITATOR_URL);
    assert.equal(cfg.facilitator.authScheme, "raw");
    assert.equal(facilitatorAuthorization(facilitatorFor(cfg, cfg.asset)), "cspr-cloud-access-key");
    // The hosted facilitator's own nonce check does not work: without a node the gateway's preflight is off.
    assert.equal(cfg.settlement.nodeUrl, "https://node.testnet.casper.network/rpc");
    assert.deepEqual(hostedPreflightAssets(cfg).map(asset => asset.id), ["wcspr"]);
  });

  test("ships placeholders, never a key or an account", () => {
    assert.equal(wcspr["payTo"], "REPLACE_WITH_00_PLUS_YOUR_ACCOUNT_HASH");
    assert.equal((wcspr["facilitator"] as { apiKey?: unknown }).apiKey, "REPLACE_WITH_YOUR_CSPR_CLOUD_ACCESS_KEY");
    assert.equal(cascetConfigSchema.safeParse(wcspr).success, false, "the payTo placeholder does not parse");
  });

  test("sells the same tools at the same prices as the CasCet X402 Token example, on its own port", () => {
    assert.deepEqual(wcspr["pricing"], legacy["pricing"]);
    assert.deepEqual(wcspr["upstream"], legacy["upstream"]);
    assert.notEqual(wcspr["port"], legacy["port"]);
    const cfg = cascetConfigSchema.parse(filled(wcspr));
    assert.equal(usdPriceToTokenUnits(cfg.pricing.tools["echo"]!.price, cfg.asset), 50_000_000n);
    assert.equal(usdPriceToTokenUnits(cfg.pricing.tools["trigger-long-running-operation"]!.price, cfg.asset), 2_500_000_000n);
  });
});
