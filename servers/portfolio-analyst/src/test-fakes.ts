// Test doubles shared by the *.test.ts files (not used at runtime).
import type { ToolCallOutcome } from "@cascet/client";
import type { DataBuyer } from "./analysis.js";

/** Responses shaped exactly like servers/casper-defi-data's tools. */
export const DATA: Record<string, unknown> = {
  get_cspr_market_data: {
    asset: "CSPR",
    priceUsd: 0.0231,
    volume24hUsd: 11_842_113,
    change24hPct: -1.42,
    source: "snapshot(2026-07-07)",
  },
  "get_rwa_price(gold)": { asset: "gold", proxyToken: "pax-gold", priceUsd: 3312.4, change24hPct: 0.35, source: "coingecko(live)" },
  "get_rwa_price(treasury)": {
    asset: "treasury",
    proxyToken: "ousg",
    priceUsd: 112.9,
    change24hPct: 0.02,
    source: "snapshot(2026-07-07)",
  },
  get_defi_yields: {
    yields: [
      { venue: "Native staking (validator delegation)", apyPct: 11.2, risk: "low", liquid: false },
      { venue: "Liquid staking (stCSPR, ~10% commission)", apyPct: 10.1, risk: "low-medium", liquid: true },
    ],
    source: "snapshot(2026-07-07)",
  },
};

export const PAYMENT_IDS: Record<string, string> = {
  get_cspr_market_data: "6f1c2a8e-1b2c-4d3e-8f40-0a1b2c3d4e01",
  "get_rwa_price(gold)": "6f1c2a8e-1b2c-4d3e-8f40-0a1b2c3d4e02",
  "get_rwa_price(treasury)": "6f1c2a8e-1b2c-4d3e-8f40-0a1b2c3d4e03",
  get_defi_yields: "6f1c2a8e-1b2c-4d3e-8f40-0a1b2c3d4e04",
};

export const PORTFOLIO = [
  { asset: "CSPR" as const, amountUsd: 7000 },
  { asset: "gold" as const, amountUsd: 2000 },
  { asset: "treasury" as const, amountUsd: 1000 },
];

export function inputKey(name: string, args: Record<string, unknown>): string {
  return name === "get_rwa_price" ? `get_rwa_price(${String(args.asset)})` : name;
}

export function textResult(payload: unknown): Record<string, unknown> {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }] };
}

export type Behavior = (input: string) => Promise<ToolCallOutcome>;

/** A paid data call that succeeds with the canned response of `input`. */
export const succeed: Behavior = async input => ({ result: textResult(DATA[input]), paymentId: PAYMENT_IDS[input] });

/**
 * Fake buyer: records which inputs were started and which reached the
 * "payment" step. Each input's behaviour can be overridden.
 */
export class FakeBuyer implements DataBuyer {
  readonly started: string[] = [];
  readonly paid: string[] = [];

  constructor(private readonly behaviors: Record<string, Behavior> = {}) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome> {
    const input = inputKey(name, args);
    this.started.push(input);
    const outcome = await (this.behaviors[input] ?? succeed)(input);
    this.paid.push(input);
    return outcome;
  }

  spentRaw(): string {
    return String(this.paid.length * 500_000_000);
  }
}

/**
 * Buyer that models the x402 round trip: every call first waits for its
 * unpaid probe (released by `release()`, or rejected when `signal` aborts),
 * then refuses to pay once the signal is aborted, like a paying fetch whose
 * Request carries the signal.
 */
export class GatedBuyer implements DataBuyer {
  readonly started: string[] = [];
  readonly paid: string[] = [];
  private readonly waiters: Array<() => void> = [];
  private readonly allStartedWaiters: Array<{ count: number; resolve: () => void }> = [];

  constructor(private readonly signal: AbortSignal) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome> {
    const input = inputKey(name, args);
    this.started.push(input);
    for (const w of this.allStartedWaiters) if (this.started.length >= w.count) w.resolve();
    await new Promise<void>((resolve, reject) => {
      if (this.signal.aborted) return reject(this.signal.reason);
      this.signal.addEventListener("abort", () => reject(this.signal.reason), { once: true });
      this.waiters.push(resolve);
    });
    this.signal.throwIfAborted(); // the paid retry of an aborted Request never goes out
    this.paid.push(input);
    return succeed(input);
  }

  spentRaw(): string {
    return String(this.paid.length * 500_000_000);
  }

  /** Resolves once `count` purchases have started. */
  whenStarted(count: number): Promise<void> {
    if (this.started.length >= count) return Promise.resolve();
    return new Promise(resolve => this.allStartedWaiters.push({ count, resolve }));
  }

  release(): void {
    for (const w of this.waiters.splice(0)) w();
  }
}

/**
 * Settle with `promise`, or reject after `ms`. Keeps a regression in the abort
 * wiring from hanging the test run: the test fails and its cleanup still runs.
 */
export async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Errors as they really surface from the paying fetch / MCP client, full of internals. */
export const INTERNAL_ERRORS = {
  unreachable: () =>
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.7:4402"), { code: "ECONNREFUSED" }),
    }),
  rpcError: () =>
    new Error(
      "MCP tools/call error -32603: upstream tool failed (not charged): Error: ENOENT: no such file or directory, " +
        "open '/srv/cascet/keys/data_secret_key.pem'\n    at Object.openSync (node:fs:573:3)",
    ),
  http500: () =>
    new Error(
      'MCP request tools/call failed: HTTP 500 {"error":"boom at /srv/cascet/gateway/server.js:231:17",' +
        '"url":"http://10.0.0.7:4402/mcp"}',
    ),
  budget: () =>
    new Error(
      "Failed to create payment payload: Payment creation aborted: price 7777777777 exceeds per-call budget 6666666666",
    ),
};

/** Strings that must never appear in anything the analyst returns to its caller. */
export const LEAK_MARKERS = [
  "10.0.0.7",
  "/srv/cascet",
  "ENOENT",
  "ECONNREFUSED",
  "node:fs",
  "    at ",
  "upstream tool failed",
  "server.js",
  "per-call budget",
  "7777777777",
  "-32603",
];
