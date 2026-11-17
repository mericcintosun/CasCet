import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeNetworks } from "@cascet/client";
import { DEFAULT_TIMEOUT_MS, describeConfig, loadAnalystConfig, normalizeAssetHash, normalizePayTo } from "./config.js";

const ACCOUNT = "881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36";
const TOKEN = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
const ED25519_PUBLIC_KEY = `01${"ab".repeat(32)}`;
const SECP256K1_PUBLIC_KEY = `02${"cd".repeat(33)}`;

/** The minimal complete environment of a safely configured analyst. */
const BASE = {
  CASCET_KEY_PATH: "/keys/analyst.pem",
  CASCET_ALLOWED_PAYTO: `00${ACCOUNT}`,
  CASCET_ALLOWED_ASSETS: `hash-${TOKEN}`,
  CASCET_MAX_PER_CALL: "1000000000",
  CASCET_MAX_SESSION: "5000000000",
  CASCET_MAX_TOTAL: "20000000000",
};

function problemsOf(env: Record<string, string | undefined>): string[] {
  const r = loadAnalystConfig(env);
  return r.ok ? [] : r.problems;
}

describe("loadAnalystConfig", () => {
  it("accepts a complete environment and applies the defaults", () => {
    const r = loadAnalystConfig(BASE);
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(r.config, {
      dataGatewayUrl: "http://localhost:4402/mcp",
      keyPath: "/keys/analyst.pem",
      keyAlgorithm: "ed25519",
      networks: ["casper:casper-test"],
      allowedPayTo: [`00${ACCOUNT}`],
      allowedAssets: [`hash-${TOKEN}`],
      maxPerCallRaw: "1000000000",
      maxSessionRaw: "5000000000",
      maxTotalRaw: "20000000000",
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    assert.deepEqual(r.warnings, []);
    assert.doesNotMatch(describeConfig(r.config), /analyst\.pem/);
  });

  it("requires the wallet key", () => {
    assert.ok(problemsOf({ ...BASE, CASCET_KEY_PATH: undefined }).some(p => p.includes("CASCET_KEY_PATH")));
    assert.ok(problemsOf({ ...BASE, CASCET_KEY_PATH: "  " }).some(p => p.includes("CASCET_KEY_PATH")));
  });

  it("requires both allowlists unless CASCET_ALLOW_ANY_SELLER=1", () => {
    const p = problemsOf({ ...BASE, CASCET_ALLOWED_PAYTO: undefined, CASCET_ALLOWED_ASSETS: " , " });
    assert.ok(p.some(x => x.startsWith("CASCET_ALLOWED_PAYTO is required")));
    assert.ok(p.some(x => x.startsWith("CASCET_ALLOWED_ASSETS is required")));

    const r = loadAnalystConfig({
      ...BASE,
      CASCET_ALLOWED_PAYTO: undefined,
      CASCET_ALLOWED_ASSETS: undefined,
      CASCET_ALLOW_ANY_SELLER: "1",
    });
    assert.ok(r.ok);
    assert.equal(r.config.allowedPayTo, undefined);
    assert.equal(r.config.allowedAssets, undefined);
    assert.equal(r.warnings.length, 2);
  });

  it("keeps an allowlist that is set even with CASCET_ALLOW_ANY_SELLER=1", () => {
    const r = loadAnalystConfig({ ...BASE, CASCET_ALLOWED_ASSETS: undefined, CASCET_ALLOW_ANY_SELLER: "true" });
    assert.ok(r.ok);
    assert.deepEqual(r.config.allowedPayTo, [`00${ACCOUNT}`]);
    assert.equal(r.config.allowedAssets, undefined);
  });

  it("requires all three spending caps unless CASCET_ALLOW_UNLIMITED_BUDGET=1", () => {
    const p = problemsOf({ ...BASE, CASCET_MAX_PER_CALL: undefined, CASCET_MAX_SESSION: "", CASCET_MAX_TOTAL: " " });
    assert.ok(p.some(x => x.startsWith("CASCET_MAX_PER_CALL is required")));
    assert.ok(p.some(x => x.startsWith("CASCET_MAX_SESSION is required")));
    assert.ok(p.some(x => x.startsWith("CASCET_MAX_TOTAL is required")));
    assert.ok(problemsOf({ ...BASE, CASCET_MAX_TOTAL: undefined }).some(x => x.startsWith("CASCET_MAX_TOTAL is required")));

    const r = loadAnalystConfig({
      ...BASE,
      CASCET_MAX_PER_CALL: undefined,
      CASCET_MAX_SESSION: undefined,
      CASCET_MAX_TOTAL: undefined,
      CASCET_ALLOW_UNLIMITED_BUDGET: "1",
    });
    assert.ok(r.ok);
    assert.equal(r.config.maxPerCallRaw, undefined);
    assert.equal(r.config.maxSessionRaw, undefined);
    assert.equal(r.config.maxTotalRaw, undefined);
    assert.equal(r.warnings.length, 3);
  });

  it("refuses CASCET_MAX_TOTAL when nothing bounds one analysis (L03)", () => {
    const p = problemsOf({
      ...BASE,
      CASCET_MAX_PER_CALL: undefined,
      CASCET_MAX_SESSION: undefined,
      CASCET_ALLOW_UNLIMITED_BUDGET: "1",
    });
    assert.ok(p.some(x => x.startsWith("CASCET_MAX_TOTAL needs CASCET_MAX_PER_CALL or CASCET_MAX_SESSION")), JSON.stringify(p));
    // One per-analysis bound is enough.
    assert.ok(loadAnalystConfig({ ...BASE, CASCET_MAX_SESSION: undefined, CASCET_ALLOW_UNLIMITED_BUDGET: "1" }).ok);
  });

  it("warns when CASCET_MAX_TOTAL is below what one full analysis may authorize", () => {
    // A full analysis makes 4 purchases: min(5e9 per analysis, 4 x 1e9 per call) = 4e9 raw.
    const tight = loadAnalystConfig({ ...BASE, CASCET_MAX_TOTAL: "3999999999" });
    assert.ok(tight.ok);
    assert.ok(tight.warnings.some(w => w.includes("below what one full analysis may authorize (4000000000 raw)")));
    const roomy = loadAnalystConfig({ ...BASE, CASCET_MAX_TOTAL: "4000000000" });
    assert.ok(roomy.ok);
    assert.deepEqual(roomy.warnings, []);
  });

  it("rejects caps that are not positive decimal integers", () => {
    for (const bad of ["-5", "0", "0x10", "1e9", "5.0", " 1 2", "1".repeat(41)]) {
      for (const name of ["CASCET_MAX_PER_CALL", "CASCET_MAX_SESSION", "CASCET_MAX_TOTAL"]) {
        assert.ok(
          problemsOf({ ...BASE, [name]: bad }).some(p => p.startsWith(`${name} must be a positive integer`)),
          `${name}="${bad}" must be rejected`,
        );
      }
    }
    const r = loadAnalystConfig({ ...BASE, CASCET_MAX_SESSION: "  000123 " });
    assert.ok(r.ok);
    assert.equal(r.config.maxSessionRaw, "123");
  });

  it("rejects a public key as payTo and points at the account-hash helper (M01)", () => {
    for (const key of [ED25519_PUBLIC_KEY, SECP256K1_PUBLIC_KEY]) {
      const p = problemsOf({ ...BASE, CASCET_ALLOWED_PAYTO: key });
      assert.ok(p.some(x => x.includes("is a public key") && x.includes("npx @cascet/cli account-hash")), JSON.stringify(p));
    }
  });

  it("normalizes payTo and asset allowlist entries to the shared form and drops duplicates", () => {
    const r = loadAnalystConfig({
      ...BASE,
      CASCET_ALLOWED_PAYTO: ` account-hash-${ACCOUNT.toUpperCase()}, 00${ACCOUNT} `,
      CASCET_ALLOWED_ASSETS: `${TOKEN},0x${TOKEN},contract-package-${TOKEN}`,
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(r.config.allowedPayTo, [`00${ACCOUNT}`]);
    assert.deepEqual(r.config.allowedAssets, [`hash-${TOKEN}`]);
  });

  it("accepts only account-hash payTo forms", () => {
    for (const bad of [`0x00${ACCOUNT}`, `contract-package-${TOKEN}`, `0x${ACCOUNT}`, ACCOUNT, `account-hash-${ACCOUNT}ff`]) {
      assert.ok(problemsOf({ ...BASE, CASCET_ALLOWED_PAYTO: bad }).some(p => p.startsWith("CASCET_ALLOWED_PAYTO:")), bad);
    }
  });

  it("refuses contract-package payees, which casper-x402 1.0.0 cannot settle to", () => {
    for (const pkg of [`hash-${TOKEN}`, `package-hash-${TOKEN}`]) {
      assert.ok(
        problemsOf({ ...BASE, CASCET_ALLOWED_PAYTO: pkg }).some(p => p.includes("contract-package payee")),
        pkg,
      );
    }
  });

  it("validates CASCET_NETWORK and never accepts a wildcard", () => {
    assert.ok(problemsOf({ ...BASE, CASCET_NETWORK: "casper:*" }).some(p => p.includes("wildcard")));
    assert.ok(problemsOf({ ...BASE, CASCET_NETWORK: "eip155:1" }).some(p => p.includes("not a Casper CAIP-2")));
    const r = loadAnalystConfig({ ...BASE, CASCET_NETWORK: "casper:casper, casper:casper-test" });
    assert.ok(r.ok);
    assert.deepEqual(r.config.networks, ["casper:casper", "casper:casper-test"]);
  });

  it("refuses at startup a network the paying fetch would refuse in every analysis", () => {
    // @cascet/client takes at most 32 characters after "casper:" (CAIP-2).
    for (const length of [33, 40, 63]) {
      const network = `casper:${"a".repeat(length)}`;
      assert.ok(
        problemsOf({ ...BASE, CASCET_NETWORK: `casper:casper-test,${network}` }).some(p => p.startsWith("CASCET_NETWORK:")),
        `a ${length}-character name must be refused`,
      );
      assert.throws(() => normalizeNetworks([network]));
    }
    const longest = `casper:${"a".repeat(32)}`;
    const r = loadAnalystConfig({ ...BASE, CASCET_NETWORK: longest });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(normalizeNetworks(r.config.networks), [longest]);
  });

  it("refuses plain http:// to a remote data gateway unless explicitly allowed", () => {
    assert.ok(problemsOf({ ...BASE, DATA_GATEWAY_URL: "http://data.example.com/mcp" }).some(p => p.includes("plain http://")));
    assert.ok(loadAnalystConfig({ ...BASE, DATA_GATEWAY_URL: "http://data.example.com/mcp", CASCET_ALLOW_INSECURE_HTTP: "1" }).ok);
    assert.ok(loadAnalystConfig({ ...BASE, DATA_GATEWAY_URL: "https://data.example.com/mcp" }).ok);
    assert.ok(loadAnalystConfig({ ...BASE, DATA_GATEWAY_URL: "http://127.0.0.1:4402/mcp" }).ok);
    assert.ok(loadAnalystConfig({ ...BASE, DATA_GATEWAY_URL: "http://[::1]:4402/mcp" }).ok);
    assert.ok(problemsOf({ ...BASE, DATA_GATEWAY_URL: "https://user:pw@data.example.com/mcp" }).some(p => p.includes("credentials")));
    assert.ok(problemsOf({ ...BASE, DATA_GATEWAY_URL: "ftp://data.example.com/" }).some(p => p.includes("http(s)")));
    assert.ok(problemsOf({ ...BASE, DATA_GATEWAY_URL: "not a url" }).some(p => p.includes("not a valid URL")));
  });

  it("validates the key algorithm and the purchase timeout", () => {
    assert.ok(problemsOf({ ...BASE, CASCET_KEY_ALGO: "rsa" }).some(p => p.includes("CASCET_KEY_ALGO")));
    const r = loadAnalystConfig({ ...BASE, CASCET_KEY_ALGO: "SECP256K1", CASCET_TIMEOUT_MS: "20000" });
    assert.ok(r.ok);
    assert.equal(r.config.keyAlgorithm, "secp256k1");
    assert.equal(r.config.timeoutMs, 20_000);
    for (const bad of ["0", "999", "600001", "abc", "1.5"]) {
      assert.ok(problemsOf({ ...BASE, CASCET_TIMEOUT_MS: bad }).some(p => p.includes("CASCET_TIMEOUT_MS")), bad);
    }
  });
});

describe("normalizePayTo / normalizeAssetHash", () => {
  it("rejects garbage with a helpful message", () => {
    assert.ok("error" in normalizePayTo("alice"));
    assert.ok("error" in normalizePayTo(`00${ACCOUNT}ff`));
    assert.ok("error" in normalizeAssetHash("hash-1234"));
    assert.deepEqual(normalizeAssetHash(`HASH-${TOKEN.toUpperCase()}`), { value: `hash-${TOKEN}` });
  });
});
