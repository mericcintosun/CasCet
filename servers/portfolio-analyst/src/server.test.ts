import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DataBuyer } from "./analysis.js";
import type { BuyerContext } from "./buyer.js";
import { loadAnalystConfig, type ConfigResult } from "./config.js";
import { REASONS } from "./sanitize.js";
import { createAnalystServer } from "./server.js";
import { FakeBuyer, GatedBuyer, INTERNAL_ERRORS, LEAK_MARKERS, PORTFOLIO, within } from "./test-fakes.js";

const VALID_ENV = {
  CASCET_KEY_PATH: "/nonexistent/analyst.pem",
  CASCET_ALLOWED_PAYTO: `00${"a".repeat(64)}`,
  CASCET_ALLOWED_ASSETS: `hash-${"b".repeat(64)}`,
  CASCET_MAX_PER_CALL: "1000000000",
  CASCET_MAX_SESSION: "5000000000",
};

/** The operator log, observable so a test can wait for a line without polling. */
class LineLog {
  readonly lines: string[] = [];
  private readonly waiters: Array<{ pattern: RegExp; resolve: () => void }> = [];

  push(line: string): void {
    this.lines.push(line);
    for (const w of [...this.waiters]) {
      if (w.pattern.test(line)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  }

  some(predicate: (line: string) => boolean): boolean {
    return this.lines.some(predicate);
  }

  waitFor(pattern: RegExp): Promise<void> {
    if (this.lines.some(l => pattern.test(l))) return Promise.resolve();
    return within(new Promise<void>(resolve => this.waiters.push({ pattern, resolve })), 5_000, `log line ${pattern}`);
  }
}

interface Harness {
  client: Client;
  lines: LineLog;
  contexts: BuyerContext[];
  close: () => Promise<void>;
}

async function start(opts: { config?: ConfigResult; buyer: (ctx: BuyerContext) => DataBuyer | Promise<DataBuyer> }): Promise<Harness> {
  const lines = new LineLog();
  const contexts: BuyerContext[] = [];
  const server = createAnalystServer({
    config: opts.config ?? loadAnalystConfig(VALID_ENV),
    createBuyer: async (_cfg, ctx) => {
      contexts.push(ctx);
      return opts.buyer(ctx);
    },
    log: line => lines.push(line),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-buyer", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    lines,
    contexts,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find(c => c.type === "text")?.text ?? "";
}

// Each test inherits the timeout, so a regression in the abort wiring fails instead of hanging.
describe("analyze_portfolio over MCP", { timeout: 15_000 }, () => {
  it("returns a partial analysis when one child purchase fails, without leaking internals (M14)", async () => {
    const h = await start({
      buyer: () =>
        new FakeBuyer({
          "get_rwa_price(gold)": () => Promise.reject(INTERNAL_ERRORS.rpcError()),
          get_defi_yields: () => Promise.reject(INTERNAL_ERRORS.http500()),
        }),
    });
    try {
      const result = await h.client.callTool({ name: "analyze_portfolio", arguments: { holdings: PORTFOLIO } });
      assert.notEqual(result.isError, true);
      const text = textOf(result);
      const body = JSON.parse(text) as { partial: boolean; costBreakdown: { failed: unknown[]; purchases: unknown[] } };
      assert.equal(body.partial, true);
      assert.deepEqual(body.costBreakdown.failed, [
        { input: "get_rwa_price(gold)", reason: REASONS.providerError },
        { input: "get_defi_yields", reason: "the data provider answered HTTP 500" },
      ]);
      assert.equal(body.costBreakdown.purchases.length, 2);
      for (const marker of LEAK_MARKERS) assert.ok(!text.includes(marker), `leaked "${marker}"`);
      assert.ok(h.lines.some(l => l.includes("/srv/cascet/keys/data_secret_key.pem")), "details stay in the operator log");
    } finally {
      await h.close();
    }
  });

  it("returns a sanitized error when no data could be bought", async () => {
    const h = await start({
      buyer: () =>
        new FakeBuyer({
          get_cspr_market_data: () => Promise.reject(INTERNAL_ERRORS.unreachable()),
          "get_rwa_price(gold)": () => Promise.reject(INTERNAL_ERRORS.rpcError()),
          "get_rwa_price(treasury)": () => Promise.reject(INTERNAL_ERRORS.http500()),
          get_defi_yields: () => Promise.reject(INTERNAL_ERRORS.budget()),
        }),
    });
    try {
      const result = await h.client.callTool({ name: "analyze_portfolio", arguments: { holdings: PORTFOLIO } });
      assert.equal(result.isError, true);
      const text = textOf(result);
      assert.match(text, /^analysis unavailable: no market data could be bought/);
      for (const marker of LEAK_MARKERS) assert.ok(!text.includes(marker), `leaked "${marker}" in: ${text}`);
    } finally {
      await h.close();
    }
  });

  it("turns an unexpected failure into a reference, never the raw message", async () => {
    const h = await start({
      buyer: () => {
        throw new Error("ENOENT: no such file or directory, open '/srv/cascet/keys/analyst.pem'");
      },
    });
    try {
      const result = await h.client.callTool({ name: "analyze_portfolio", arguments: { holdings: PORTFOLIO } });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /^analysis failed: internal error \(ref [0-9a-f]{8}\)$/);
      assert.ok(h.lines.some(l => l.includes("/srv/cascet/keys/analyst.pem")));
    } finally {
      await h.close();
    }
  });

  it("fails closed without buying anything when the configuration is invalid", async () => {
    let built = 0;
    const h = await start({
      config: loadAnalystConfig({ ...VALID_ENV, CASCET_ALLOWED_PAYTO: undefined }),
      buyer: () => {
        built++;
        return new FakeBuyer();
      },
    });
    try {
      const result = await h.client.callTool({ name: "analyze_portfolio", arguments: { holdings: PORTFOLIO } });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /not configured to buy market data/);
      assert.equal(built, 0);
      // tools/list keeps working so the server stays discoverable.
      const tools = await h.client.listTools();
      assert.deepEqual(
        tools.tools.map(t => t.name),
        ["analyze_portfolio"],
      );
    } finally {
      await h.close();
    }
  });

  it("stops buying when the caller cancels the request (M06)", async () => {
    let onBuyer: (b: GatedBuyer) => void = () => {};
    const buyerReady = new Promise<GatedBuyer>(resolve => (onBuyer = resolve));
    const h = await start({
      buyer: ctx => {
        const b = new GatedBuyer(ctx.signal);
        onBuyer(b);
        return b;
      },
    });
    try {
      const ac = new AbortController();
      const call = h.client.callTool({ name: "analyze_portfolio", arguments: { holdings: PORTFOLIO } }, undefined, {
        signal: ac.signal,
      });
      const buyer = await within(buyerReady, 5_000, "the request to reach the analyst");
      await within(buyer.whenStarted(4), 5_000, "all four purchases to start");
      ac.abort();
      await assert.rejects(call);
      // The MCP cancellation aborts the purchase signal on the server...
      await h.lines.waitFor(/analysis cancelled by the caller/);
      assert.equal(h.contexts[0]?.signal.aborted, true);
      // ...so the probes fail and nothing is paid, even if the gateway answers late.
      buyer.release();
      assert.deepEqual(buyer.paid, []);
      assert.equal(buyer.started.length, 4);
    } finally {
      await h.close();
    }
  });

  it("returns a partial analysis when the purchase deadline passes", async () => {
    const h = await start({
      config: loadAnalystConfig({ ...VALID_ENV, CASCET_TIMEOUT_MS: "1000" }),
      buyer: ctx =>
        new FakeBuyer({
          get_defi_yields: () =>
            new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true })),
        }),
    });
    try {
      const result = await h.client.callTool({ name: "analyze_portfolio", arguments: { holdings: PORTFOLIO } });
      const body = JSON.parse(textOf(result)) as { partial: boolean; costBreakdown: { failed: unknown[] } };
      assert.equal(body.partial, true);
      assert.deepEqual(body.costBreakdown.failed, [{ input: "get_defi_yields", reason: REASONS.timedOut }]);
    } finally {
      await h.close();
    }
  });

