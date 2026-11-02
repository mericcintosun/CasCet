import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cascetConfigSchema, type CascetConfig } from "@cascet/core";
import { longestPaidCallMs, type AnchoringHealth } from "@cascet/gateway";
import type { PaidMcpHttpClientOptions, PayingFetchOptions } from "@cascet/client";
import {
  PAID_CALL_MARGIN_MS,
  paidCallTimeoutMs,
  runMainnetDemoCall,
  runReceipt,
  type DemoMcpClient,
  type DemoReceipt,
  type MainnetDemoDeps,
} from "./demo-paid-call.js";
import { NETWORKS } from "./facilitator-env.js";
import { FakeClock } from "./test-helpers.js";

const MAINNET = NETWORKS["casper:casper"];
const TOOL = "get_cspr_market_data";
const SELLER = MAINNET.deployerAccount;
const TOKEN = `hash-${MAINNET.token}`;
const SETTLE_TX = "2c66141c".padEnd(64, "b");
const ANCHOR_TX = "70e4c416".padEnd(64, "a");

/** The gateway config demo-real-mainnet builds (run-real-mainnet.ts), with or without a recorder. */
function mainnetConfig(anchoring: boolean): CascetConfig {
  return cascetConfigSchema.parse({
    name: "casper-defi-data",
    upstream: { type: "stdio", command: "node", args: ["servers/casper-defi-data/dist/index.js"] },
    network: "casper:casper",
    payTo: SELLER,
    asset: { packageHash: TOKEN, name: "CasCet X402 Token", symbol: "WCSPR", decimals: 9, version: "1", tokensPerUsd: 50 },
    facilitator: { url: "http://127.0.0.1:4501", apiKey: "t".repeat(64) },
    ...(anchoring
      ? {
          anchoring: {
            contractPackageHash: MAINNET.receiptRegistry,
            keyPath: "/keys/recorder.pem",
            keyAlgo: "ed25519",
            nodeUrl: MAINNET.rpcUrl,
            chainName: "casper",
          },
        }
      : {}),
    pricing: { tools: { [TOOL]: { price: "$0.01" } } },
    port: 4402,
  });
}

const idle: AnchoringHealth = { state: "closed", consecutiveFailures: 0, queued: 0, inFlight: 0, anchored: 0, failed: 0, skipped: 0 };

interface Harness {
  deps: MainnetDemoDeps;
  /** Everything that happened, in order: closes, payments, log lines. */
  events: string[];
  logs: string[];
  errors: string[];
  payingOptions: PayingFetchOptions[];
  clientOptions: PaidMcpHttpClientOptions[];
  clock: FakeClock;
}

/**
 * Fakes around runMainnetDemoCall: `receiptsAfter` is what GET /receipts lists
 * once the call returned (before it, `before`); `anchoring` scripts the
 * anchorer's health per read (the last entry repeats).
 */
function harness(opts: {
  callTool?: DemoMcpClient["callTool"];
  initialize?: () => Promise<void>;
  before?: DemoReceipt[];
  receiptsAfter?: (nowMs: number) => DemoReceipt[];
  anchoring?: Array<AnchoringHealth | { state: "disabled" }>;
  startGateway?: () => Promise<never>;
}): Harness {
  const events: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const payingOptions: PayingFetchOptions[] = [];
  const clientOptions: PaidMcpHttpClientOptions[] = [];
  const clock = new FakeClock(0);
  let called = false;
  let reads = 0;
  const anchoring = opts.anchoring ?? [{ state: "disabled" }];
  const deps: MainnetDemoDeps = {
    startGateway:
      opts.startGateway ??
      (async () => ({
        health: () => ({ anchoring: anchoring[Math.min(reads++, anchoring.length - 1)]! }),
        close: async () => {
          events.push(`gateway closed at ${clock.ms}`);
        },
      })),
    createPayingFetch: async options => {
      payingOptions.push(options);
      return { fetch: async () => new Response("unused") };
    },
    newClient: (url, _fetch, options) => {
      assert.equal(url, "http://localhost:4402/mcp");
      clientOptions.push(options);
      return {
        initialize: opts.initialize ?? (async () => {}),
        callTool: async (name, args) => {
          called = true;
          if (opts.callTool) return opts.callTool(name, args);
          return { result: { content: [{ type: "text", text: "CSPR $0.01" }] }, paymentId: "p-new" };
        },
      };
    },
    listReceipts: async base => {
      assert.equal(base, "http://localhost:4402");
      return called ? (opts.receiptsAfter?.(clock.ms) ?? []) : (opts.before ?? []);
    },
    facilitator: {
      close: async () => {
        events.push(`facilitator closed at ${clock.ms}`);
      },
    },
    anchorWait: {
      now: clock.now,
      sleep: async ms => {
        clock.advance(ms);
      },
    },
    log: line => logs.push(line),
    warn: line => errors.push(line),
    error: line => errors.push(line),
  };
  return { deps, events, logs, errors, payingOptions, clientOptions, clock };
}

