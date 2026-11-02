import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  assetsForPrice,
  cascetConfigSchema,
  DEFAULT_FACILITATOR_NAME,
  facilitatorAuthorization,
  facilitatorFor,
  facilitatorTimeouts,
} from "./config.js";
import { DEFAULT_FACILITATOR_URL, DEFAULT_SELF_HOSTED_FACILITATOR_URL } from "./constants.js";

const LEGACY_TESTNET = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
const LEGACY_MAINNET = "8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41";
const WCSPR_TESTNET = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";
const OTHER = "22".repeat(32);

const legacyAsset = { packageHash: `hash-${LEGACY_TESTNET}`, name: "CasCet X402 Token", symbol: "WCSPR", decimals: 9, version: "1", tokensPerUsd: 50 };
const wcsprAsset = { packageHash: `hash-${WCSPR_TESTNET}`, name: "Wrapped CSPR", symbol: "WCSPR", decimals: 9, version: "1", tokensPerUsd: 50 };

const base = {
  name: "test",
  upstream: { type: "stdio", command: "node" },
  payTo: `00${"11".repeat(32)}`,
  pricing: { tools: { a: { price: "$0.01" } } },
};

const parse = (input: Record<string, unknown>) => cascetConfigSchema.safeParse({ ...base, ...input });

/** The issues of a failed parse as "path: message" lines. */
function issuesOf(input: Record<string, unknown>): string[] {
  const result = parse(input);
  assert.equal(result.success, false, "expected the config to be rejected");
  return (result.error?.issues ?? []).map(issue => `${issue.path.map(String).join(".")}: ${issue.message}`);
}

