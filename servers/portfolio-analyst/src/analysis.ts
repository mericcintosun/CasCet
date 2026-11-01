import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolCallOutcome } from "@cascet/client";
import {
  PurchaseFailure,
  REASONS,
  classifyPurchaseError,
  cleanProviderText,
  describeError,
  errorResult,
  isPaymentId,
} from "./sanitize.js";

export const ASSETS = ["CSPR", "gold", "treasury"] as const;
export type Asset = (typeof ASSETS)[number];

export const MAX_HOLDINGS = 100;
export const MAX_POSITION_USD = 1e12;

export const holdingSchema = z.object({
  asset: z.enum(ASSETS),
  amountUsd: z.number().positive().max(MAX_POSITION_USD).describe("Current position size in USD"),
});
export type Holding = z.infer<typeof holdingSchema>;

/** Input shape of analyze_portfolio (bounded so one call cannot ask for unbounded work). */
export const analyzeInputShape = {
  holdings: z.array(holdingSchema).min(1).max(MAX_HOLDINGS),
};

/** The analyst's paid data client: PaidMcpHttpClient over a paying fetch in production. */
export interface DataBuyer {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
  /** Raw token units authorized so far by this analysis (all assets). */
  spentRaw(): string;
}

export interface AnalyzeContext {
  buyer: DataBuyer;
  /** Aborts every purchase: the inbound request's signal combined with the purchase deadline. */
  signal: AbortSignal;
  /** The inbound request's own signal, to tell a cancellation from the deadline. */
  cancelled: AbortSignal;
  /** Payment id of the inbound call (the cascade parent), when there is one. */
  parentId?: string;
  log: (line: string) => void;
}

export interface PlanItem {
  /** Name of the bought input as reported in costBreakdown ("get_rwa_price(gold)"). */
  input: string;
  tool: "get_cspr_market_data" | "get_rwa_price" | "get_defi_yields";
  args: Record<string, unknown>;
  /** The asset whose price this purchase returns; absent for the yields purchase. */
  asset?: Asset;
}

/** Buy exactly the data this portfolio needs, in a stable order. */
export function planPurchases(holdings: readonly Holding[]): PlanItem[] {
  const held = [...new Set(holdings.map(h => h.asset))];
  const plan: PlanItem[] = [];
  if (held.includes("CSPR")) {
    plan.push({ input: "get_cspr_market_data", tool: "get_cspr_market_data", args: {}, asset: "CSPR" });
  }
  for (const asset of held) {
    if (asset === "CSPR") continue;
    plan.push({ input: `get_rwa_price(${asset})`, tool: "get_rwa_price", args: { asset }, asset });
  }
  // Staking yields only inform a recommendation about CSPR the portfolio holds.
  if (held.includes("CSPR")) {
    plan.push({ input: "get_defi_yields", tool: "get_defi_yields", args: {} });
  }
  return plan;
}

interface MarketQuote {
  priceUsd: number;
  change24hPct: number | null;
  source: string;
}

interface YieldOption {
  venue: string;
  apyPct: number;
  risk: string;
}

type Parsed = { kind: "price"; asset: Asset; quote: MarketQuote } | { kind: "yields"; yields: YieldOption[]; source: string };

interface Purchased {
  item: PlanItem;
  paymentId?: string;
  data: Parsed;
}

// Downstream payloads are validated, never cast: a hostile or broken data
// provider must not be able to inject NaN, huge strings or wrong types.
const MAX_TOOL_TEXT = 64 * 1024;
const providerText = (max: number) => z.string().transform(s => cleanProviderText(s, max));
const priceSchema = z.object({
  priceUsd: z.number().positive(),
  change24hPct: z.number().nullish(),
  source: providerText(80).optional(),
});
const yieldsSchema = z.object({
  yields: z
    .array(
      z.object({
        venue: providerText(80).pipe(z.string().min(1)),
        apyPct: z.number().min(0).max(1000),
        risk: providerText(24).pipe(z.string().min(1)),
      }),
    )
    .max(20),
  source: providerText(80).optional(),
});

/** The JSON a downstream tool returned; refuses tool errors instead of parsing their text. */
function readToolJson(result: unknown): unknown {
  if (typeof result !== "object" || result === null) throw new PurchaseFailure(REASONS.malformed);
  const r = result as { isError?: unknown; content?: unknown };
  if (r.isError === true) throw new PurchaseFailure(REASONS.providerError);
  const content = Array.isArray(r.content) ? (r.content as unknown[]) : [];
  const text = content
    .map(c => (typeof c === "object" && c !== null ? (c as { type?: unknown; text?: unknown }) : {}))
    .find(c => c.type === "text" && typeof c.text === "string")?.text as string | undefined;
  if (text === undefined || text.length > MAX_TOOL_TEXT) throw new PurchaseFailure(REASONS.malformed);
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new PurchaseFailure(REASONS.malformed, { cause: err });
  }
}

function parseItem(item: PlanItem, result: unknown): Parsed {
  const json = readToolJson(result);
  if (item.asset) {
    const p = priceSchema.safeParse(json);
    if (!p.success) throw new PurchaseFailure(REASONS.malformed, { cause: p.error });
    return {
      kind: "price",
      asset: item.asset,
      quote: { priceUsd: p.data.priceUsd, change24hPct: p.data.change24hPct ?? null, source: p.data.source || "unspecified" },
    };
  }
  const y = yieldsSchema.safeParse(json);
  if (!y.success) throw new PurchaseFailure(REASONS.malformed, { cause: y.error });
  return { kind: "yields", yields: y.data.yields, source: y.data.source || "unspecified" };
}

