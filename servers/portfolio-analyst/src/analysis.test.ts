import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzePortfolio, planPurchases, type AnalyzeContext, type DataBuyer } from "./analysis.js";
import { REASONS } from "./sanitize.js";
import {
  DATA,
  FakeBuyer,
  GatedBuyer,
  INTERNAL_ERRORS,
  LEAK_MARKERS,
  PAYMENT_IDS,
  PORTFOLIO,
  succeed,
  textResult,
} from "./test-fakes.js";

const never = new AbortController().signal;

function ctx(buyer: DataBuyer, overrides: Partial<AnalyzeContext> = {}): AnalyzeContext & { lines: string[] } {
  const lines: string[] = [];
  return { buyer, signal: never, cancelled: never, log: line => lines.push(line), lines, ...overrides };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find(c => c.type === "text");
  assert.ok(block?.text !== undefined, "result has a text block");
  return block.text;
}

function bodyOf(result: { isError?: boolean; content: Array<{ type: string; text?: string }> }) {
  assert.notEqual(result.isError, true, `expected a successful analysis, got: ${textOf(result)}`);
  return JSON.parse(textOf(result)) as {
    partial: boolean;
    allocation: Array<{ asset: string; change24hPct: number | null }>;
    recommendations: string[];
    marketData: Record<string, { priceUsd: number; change24hPct: number | null; source: string }>;
    costBreakdown: {
      totalSpentRaw: string;
      purchases: Array<{ tool: string; paymentId?: string; source: string }>;
      failed: Array<{ input: string; reason: string }>;
      cascadeParent: string | null;
    };
  };
}

describe("planPurchases", () => {
  it("buys each input once, CSPR first and yields last", () => {
    const plan = planPurchases([...PORTFOLIO, { asset: "gold", amountUsd: 5 }]);
    assert.deepEqual(
      plan.map(p => p.input),
      ["get_cspr_market_data", "get_rwa_price(gold)", "get_rwa_price(treasury)", "get_defi_yields"],
    );
  });

  it("keeps the holdings order for RWA inputs", () => {
    const plan = planPurchases([
      { asset: "treasury", amountUsd: 1 },
      { asset: "gold", amountUsd: 1 },
    ]);
    assert.deepEqual(
      plan.map(p => p.input),
      ["get_rwa_price(treasury)", "get_rwa_price(gold)"],
    );
  });

  it("does not buy staking yields for a portfolio without CSPR (L142)", () => {
    const plan = planPurchases([{ asset: "gold", amountUsd: 10 }]);
    assert.deepEqual(
      plan.map(p => p.tool),
      ["get_rwa_price"],
    );
  });
});

