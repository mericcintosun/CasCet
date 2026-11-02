import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cascetConfigSchema, normalizeOrigin, timeoutsSchema } from "./config.js";

const base = {
  name: "test",
  upstream: { type: "stdio", command: "node" },
  payTo: `00${"11".repeat(32)}`,
  asset: { packageHash: `hash-${"22".repeat(32)}`, name: "Token", symbol: "TKN" },
  facilitator: {},
  pricing: {},
};

const parse = (extra: Record<string, unknown> = {}) => cascetConfigSchema.safeParse({ ...base, ...extra });

describe("gateway config defaults", () => {
  it("is safe by default: loopback, no browser access, bounded timeouts, no free passthrough", () => {
    const cfg = cascetConfigSchema.parse(base);
    assert.equal(cfg.host, "127.0.0.1");
    assert.deepEqual(cfg.cors, { allowedOrigins: [] });
    assert.deepEqual(cfg.timeouts, { facilitatorMs: 15_000, settleMs: 90_000, upstreamMs: 60_000 });
    assert.deepEqual(cfg.pricing.freeTools, []);
    assert.deepEqual(cfg.settlement, { eventScanWindow: 64, acceptThirdPartySettlement: false });
  });

  it("defaults tool prices to settle after execution", () => {
    const cfg = cascetConfigSchema.parse({ ...base, pricing: { tools: { a: { price: "$0.01" } } } });
    assert.equal(cfg.pricing.tools.a?.settleBeforeExecute, false);
  });

  it("uses a tight anchoring gas limit and leaves the chain name to the network", () => {
    const cfg = cascetConfigSchema.parse({
      ...base,
      anchoring: { contractPackageHash: "hash-ab", keyPath: "k.pem", nodeUrl: "https://node.example/rpc" },
    });
    assert.equal(cfg.anchoring?.gasMotes, 2_500_000_000);
    assert.equal(cfg.anchoring?.chainName, undefined);
    assert.equal(cfg.anchoring?.maxConsecutiveFailures, 3);
  });

  it("refuses a timeout setTimeout cannot hold: Node would fire it after 1 ms", () => {
    const longest = 2_147_483_647;
    for (const field of ["facilitatorMs", "settleMs", "upstreamMs"]) {
      for (const value of [longest + 1, 2_592_000_000, 9_999_999_999]) {
        const result = timeoutsSchema.safeParse({ [field]: value });
        assert.equal(result.success, false, `${field} ${value}`);
        assert.deepEqual(result.error?.issues.map(issue => issue.path), [[field]]);
      }
      assert.equal(timeoutsSchema.safeParse({ [field]: longest }).success, true, field);
    }
    assert.match(JSON.stringify(parse({ timeouts: { settleMs: 2_592_000_000 } }).error?.issues), /"path":\["timeouts","settleMs"\]/);
  });

  it("accepts port 0 and rejects ports outside 0-65535", () => {
    assert.equal(parse({ port: 0 }).success, true);
    assert.equal(parse({ port: 70_000 }).success, false);
    assert.equal(parse({ port: -1 }).success, false);
  });
});

describe("cors.allowedOrigins", () => {
  it("never accepts the wildcard, the null origin or URLs with a path", () => {
    for (const origin of ["*", "null", "https://app.example/path", "ftp://app.example", "app.example", "https://u:p@app.example"]) {
      assert.equal(parse({ cors: { allowedOrigins: [origin] } }).success, false, origin);
    }
  });

  it("stores canonical origins", () => {
    const cfg = cascetConfigSchema.parse({ ...base, cors: { allowedOrigins: ["HTTPS://App.Example:443/", "http://localhost:3000"] } });
    assert.deepEqual(cfg.cors.allowedOrigins, ["https://app.example", "http://localhost:3000"]);
  });

  it("normalizeOrigin matches what browsers send", () => {
    assert.equal(normalizeOrigin("https://app.example"), "https://app.example");
    assert.equal(normalizeOrigin("http://127.0.0.1:4402"), "http://127.0.0.1:4402");
    assert.equal(normalizeOrigin("null"), undefined);
    assert.equal(normalizeOrigin("not a url"), undefined);
  });
});

describe("pricing.freeTools", () => {
  it("rejects a tool that is both priced and free", () => {
    const result = parse({ pricing: { tools: { a: { price: "$0.01" } }, freeTools: ["a", "b"] } });
    assert.equal(result.success, false);
    assert.match(JSON.stringify(result.error?.issues), /both priced/);
  });
});
