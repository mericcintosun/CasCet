import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cascetConfigSchema,
  DEFAULT_FACILITATOR_URL,
  DEFAULT_SELF_HOSTED_FACILITATOR_URL,
  normalizePackageHash,
} from "@cascet/core";
import { CASCET_TESTNET_X402_TOKEN, initNextSteps, initTemplate, PAYTO_PLACEHOLDER } from "./init-template.js";
import { facilitatorWarnings, formatConfigIssues, payToWarnings, wrapWarnings } from "./wrap-check.js";

const ACCOUNT_HASH = "00" + "a1".repeat(32);
const WCSPR_TESTNET = "hash-3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";

describe("cascet init template (M01, M41, M03)", () => {
  it("cannot be wrapped until payTo is replaced, and the error says how", () => {
    const result = cascetConfigSchema.safeParse(initTemplate("demo"));
    assert.equal(result.success, false);
    const issues = result.error?.issues ?? [];
    assert.deepEqual(issues.map(issue => issue.path.join(".")), ["payTo"]);
    assert.match(formatConfigIssues(issues), /payTo: .*npx @cascet\/cli account-hash <public-key>/);
    assert.match(PAYTO_PLACEHOLDER, /^<00 \+ your 64-hex account hash/, "asks for the account hash, not a public key");
  });

  it("is a coherent testnet setup once payTo is filled in", () => {
    const cfg = cascetConfigSchema.parse({ ...initTemplate("demo"), payTo: ACCOUNT_HASH });
    assert.equal(cfg.payTo, ACCOUNT_HASH);
    assert.equal(cfg.network, "casper:casper-test");
    assert.equal(cfg.facilitator.url, DEFAULT_SELF_HOSTED_FACILITATOR_URL);
    assert.equal(cfg.asset.packageHash, normalizePackageHash(CASCET_TESTNET_X402_TOKEN), "stored as bare hex");
    assert.equal(cfg.asset.authorization, "legacy-amount", "CasCet's token takes `amount`");
    assert.equal(cfg.asset.name, "CasCet X402 Token", "EIP-712 domain name of CasCet's token");
    assert.deepEqual(facilitatorWarnings(cfg), []);
  });

  it("prints how to get the account hash and start the self-hosted facilitator", () => {
    const steps = initNextSteps();
    assert.match(steps, /npx @cascet\/cli account-hash/);
    assert.match(steps, /pnpm --filter @cascet\/e2e facilitator/);
    assert.match(steps, /CASCET_FACILITATOR_KEY=/);
    assert.ok(steps.includes(WCSPR_TESTNET), "names the CEP-3009 token the hosted facilitator can settle");
  });
});

describe("facilitatorWarnings (M03)", () => {
  const base = { network: "casper:casper-test", asset: { packageHash: CASCET_TESTNET_X402_TOKEN } };

  it("warns when the hosted facilitator is paired with a token it cannot settle", () => {
    const warnings = facilitatorWarnings({ ...base, facilitator: { url: `${DEFAULT_FACILITATOR_URL}/`, apiKey: "token" } } as never);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /only settles CEP-3009 tokens.*User error: 64658/);
  });

  it("asks for an access token on the hosted facilitator", () => {
    const warnings = facilitatorWarnings({
      network: "casper:casper-test",
      asset: { packageHash: WCSPR_TESTNET },
      facilitator: { url: DEFAULT_FACILITATOR_URL },
    } as never);
    assert.deepEqual(warnings, ["WARNING: the hosted facilitator needs a CSPR.cloud access token in facilitator.apiKey."]);
  });

  it("is quiet for the official Wrapped CSPR with a token, and for other facilitators", () => {
    assert.deepEqual(
      facilitatorWarnings({ network: "casper:casper-test", asset: { packageHash: WCSPR_TESTNET }, facilitator: { url: DEFAULT_FACILITATOR_URL, apiKey: "t" } } as never),
      [],
    );
    assert.deepEqual(facilitatorWarnings({ ...base, facilitator: { url: "http://127.0.0.1:4501" } } as never), []);
  });
});

describe("payToWarnings (contract-package payees)", () => {
  const PACKAGE = "c3".repeat(32);

  it("warns when payTo is a contract package, which no facilitator can settle today", () => {
    const cfg = cascetConfigSchema.parse({ ...initTemplate("demo"), payTo: `hash-${PACKAGE}` });
    assert.equal(cfg.payTo, `01${PACKAGE}`, "the schema still accepts the shared contract-package form");
    const warnings = payToWarnings(cfg);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /is a contract package .*credited to an account nobody controls.*CasCet buyers refuse/);
    assert.match(warnings[0] ?? "", /npx @cascet\/cli account-hash/);
    assert.deepEqual(wrapWarnings(cfg), warnings, "wrap prints it (the template's facilitator is fine)");
  });

  it("is quiet for an account hash", () => {
    const cfg = cascetConfigSchema.parse({ ...initTemplate("demo"), payTo: `account-hash-${"a1".repeat(32)}` });
    assert.deepEqual(payToWarnings(cfg), []);
    assert.deepEqual(wrapWarnings(cfg), []);
  });
});