const call = (config: CascetConfig) => ({
  config,
  buyerKeyPath: "/keys/agent.pem",
  seller: SELLER,
  asset: TOKEN,
  tool: TOOL,
  explorer: MAINNET.explorer,
});

const settledReceipt = (extra: Partial<DemoReceipt> = {}): DemoReceipt => ({ id: "p-new", tool: TOOL, status: "settled", txHash: SETTLE_TX, ...extra });

describe("demo-real-mainnet: the buyer's deadline", () => {
  test("outlasts the gateway's longest paid call, with and without anchoring (the client default is 30 s)", () => {
    const anchored = mainnetConfig(true);
    const plain = mainnetConfig(false);
    assert.equal(longestPaidCallMs(anchored, true), 180_000, "anchoring.nodeUrl turns the settlement check on");
    assert.equal(longestPaidCallMs(plain, false), 165_000);
    assert.equal(paidCallTimeoutMs(anchored), 180_000 + PAID_CALL_MARGIN_MS);
    assert.equal(paidCallTimeoutMs(plain), 165_000 + PAID_CALL_MARGIN_MS);
  });

  test("reaches both the paying fetch and the MCP client", async () => {
    for (const anchoring of [true, false]) {
      const config = mainnetConfig(anchoring);
      const h = harness({ receiptsAfter: () => [settledReceipt()] });
      assert.equal(await runMainnetDemoCall(call(config), h.deps), 0);
      assert.equal(h.payingOptions.length, 1);
      assert.equal(h.payingOptions[0]!.timeoutMs, paidCallTimeoutMs(config));
      assert.deepEqual(h.clientOptions, [{ timeoutMs: paidCallTimeoutMs(config) }]);
      // The payment policy of the original demo: mainnet only when listed, this seller and this token only.
      assert.deepEqual(
        [h.payingOptions[0]!.privateKeyPath, h.payingOptions[0]!.networks, h.payingOptions[0]!.allowedPayTo, h.payingOptions[0]!.allowedAssets],
        ["/keys/agent.pem", ["casper:casper"], [SELLER], [TOKEN]],
      );
    }
  });
});

describe("demo-real-mainnet: what a run reports, and that it always shuts down", () => {
  test("a settled call prints its transaction, then closes the gateway and then the facilitator", async () => {
    const h = harness({ receiptsAfter: () => [settledReceipt()] });
    assert.equal(await runMainnetDemoCall(call(mainnetConfig(false)), h.deps), 0);
    assert.ok(h.logs.includes(`settlement tx: ${SETTLE_TX}`));
    assert.ok(h.logs.includes(`  https://cspr.live/transaction/${SETTLE_TX}`));
    assert.ok(h.logs.some(l => l.includes("REAL x402 settlement succeeded on Casper MAINNET")));
    assert.deepEqual(h.events, ["gateway closed at 0", "facilitator closed at 0"]);
  });

  test("a failed call still names this run's transaction (never an earlier run's) and shuts down gracefully", async () => {
    const old: DemoReceipt = { id: "p-old", tool: TOOL, status: "settled", txHash: "0d".repeat(32) };
    const h = harness({
      callTool: async () => {
        throw new Error("MCP tools/call timed out after 195000 ms");
      },
      before: [old],
      receiptsAfter: () => [old, { id: "p-new", tool: TOOL, status: "unknown", txHash: SETTLE_TX, note: "settlement outcome unknown" }],
    });
    assert.equal(await runMainnetDemoCall(call(mainnetConfig(true)), h.deps), 1);
    assert.ok(h.errors.some(l => l.includes("the paid call failed: MCP tools/call timed out after 195000 ms")));
    assert.ok(h.logs.includes(`settlement tx: ${SETTLE_TX}`), "the hash to reconcile, not a crash");
    assert.ok(h.logs.includes(`  https://cspr.live/transaction/${SETTLE_TX}`));
    assert.ok(h.errors.includes("receipt status: unknown (settlement outcome unknown)"));
    assert.ok(!h.logs.some(l => l.includes("0d0d0d")), "an earlier run's receipt is never reported");
    assert.deepEqual(h.events, ["gateway closed at 0", "facilitator closed at 0"]);
  });

  test("receipts it cannot read after the call: says where the transaction is recorded, and shuts down gracefully", async () => {
    const h = harness({
      receiptsAfter: () => {
        throw new Error("GET /receipts answered 503");
      },
    });
    assert.equal(await runMainnetDemoCall(call(mainnetConfig(false)), h.deps), 1);
    const report = h.errors.find(l => l.includes("could not read the gateway's receipts"));
    assert.match(String(report), /GET \/receipts answered 503/);
    assert.match(String(report), /receipts\.jsonl/);
    assert.deepEqual(h.events, ["gateway closed at 0", "facilitator closed at 0"]);
  });

  test("a settled payment whose anchor cannot be read is still a success: a re-run would pay again", async () => {
    let reads = 0;
    const h = harness({
      anchoring: [{ ...idle, inFlight: 1 }],
      receiptsAfter: () => {
        if (++reads > 1) throw new Error("connection refused");
        return [settledReceipt()];
      },
    });
    assert.equal(await runMainnetDemoCall(call(mainnetConfig(true)), h.deps), 0);
    assert.ok(h.errors.some(l => l.includes("could not read the receipt's anchor: connection refused")));
    assert.ok(h.logs.some(l => l.includes("REAL x402 settlement succeeded on Casper MAINNET")));
  });

  test("an error anywhere still closes what was started", async () => {
    const h = harness({
      initialize: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:4402");
      },
    });
    await assert.rejects(runMainnetDemoCall(call(mainnetConfig(false)), h.deps), /ECONNREFUSED/);
    assert.deepEqual(h.events, ["gateway closed at 0", "facilitator closed at 0"]);

    const noGateway = harness({
      startGateway: async () => {
        throw new Error("EADDRINUSE: port 4402");
      },
    });
    await assert.rejects(runMainnetDemoCall(call(mainnetConfig(false)), noGateway.deps), /EADDRINUSE/);
    assert.deepEqual(noGateway.events, ["facilitator closed at 0"]);
  });
});