describe("config assets: the single-asset form parses unchanged", () => {
  it("resolves asset into a one-entry assets list, keeps the asset alias and the default facilitator", () => {
    const cfg = cascetConfigSchema.parse({ ...base, asset: { packageHash: `hash-${OTHER.toUpperCase()}`, name: "Token", symbol: "TKN" }, facilitator: {} });
    assert.equal(cfg.assets.length, 1);
    assert.equal(cfg.asset, cfg.assets[0], "asset is the same object as assets[0]");
    assert.deepEqual(cfg.asset, {
      id: "tkn",
      packageHash: OTHER,
      name: "Token",
      symbol: "TKN",
      decimals: 9,
      version: "1",
      tokensPerUsd: 50,
      authorization: "cep3009-value",
      facilitator: DEFAULT_FACILITATOR_NAME,
    });
    assert.deepEqual(cfg.facilitator, { url: DEFAULT_FACILITATOR_URL, authScheme: "raw" });
    assert.deepEqual(cfg.facilitators, { default: cfg.facilitator });
    assert.equal(facilitatorFor(cfg, cfg.asset), cfg.facilitator);
  });

  it("resolves CasCet's legacy tokens to legacy-amount (testnet and mainnet, self-hosted facilitator)", () => {
    const testnet = cascetConfigSchema.parse({ ...base, asset: legacyAsset, facilitator: { url: DEFAULT_SELF_HOSTED_FACILITATOR_URL } });
    assert.equal(testnet.asset.authorization, "legacy-amount");
    assert.equal(testnet.asset.packageHash, LEGACY_TESTNET);
    const mainnet = cascetConfigSchema.parse({
      ...base,
      network: "casper:casper",
      asset: { ...legacyAsset, packageHash: `hash-${LEGACY_MAINNET}` },
      facilitator: { url: "http://localhost:4501", apiKey: "x".repeat(40) },
    });
    assert.equal(mainnet.asset.authorization, "legacy-amount");
    assert.equal(facilitatorAuthorization(facilitatorFor(mainnet, mainnet.asset)), "x".repeat(40), "the key is sent raw by default");
  });

  it("parses the shipped example config and resolves it to the legacy style", () => {
    const example = JSON.parse(readFileSync(new URL("../../../examples/wrap-third-party/cascet.config.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const cfg = cascetConfigSchema.parse({ ...example, payTo: `00${"ab".repeat(32)}` });
    assert.equal(cfg.asset.authorization, "legacy-amount");
    assert.equal(cfg.asset.facilitator, "default");
    assert.equal(cfg.facilitator.url, "http://127.0.0.1:4501");
  });

  it("keeps accepting the hosted facilitator for CEP-3009 tokens, and a missing facilitator section", () => {
    const cfg = cascetConfigSchema.parse({ ...base, asset: wcsprAsset, facilitator: { url: DEFAULT_FACILITATOR_URL, apiKey: "cspr-cloud-key" } });
    assert.equal(cfg.asset.authorization, "cep3009-value");
    assert.equal(facilitatorAuthorization(cfg.facilitator), "cspr-cloud-key");
    const implicit = cascetConfigSchema.parse({ ...base, asset: wcsprAsset });
    assert.equal(implicit.facilitator.url, DEFAULT_FACILITATOR_URL);
  });
});

describe("config assets: the multi-asset form", () => {
  const multi = {
    assets: [
      { ...legacyAsset, id: "cascet", facilitator: "self" },
      { ...wcsprAsset, id: "wcspr" },
    ],
    facilitator: { url: DEFAULT_FACILITATOR_URL, apiKey: "cspr-cloud-key" },
    facilitators: { self: { url: DEFAULT_SELF_HOSTED_FACILITATOR_URL, apiKey: "t".repeat(32), authScheme: "bearer", timeoutMs: 120_000 } },
    pricing: { default: { price: "$0.02", assets: ["wcspr"] }, tools: { a: { price: "$0.01", assets: ["wcspr", "cascet"] }, b: { price: "$0.01" } } },
  };

  it("resolves every asset with its style and facilitator, in config order", () => {
    const cfg = cascetConfigSchema.parse({ ...base, ...multi });
    assert.deepEqual(
      cfg.assets.map(a => [a.id, a.packageHash, a.authorization, a.facilitator]),
      [
        ["cascet", LEGACY_TESTNET, "legacy-amount", "self"],
        ["wcspr", WCSPR_TESTNET, "cep3009-value", "default"],
      ],
    );
    assert.equal(cfg.asset, cfg.assets[0]);
    assert.deepEqual(Object.keys(cfg.facilitators).sort(), ["default", "self"]);
    const self = facilitatorFor(cfg, cfg.assets[0]);
    assert.equal(facilitatorAuthorization(self), `Bearer ${"t".repeat(32)}`);
    assert.deepEqual(facilitatorTimeouts(cfg, self), { verifyMs: 120_000, settleMs: 120_000 });
    assert.deepEqual(facilitatorTimeouts(cfg, cfg.facilitator), { verifyMs: 15_000, settleMs: 90_000 });
  });

  it("selects the assets of each price", () => {
    const cfg = cascetConfigSchema.parse({ ...base, ...multi });
    const ids = (price: { assets?: string[] } | undefined) => assetsForPrice(cfg, price ?? {}).map(a => a.id);
    assert.deepEqual(ids(cfg.pricing.tools.a), ["cascet", "wcspr"], "config order, not the order of the list");
    assert.deepEqual(ids(cfg.pricing.tools.b), ["cascet", "wcspr"], "no list: every asset");
    assert.deepEqual(ids(cfg.pricing.default), ["wcspr"]);
  });

  it("allows the legacy style for tokens it does not know (other legacy deployments)", () => {
    const cfg = cascetConfigSchema.parse({ ...base, asset: { packageHash: OTHER, name: "Old", symbol: "OLD", authorization: "legacy-amount" }, facilitator: { url: DEFAULT_SELF_HOSTED_FACILITATOR_URL } });
    assert.equal(cfg.asset.authorization, "legacy-amount");
  });
});

describe("config assets: validation", () => {
  it("wants exactly one of asset and assets", () => {
    assert.match(issuesOf({ asset: wcsprAsset, assets: [wcsprAsset] }).join("\n"), /^assets: set exactly one of `asset`/m);
    assert.match(issuesOf({}).join("\n"), /^asset: set exactly one of `asset`/m);
    assert.match(issuesOf({ assets: [] }).join("\n"), /^assets: /m);
  });

  it("refuses a legacy token routed to the hosted facilitator, which sends `value`", () => {
    const single = issuesOf({ asset: legacyAsset, facilitator: {} });
    assert.equal(single.length, 1);
    assert.match(single[0] ?? "", /^asset\.facilitator: asset "wcspr" is a legacy-amount token, but its facilitator is the hosted one.*64658/);
    const named = issuesOf({
      assets: [{ ...legacyAsset, facilitator: "cloud" }],
      facilitator: { url: DEFAULT_SELF_HOSTED_FACILITATOR_URL },
      facilitators: { cloud: { url: `${DEFAULT_FACILITATOR_URL}/` } },
    });
    assert.match(named.join("\n"), /^assets\.0\.facilitator: .*legacy-amount token.*hosted/m);
  });

  it("refuses the bearer scheme on the hosted facilitator, which wants the raw key", () => {
    assert.match(issuesOf({ asset: wcsprAsset, facilitator: { authScheme: "bearer", apiKey: "k" } }).join("\n"), /^facilitator\.authScheme: .*raw/m);
    assert.match(
      issuesOf({ asset: wcsprAsset, facilitators: { cloud: { url: DEFAULT_FACILITATOR_URL, authScheme: "bearer" } } }).join("\n"),
      /^facilitators\.cloud\.authScheme: /m,
    );
  });

  it("refuses unknown facilitator and asset references", () => {
    assert.match(issuesOf({ asset: { ...wcsprAsset, facilitator: "nope" } }).join("\n"), /^asset\.facilitator: unknown facilitator "nope"/m);
    assert.match(
      issuesOf({ asset: wcsprAsset, pricing: { tools: { a: { price: "$0.01", assets: ["wcspr", "usdc"] } } } }).join("\n"),
      /^pricing\.tools\.a\.assets\.1: unknown asset "usdc"/m,
    );
    assert.match(issuesOf({ asset: wcsprAsset, pricing: { default: { price: "$0.01", assets: ["x"] } } }).join("\n"), /^pricing\.default\.assets\.0: unknown asset "x"/m);
    assert.match(
      issuesOf({ asset: wcsprAsset, pricing: { tools: { a: { price: "$0.01", assets: ["wcspr", "wcspr"] } } } }).join("\n"),
      /^pricing\.tools\.a\.assets\.1: asset "wcspr" is listed twice/m,
    );
  });

  it("refuses duplicate ids (two symbols alike need explicit ids) and duplicate tokens", () => {
    const facilitators = { self: { url: DEFAULT_SELF_HOSTED_FACILITATOR_URL } };
    const sameSymbol = issuesOf({ assets: [{ ...legacyAsset, facilitator: "self" }, wcsprAsset], facilitators });
    assert.match(sameSymbol.join("\n"), /^assets\.1\.id: asset id "wcspr" is used twice/m);
    assert.equal(parse({ assets: [{ ...legacyAsset, id: "cascet", facilitator: "self" }, wcsprAsset], facilitators }).success, true);
    assert.match(issuesOf({ assets: [{ ...wcsprAsset, id: "a" }, { ...wcsprAsset, id: "b", packageHash: WCSPR_TESTNET }] }).join("\n"), /^assets\.1\.packageHash: token .* is listed twice/m);
  });

  it("refuses a known legacy token declared cep3009-value", () => {
    const issues = issuesOf({ asset: { ...legacyAsset, authorization: "cep3009-value" }, facilitator: { url: DEFAULT_SELF_HOSTED_FACILITATOR_URL } });
    assert.match(issues.join("\n"), /^asset\.authorization: .*"legacy-amount"/m);
  });

  it("keeps the name default for the top-level facilitator", () => {
    assert.match(issuesOf({ asset: wcsprAsset, facilitators: { default: { url: DEFAULT_SELF_HOSTED_FACILITATOR_URL } } }).join("\n"), /^facilitators\.default: /m);
  });

  it("validates hashes, ids, styles and facilitator fields", () => {
    assert.match(issuesOf({ asset: { ...wcsprAsset, packageHash: "hash-abcd" } }).join("\n"), /^asset\.packageHash: packageHash must be a contract package hash/m);
    assert.match(issuesOf({ asset: { ...wcsprAsset, id: "Has Space" } }).join("\n"), /^asset\.id: /m);
    assert.match(issuesOf({ asset: { ...wcsprAsset, authorization: "value" } }).join("\n"), /^asset\.authorization: /m);
    assert.match(issuesOf({ asset: { ...wcsprAsset, name: "" } }).join("\n"), /^asset\.name: /m);
    assert.match(issuesOf({ asset: wcsprAsset, facilitator: { authScheme: "basic" } }).join("\n"), /^facilitator\.authScheme: /m);
    assert.match(issuesOf({ asset: wcsprAsset, facilitator: { timeoutMs: 0 } }).join("\n"), /^facilitator\.timeoutMs: /m);
    assert.match(issuesOf({ asset: wcsprAsset, facilitators: { "bad name": { url: DEFAULT_SELF_HOSTED_FACILITATOR_URL } } }).join("\n"), /^facilitators\.bad name: /m);
  });

  it("names the naming rule for a bad facilitator name, beside the config's other problems", () => {
    const rule = 'facilitator names are 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit';
    for (const name of ["self hosted", "_self", "s".repeat(65)]) {
      const issues = issuesOf({ asset: wcsprAsset, facilitators: { [name]: { url: DEFAULT_SELF_HOSTED_FACILITATOR_URL } } });
      assert.deepEqual(issues, [`facilitators.${name}: ${rule}`], name);
    }
    const both = issuesOf({ asset: wcsprAsset, facilitators: { "self hosted": { url: DEFAULT_SELF_HOSTED_FACILITATOR_URL }, ok: { url: "nope" } } });
    assert.deepEqual(both.sort(), [`facilitators.ok.url: Invalid URL`, `facilitators.self hosted: ${rule}`]);
    assert.equal(parse({ asset: wcsprAsset, facilitators: { "self.hosted_2-b": { url: DEFAULT_SELF_HOSTED_FACILITATOR_URL } } }).success, true);
  });

  it("throws for a hand-built config whose asset names no known facilitator", () => {
    assert.throws(() => facilitatorFor({ facilitators: {} }, { id: "x", facilitator: "gone" }), /unknown facilitator "gone"/);
  });
});