describe("analyzePortfolio", { timeout: 15_000 }, () => {
  it("returns the full analysis with provenance when every purchase succeeds", async () => {
    const buyer = new FakeBuyer();
    const parentId = "0d2a7f3e-5b6c-4d7e-9f80-1a2b3c4d5e6f";
    const body = bodyOf(await analyzePortfolio(PORTFOLIO, ctx(buyer, { parentId })));
    assert.equal(body.partial, false);
    assert.deepEqual(body.costBreakdown.failed, []);
    assert.equal(body.costBreakdown.purchases.length, 4);
    assert.equal(body.costBreakdown.purchases[0]?.paymentId, PAYMENT_IDS.get_cspr_market_data);
    assert.equal(body.costBreakdown.purchases[1]?.source, "coingecko(live)");
    assert.equal(body.costBreakdown.cascadeParent, parentId);
    assert.equal(body.costBreakdown.totalSpentRaw, "2000000000");
    assert.equal(body.marketData.CSPR?.priceUsd, 0.0231);
    assert.equal(body.marketData.gold?.source, "coingecko(live)");
    assert.match(body.recommendations[1] ?? "", /~11\.2% APY via Native staking/);
    // All four inputs are bought in parallel.
    assert.equal(buyer.started.length, 4);
  });

  it("returns a partial analysis listing the failed input when one purchase throws (M14)", async () => {
    const buyer = new FakeBuyer({ "get_rwa_price(gold)": () => Promise.reject(INTERNAL_ERRORS.unreachable()) });
    const c = ctx(buyer);
    const result = await analyzePortfolio(PORTFOLIO, c);
    const body = bodyOf(result);
    assert.equal(body.partial, true);
    assert.deepEqual(body.costBreakdown.failed, [{ input: "get_rwa_price(gold)", reason: REASONS.unreachable }]);
    // The inputs that were bought are still used, not thrown away.
    assert.equal(body.marketData.CSPR?.priceUsd, 0.0231);
    assert.equal(body.marketData.treasury?.priceUsd, 112.9);
    assert.equal(body.marketData.gold, undefined);
    assert.equal(body.allocation.find(a => a.asset === "gold")?.change24hPct, null);
    assert.deepEqual(
      body.costBreakdown.purchases.map(p => p.tool),
      ["get_cspr_market_data", "get_rwa_price(treasury)", "get_defi_yields"],
    );
    // The operator log keeps the details the caller does not get.
    assert.ok(c.lines.some(l => l.includes("ECONNREFUSED 10.0.0.7:4402")));
  });

  it("checks isError before parsing a downstream result (M14)", async () => {
    const buyer = new FakeBuyer({
      get_defi_yields: async () => ({
        result: { isError: true, content: [{ type: "text", text: "upstream tool failed (not charged): TypeError at /srv/x.js" }] },
      }),
    });
    const body = bodyOf(await analyzePortfolio(PORTFOLIO, ctx(buyer)));
    assert.deepEqual(body.costBreakdown.failed, [{ input: "get_defi_yields", reason: REASONS.providerError }]);
    assert.equal(body.recommendations.length, 1, "no yield recommendation without yield data");
  });

  it("rejects malformed or mistyped downstream data instead of casting it (L141)", async () => {
    const malformed = {
      get_cspr_market_data: async () => ({ result: textResult("not json at all"), paymentId: PAYMENT_IDS.get_cspr_market_data }),
      "get_rwa_price(gold)": async () => ({ result: textResult({ priceUsd: "3312.4" }) }),
      "get_rwa_price(treasury)": async () => ({ result: textResult({ priceUsd: -1 }) }),
      get_defi_yields: async () => ({ result: textResult({ yields: [{ venue: "x", apyPct: 1e9, risk: "low" }] }) }),
    };
    const result = await analyzePortfolio(PORTFOLIO, ctx(new FakeBuyer(malformed)));
    assert.equal(result.isError, true, "nothing usable was bought");
    const text = textOf(result);
    for (const input of ["get_cspr_market_data", "get_rwa_price(gold)", "get_rwa_price(treasury)", "get_defi_yields"]) {
      assert.ok(text.includes(`${input}: ${REASONS.malformed}`), `${input} reported as malformed: ${text}`);
    }
  });

  it("keeps a paid-but-unusable purchase in the cost breakdown", async () => {
    const buyer = new FakeBuyer({
      "get_rwa_price(gold)": async () => ({ result: textResult("{oops"), paymentId: PAYMENT_IDS["get_rwa_price(gold)"] }),
    });
    const body = bodyOf(await analyzePortfolio(PORTFOLIO, ctx(buyer)));
    assert.deepEqual(body.costBreakdown.failed, [{ input: "get_rwa_price(gold)", reason: REASONS.malformed }]);
    assert.ok(
      body.costBreakdown.purchases.some(
        p => p.tool === "get_rwa_price(gold)" && p.paymentId === PAYMENT_IDS["get_rwa_price(gold)"] && p.source === "unusable",
      ),
    );
  });

  it("cleans provider text and drops a malformed payment id", async () => {
    const buyer = new FakeBuyer({
      get_defi_yields: async () => ({
        result: textResult({
          yields: [{ venue: "Evil‮ venue\u0000\nname" + "x".repeat(500), apyPct: 50, risk: "low\u0007" }],
          source: "s".repeat(300),
        }),
        paymentId: "not-a-uuid\r\nX-Injected: 1",
      }),
    });
    const body = bodyOf(await analyzePortfolio(PORTFOLIO, ctx(buyer)));
    const yieldPurchase = body.costBreakdown.purchases.find(p => p.tool === "get_defi_yields");
    assert.equal(yieldPurchase?.paymentId, undefined);
    assert.ok((yieldPurchase?.source.length ?? 0) <= 80);
    const rec = body.recommendations[1] ?? "";
    assert.doesNotMatch(rec, /[\u0000-\u001f‮]/);
    assert.match(rec, /via Evil venue name/);
    assert.ok(rec.length < 200);
  });

  it("returns an error, with only caller-safe reasons, when nothing could be bought", async () => {
    const buyer = new FakeBuyer({
      get_cspr_market_data: () => Promise.reject(INTERNAL_ERRORS.unreachable()),
      "get_rwa_price(gold)": () => Promise.reject(INTERNAL_ERRORS.rpcError()),
      "get_rwa_price(treasury)": () => Promise.reject(INTERNAL_ERRORS.http500()),
      get_defi_yields: () => Promise.reject(INTERNAL_ERRORS.budget()),
    });
    const result = await analyzePortfolio(PORTFOLIO, ctx(buyer));
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /^analysis unavailable: no market data could be bought/);
    assert.ok(text.includes(`get_cspr_market_data: ${REASONS.unreachable}`));
    assert.ok(text.includes(`get_rwa_price(gold): ${REASONS.providerError}`));
    assert.ok(text.includes("get_rwa_price(treasury): the data provider answered HTTP 500"));
    assert.ok(text.includes(`get_defi_yields: ${REASONS.policy}`));
    for (const marker of LEAK_MARKERS) assert.ok(!text.includes(marker), `leaked "${marker}" in: ${text}`);
  });

  it("does not start any purchase once the request is aborted", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const buyer = new FakeBuyer();
    const result = await analyzePortfolio(PORTFOLIO, ctx(buyer, { signal: cancelled.signal, cancelled: cancelled.signal }));
    assert.equal(result.isError, true);
    assert.equal(buyer.started.length, 0);
  });

  it("stops buying when the request is aborted mid-flight (M06)", async () => {
    const inbound = new AbortController();
    const buyer = new GatedBuyer(inbound.signal);
    const pending = analyzePortfolio(PORTFOLIO, ctx(buyer, { signal: inbound.signal, cancelled: inbound.signal }));
    await buyer.whenStarted(4);
    inbound.abort();
    buyer.release(); // too late: the probes already failed and nothing may be paid now
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "analysis cancelled");
    assert.deepEqual(buyer.paid, []);
  });

  it("returns what was bought when the purchase deadline passes (partial, timed out)", async () => {
    const deadline = new AbortController();
    const buyer = new FakeBuyer({
      get_defi_yields: () =>
        new Promise((_, reject) => {
          deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason), { once: true });
          setImmediate(() => deadline.abort(new DOMException("deadline", "TimeoutError")));
        }),
    });
    const body = bodyOf(await analyzePortfolio(PORTFOLIO, ctx(buyer, { signal: deadline.signal, cancelled: never })));
    assert.equal(body.partial, true);
    assert.deepEqual(body.costBreakdown.failed, [{ input: "get_defi_yields", reason: REASONS.timedOut }]);
    assert.equal(body.marketData.gold?.priceUsd, 3312.4);
  });

  it("classifies a failure when it happens, not after a later abort", async () => {
    const deadline = new AbortController();
    const buyer = new FakeBuyer({
      "get_rwa_price(gold)": () => Promise.reject(INTERNAL_ERRORS.http500()),
      get_defi_yields: () =>
        new Promise((_, reject) => {
          deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason), { once: true });
          setTimeout(() => deadline.abort(), 5);
        }),
    });
    const body = bodyOf(await analyzePortfolio(PORTFOLIO, ctx(buyer, { signal: deadline.signal, cancelled: never })));
    assert.deepEqual(body.costBreakdown.failed, [
      { input: "get_rwa_price(gold)", reason: "the data provider answered HTTP 500" },
      { input: "get_defi_yields", reason: REASONS.timedOut },
    ]);
  });

  it("uses every successful purchase even when the buyer resolves out of order", async () => {
    const buyer = new FakeBuyer({
      get_cspr_market_data: input => new Promise(resolve => setTimeout(() => resolve(succeed(input)), 5)),
    });
    const body = bodyOf(await analyzePortfolio(PORTFOLIO, ctx(buyer)));
    assert.equal(body.marketData.CSPR?.priceUsd, (DATA.get_cspr_market_data as { priceUsd: number }).priceUsd);
    assert.equal(body.costBreakdown.purchases[0]?.tool, "get_cspr_market_data");
  });
});