  it("forwards a well-formed cascade parent id and drops a malformed one (I56)", async () => {
    const h = await start({ buyer: () => new FakeBuyer() });
    try {
      const parent = "0d2a7f3e-5b6c-4d7e-9f80-1a2b3c4d5e6f";
      await h.client.callTool({
        name: "analyze_portfolio",
        arguments: { holdings: PORTFOLIO },
        _meta: { cascet: { paymentId: parent } },
      });
      await h.client.callTool({
        name: "analyze_portfolio",
        arguments: { holdings: PORTFOLIO },
        _meta: { cascet: { paymentId: "x\r\nX-Injected: 1" } },
      });
      assert.equal(h.contexts[0]?.parentId, parent);
      assert.equal(h.contexts[1]?.parentId, undefined);
    } finally {
      await h.close();
    }
  });

  it("rejects oversized or invalid input before buying", async () => {
    let built = 0;
    const h = await start({
      buyer: () => {
        built++;
        return new FakeBuyer();
      },
    });
    try {
      const many = Array.from({ length: 101 }, () => ({ asset: "gold", amountUsd: 1 }));
      const r1 = await h.client.callTool({ name: "analyze_portfolio", arguments: { holdings: many } });
      const r2 = await h.client.callTool({ name: "analyze_portfolio", arguments: { holdings: [{ asset: "gold", amountUsd: 1e13 }] } });
      const r3 = await h.client.callTool({ name: "analyze_portfolio", arguments: { holdings: [{ asset: "gold", amountUsd: -1 }] } });
      for (const r of [r1, r2, r3]) assert.equal(r.isError, true);
      assert.equal(built, 0);
    } finally {
      await h.close();
    }
  });
});
