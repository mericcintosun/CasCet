import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { x402ResourceServer, type FacilitatorClient, type HTTPAdapter } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import {
  buildToolTable,
  createPaymentRail,
  maxTimeoutSecondsFor,
  requiredValiditySeconds,
  resolveToolPolicy,
  routeForTool,
  settleablePayTo,
  unmatchedConfiguredTools,
  type PaymentRail,
} from "./paywall.js";
import { ASSET, PAY_TO, PRICE_RAW, testConfig } from "./testing/harness.js";

const unusedFacilitator: FacilitatorClient = {
  verify: () => Promise.reject(new Error("unused")),
  settle: () => Promise.reject(new Error("unused")),
  getSupported: () => Promise.reject(new Error("unused")),
};

function rail(): PaymentRail {
  return {
    resourceServer: new x402ResourceServer(unusedFacilitator),
    network: "casper:casper-test" as Network,
    payTo: PAY_TO,
    assets: testConfig().assets,
    maxTimeoutSeconds: 300,
  };
}

const adapter: HTTPAdapter = {
  getHeader: () => undefined,
  getMethod: () => "POST",
  getPath: () => "/mcp",
  getUrl: () => "http://127.0.0.1/mcp",
  getAcceptHeader: () => "application/json",
  getUserAgent: () => "test",
};

const tool = (name: string) => ({ name, inputSchema: { type: "object" as const } });

describe("resolveToolPolicy", () => {
  const cfg = testConfig({
    pricing: { tools: { paid_tool: { price: "$0.01" }, constructor: { price: "$0.01", settleBeforeExecute: true } }, freeTools: ["free_tool"] },
  });

  it("prices listed tools, frees listed free tools and hides everything else", () => {
    assert.deepEqual(resolveToolPolicy(cfg, "paid_tool"), {
      kind: "paid",
      price: { price: "$0.01", settleBeforeExecute: false },
      accepts: [{ asset: cfg.asset, amount: PRICE_RAW }],
      settleBeforeExecute: false,
    });
    assert.equal(cfg.asset.packageHash, ASSET);
    assert.deepEqual(resolveToolPolicy(cfg, "free_tool"), { kind: "free" });
    assert.equal(resolveToolPolicy(cfg, "secret_tool"), undefined);
  });

  it("never prices tools through Object.prototype names", () => {
    for (const name of ["toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      assert.equal(resolveToolPolicy(cfg, name), undefined, name);
    }
    const priced = resolveToolPolicy(cfg, "constructor");
    assert.equal(priced?.kind, "paid");
    assert.equal(priced?.kind === "paid" && priced.settleBeforeExecute, true);
  });

  it("applies pricing.default to every tool that is not explicitly free", () => {
    const withDefault = testConfig({ pricing: { default: { price: "$0.02" }, freeTools: ["free_tool"] } });
    assert.equal(resolveToolPolicy(withDefault, "anything")?.kind, "paid");
    assert.equal(resolveToolPolicy(withDefault, "free_tool")?.kind, "free");
  });
});

describe("tool routes", () => {
  it("gives every tool name its own inert route", () => {
    const names = ["tool", "Tool", "a*", "ab", ":id", "x/y", "[z]", "naïve", "%2F"];
    const routes = names.map(routeForTool);
    assert.equal(new Set(routes).size, names.length);
    for (const route of routes) assert.match(route, /^\/tools\/[0-9a-f]+$/);
  });

  it("keeps routes of priced tools distinct even for names x402 would treat as patterns", () => {
    const cfg = testConfig({ pricing: { tools: { "a*": { price: "$0.01" }, Tool: { price: "$0.01" } } } });
    const table = buildToolTable(cfg, rail(), [tool("a*"), tool("abc"), tool("Tool"), tool("tool")]);
    const requires = (name: string) => table.http.requiresPayment({ adapter, path: routeForTool(name), method: "POST" });
    assert.equal(requires("a*"), true);
    assert.equal(requires("Tool"), true);
    assert.equal(requires("abc"), false, "a* must not price abc");
    assert.equal(requires("tool"), false, "Tool must not price tool");
    assert.deepEqual(table.hiddenToolNames, ["abc", "tool"]);
  });
});

describe("buildToolTable", () => {
  it("lists priced tools with their price annotation and free tools unchanged", () => {
    const cfg = testConfig();
    const table = buildToolTable(cfg, rail(), [tool("paid_tool"), tool("free_tool"), tool("secret_tool")]);
    assert.deepEqual(table.pricedToolNames, ["paid_tool"]);
    assert.deepEqual(table.freeToolNames, ["free_tool"]);
    assert.deepEqual(table.hiddenToolNames, ["secret_tool"]);
    assert.deepEqual(
      table.visibleTools.map(t => t.name),
      ["paid_tool", "free_tool"],
    );
    assert.match(table.visibleTools[0]?.description ?? "", /\[PAID: \$0\.01 per call/);
  });

  it("names configured tools the upstream does not offer", () => {
    const cfg = testConfig({ pricing: { tools: { paid_tool: { price: "$0.01" }, typo_tool: { price: "$0.01" } }, freeTools: ["gone"] } });
    assert.deepEqual(unmatchedConfiguredTools(cfg, [tool("paid_tool")]), ["typo_tool", "gone"]);
  });
});

describe("maxTimeoutSecondsFor", () => {
  it("covers verifying, running the tool and settling, never below 300 s", () => {
    assert.equal(maxTimeoutSecondsFor(testConfig()), 300);
    assert.equal(maxTimeoutSecondsFor(testConfig({ timeouts: { facilitatorMs: 15_000, upstreamMs: 600_000, settleMs: 90_000 } })), 735);
  });
});

describe("requiredValiditySeconds", () => {
  it("leaves the settle headroom after the facilitator's verify and, by default, the tool run", () => {
    const cfg = testConfig({ timeouts: { facilitatorMs: 15_000, upstreamMs: 60_000 } });
    assert.equal(requiredValiditySeconds(cfg, false), 15 + 60 + 30);
    assert.equal(requiredValiditySeconds(cfg, true), 15 + 30);
  });
});

describe("payTo (L60)", () => {
  const hex = "ab".repeat(32);

  it("accepts an account in either spelling and returns the 00-prefixed form", () => {
    assert.equal(settleablePayTo(`00${hex}`), `00${hex}`);
    assert.equal(settleablePayTo(`00${hex.toUpperCase()}`), `00${hex}`);
    assert.equal(settleablePayTo(`account-hash-${hex}`), `00${hex}`);
  });

  it("refuses a contract package payee, which casper-x402 1.0.0 can never settle to", () => {
    assert.throws(() => settleablePayTo(`01${hex}`), /cannot settle to a contract package.*account-hash <public-key>/);
  });

  it("refuses public keys and anything else with the account-hash hint", () => {
    for (const value of [`02${"cd".repeat(33)}`, `hash-${hex}`, "", "<your Casper public key>"]) {
      assert.throws(() => settleablePayTo(value), /npx @cascet\/cli account-hash <public-key>/, value);
    }
  });

  it("refuses at startup, before the facilitator is contacted", async () => {
    // The core config schema already rejects a raw "01" payTo (it has the shape
    // of an ed25519 public key), so `cascet wrap` never gets this far. The rail
    // keeps its own guard for configs built in code, which bypass the schema.
    assert.throws(() => testConfig({ payTo: `01${hex}` }), /is a Casper public key, not an account hash/);
    await assert.rejects(createPaymentRail({ ...testConfig(), payTo: `01${hex}` }), /cannot settle to a contract package/);
  });
});