describe("demo-real-mainnet: the receipt's anchor", () => {
  test("waits for the anchor instead of a fixed 14 s, reports it, and only then shuts down", async () => {
    // The anchor executes 20 s after the call: the old fixed 14 s sleep closed the gateway before it was recorded.
    const busy: AnchoringHealth = { ...idle, inFlight: 1 };
    const h = harness({
      anchoring: [busy],
      receiptsAfter: nowMs => [settledReceipt(nowMs >= 20_000 ? { anchoredTxHash: ANCHOR_TX } : {})],
    });
    assert.equal(await runMainnetDemoCall(call(mainnetConfig(true)), h.deps), 0);
    assert.ok(h.logs.includes(`anchor tx: ${ANCHOR_TX}\n  https://cspr.live/transaction/${ANCHOR_TX}`));
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.events, ["gateway closed at 20000", "facilitator closed at 20000"]);
  });

  test("an anchor that did not execute is reported, with its hash", async () => {
    const lastError = `anchor ${ANCHOR_TX} failed on-chain: User error: 1 (Unauthorized)`;
    const h = harness({ anchoring: [{ ...idle, failed: 1, consecutiveFailures: 1, lastError }], receiptsAfter: () => [settledReceipt()] });
    assert.equal(await runMainnetDemoCall(call(mainnetConfig(true)), h.deps), 0, "the settlement itself succeeded");
    assert.ok(h.logs.includes(`anchor tx: ${ANCHOR_TX}\n  https://cspr.live/transaction/${ANCHOR_TX}`));
    assert.ok(h.errors.includes(`[demo] the anchor did not execute: ${lastError}`));
  });

  test("still anchoring at the deadline: says so instead of reporting a silent success", async () => {
    const h = harness({ anchoring: [{ ...idle, inFlight: 1 }], receiptsAfter: () => [settledReceipt()] });
    assert.equal(await runMainnetDemoCall(call(mainnetConfig(true)), h.deps), 0);
    assert.ok(h.errors.includes("[demo] still anchoring after 150 s"));
    assert.deepEqual(h.events, ["gateway closed at 150000", "facilitator closed at 150000"]);
  });

  test("without a recorder there is nothing to wait for", async () => {
    const h = harness({ receiptsAfter: () => [settledReceipt()] });
    assert.equal(await runMainnetDemoCall(call(mainnetConfig(false)), h.deps), 0);
    assert.ok(!h.logs.some(l => l.includes("anchor")));
    assert.deepEqual(h.errors, []);
    assert.equal(h.clock.ms, 0);
  });
});

describe("demo runs: this run's receipt", () => {
  const receipts: DemoReceipt[] = [
    { id: "a", tool: TOOL, status: "settled" },
    { id: "b", tool: "other", status: "settled" },
    { id: "c", tool: TOOL, status: "failed" },
    { id: "d", tool: TOOL, status: "unknown" },
  ];

  test("the paid call's own receipt, by payment id", () => {
    assert.equal(runReceipt(receipts, { paymentId: "c", tool: TOOL, earlier: new Set() })?.id, "c");
    assert.equal(runReceipt(receipts, { paymentId: "zz", tool: TOOL, earlier: new Set() }), undefined);
  });

  test("without one: the newest receipt for the tool that was not there before the call (L12)", () => {
    assert.equal(runReceipt(receipts, { tool: TOOL, earlier: new Set(["a"]) })?.id, "d");
    assert.equal(runReceipt(receipts, { tool: TOOL, earlier: new Set(["a", "c", "d"]) }), undefined);
    assert.equal(runReceipt(receipts, { tool: "other", earlier: new Set() })?.id, "b");
  });
});