/**
 * Buy one input. Never starts once the request is aborted; any failure is
 * classified right away (so a later abort cannot relabel it) and rethrown as a
 * PurchaseFailure that carries only a caller-safe reason.
 */
async function buyOne(item: PlanItem, ctx: AnalyzeContext): Promise<Purchased> {
  let paymentId: string | undefined;
  try {
    ctx.signal.throwIfAborted();
    const outcome = await ctx.buyer.callTool(item.tool, item.args);
    paymentId = isPaymentId(outcome.paymentId) ? outcome.paymentId : undefined;
    return { item, paymentId, data: parseItem(item, outcome.result) };
  } catch (err) {
    const reason = classifyPurchaseError(err, ctx);
    ctx.log(`purchase ${item.input} failed (${reason}): ${describeError(err)}`);
    throw new PurchaseFailure(reason, { cause: err, paymentId });
  }
}

/**
 * Buy the market data a portfolio needs and analyze it.
 *
 * Purchases run in parallel and are collected with Promise.allSettled: one
 * failed input no longer throws away the inputs already bought. The result is
 * a partial analysis (`partial: true`) that lists every failed input in
 * `costBreakdown.failed`. Only when no input could be bought at all is the
 * result an error (in its default execute-then-settle flow a CasCet gateway
 * then does not charge the inbound call).
 *
 * Settlement is per hop: each purchase settles on its own and is not rolled
 * back if this analysis later fails, times out or is cancelled. A purchase
 * that failed after its paid request was sent may still have been charged.
 */
export async function analyzePortfolio(holdings: readonly Holding[], ctx: AnalyzeContext): Promise<CallToolResult> {
  if (ctx.signal.aborted) {
    const why = ctx.cancelled.aborted ? "cancelled" : "timed out";
    return errorResult(`analysis ${why} before any data was bought`);
  }

  const plan = planPurchases(holdings);
  const settled = await Promise.allSettled(plan.map(item => buyOne(item, ctx)));

  if (ctx.cancelled.aborted) {
    // The caller is gone (the MCP SDK drops this response); just stop.
    const bought = settled.filter(s => s.status === "fulfilled").length;
    ctx.log(`analysis cancelled by the caller after ${bought}/${plan.length} purchases (authorized ${ctx.buyer.spentRaw()} raw)`);
    return errorResult("analysis cancelled");
  }

  const purchases: Array<{ tool: string; paymentId?: string; source: string }> = [];
  const failed: Array<{ input: string; reason: string }> = [];
  const marketData: Partial<Record<Asset, MarketQuote>> = {};
  let yields: YieldOption[] | undefined;

  settled.forEach((s, i) => {
    const item = plan[i];
    if (!item) return;
    if (s.status === "fulfilled") {
      const { data, paymentId } = s.value;
      if (data.kind === "price") marketData[data.asset] = data.quote;
      else yields = data.yields;
      purchases.push({ tool: item.input, paymentId, source: data.kind === "price" ? data.quote.source : data.source });
      return;
    }
    const failure = s.reason instanceof PurchaseFailure ? s.reason : undefined;
    // Paid, but the data was unusable: the payment still belongs in the cost breakdown.
    if (failure?.paymentId) purchases.push({ tool: item.input, paymentId: failure.paymentId, source: "unusable" });
    failed.push({ input: item.input, reason: failure?.reason ?? REASONS.failed });
  });

  const delivered = settled.filter(s => s.status === "fulfilled").length;
  if (delivered === 0) {
    const why = failed.map(f => `${f.input}: ${f.reason}`).join("; ");
    return errorResult(`analysis unavailable: no market data could be bought (${why})`);
  }

  // Deterministic analysis over the purchased data.
  const totalUsd = holdings.reduce((s, h) => s + h.amountUsd, 0);
  const allocation = holdings.map(h => ({
    asset: h.asset,
    amountUsd: h.amountUsd,
    weightPct: round((h.amountUsd / totalUsd) * 100),
    change24hPct: marketData[h.asset]?.change24hPct ?? null,
  }));
  const volatileWeight = allocation.filter(a => a.asset === "CSPR").reduce((s, a) => s + a.weightPct, 0);
  const riskLevel = volatileWeight > 60 ? "high" : volatileWeight > 30 ? "medium" : "low";
  const bestYield = [...(yields ?? [])].sort((a, b) => b.apyPct - a.apyPct)[0];
  const recommendations = [
    volatileWeight > 60
      ? `CSPR is ${round(volatileWeight)}% of the book — consider shifting toward tokenized treasuries to cut drawdown risk.`
      : `Volatile-asset exposure (${round(volatileWeight)}%) is reasonable for a growth mandate.`,
    bestYield ? `Idle CSPR could earn ~${bestYield.apyPct}% APY via ${bestYield.venue} (${bestYield.risk} risk).` : null,
  ].filter(Boolean);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            totalUsd,
            allocation,
            riskLevel,
            recommendations,
            marketData,
            partial: failed.length > 0,
            costBreakdown: {
              note:
                "data purchased autonomously from paid MCP services via x402 on Casper; " +
                "each purchase settles on its own (per hop, not atomic with this call)",
              totalSpentRaw: ctx.buyer.spentRaw(),
              purchases,
              failed,
              cascadeParent: ctx.parentId ?? null,
            },
          },
          null,
          2,
        ),
      },
    ],
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
