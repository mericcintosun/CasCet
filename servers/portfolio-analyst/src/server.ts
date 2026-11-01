import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { analyzeInputShape, analyzePortfolio, planPurchases, type DataBuyer } from "./analysis.js";
import { createDataBuyer, type BuyerContext } from "./buyer.js";
import type { AnalystConfig, ConfigResult } from "./config.js";
import { errorResult, internalErrorResult, isPaymentId } from "./sanitize.js";
import { SpendLedger, analysisBudget } from "./spend-ledger.js";

/** Caps the size of one tools/call `arguments` payload before schema validation runs. */
const MAX_TOOL_INPUT_ELEMENTS = 1_000;

const MISCONFIGURED =
  "analysis unavailable: this analyst is not configured to buy market data (operator: see the server log)";
const LIMIT_REACHED = "analysis unavailable: the analyst has reached its spending limit";
const LIMIT_BUSY = "analysis unavailable: the analyst is at its spending limit until running analyses finish; retry shortly";

export interface AnalystServerOptions {
  /** Result of loadAnalystConfig; an invalid config makes every analysis fail closed. */
  config: ConfigResult;
  /** Builds the per-call data buyer. Defaults to the analyst's real wallet (createDataBuyer). */
  createBuyer?: (cfg: AnalystConfig, ctx: BuyerContext) => Promise<DataBuyer>;
  log?: (line: string) => void;
}

/**
 * The analyst MCP server. Run one per process: its spend ledger enforces
 * CASCET_MAX_TOTAL across every analysis this server runs.
 */
export function createAnalystServer(opts: AnalystServerOptions): McpServer {
  const log = opts.log ?? ((line: string) => console.error(`[analyst] ${line}`));
  const createBuyer = opts.createBuyer ?? createDataBuyer;
  const maxTotal = opts.config.ok ? opts.config.config.maxTotalRaw : undefined;
  const ledger = new SpendLedger(maxTotal === undefined ? undefined : BigInt(maxTotal));
  const server = new McpServer(
    { name: "portfolio-analyst", version: "0.1.0" },
    { maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS },
  );

  server.registerTool(
    "analyze_portfolio",
    {
      title: "Analyze portfolio (premium)",
      description:
        "Deep portfolio analysis over live market data. NOTE: this tool autonomously PURCHASES " +
        "data from other paid MCP services and reports its own cost breakdown (cascading x402 payments). " +
        "If some data cannot be bought, the analysis is partial and lists the missing inputs.",
      inputSchema: analyzeInputShape,
    },
    async ({ holdings }, extra) => {
      if (!opts.config.ok) {
        log("analyze_portfolio refused: the configuration is invalid (see the startup log)");
        return errorResult(MISCONFIGURED);
      }
      const cfg = opts.config.config;

      // Reserve this analysis' worst case against CASCET_MAX_TOTAL before buying anything (L03).
      const budget = analysisBudget(cfg, planPurchases(holdings).length);
      const admission = ledger.admit(budget.worstCaseRaw);
      if (!admission.ok) {
        log(
          `analyze_portfolio refused: CASCET_MAX_TOTAL (${ledger.limitRaw} raw) leaves no room for this analysis ` +
            `(needs up to ${budget.worstCaseRaw ?? "an unbounded amount"}; authorized ${ledger.committedRaw}, ` +
            `reserved by running analyses ${ledger.reservedRaw})`,
        );
        return errorResult(admission.reason === "busy" ? LIMIT_BUSY : LIMIT_REACHED);
      }
      const { reservation } = admission;

      const parentId = cascadeParentOf(extra._meta, log);
      // Purchases stop when the caller cancels (extra.signal: MCP cancellation,
      // gateway timeout, closed transport) or when the purchase deadline passes.
      const signal = AbortSignal.any([extra.signal, AbortSignal.timeout(cfg.timeoutMs)]);
      let buyer: DataBuyer | undefined;
      try {
        buyer = await createBuyer(cfg, {
          parentId,
          signal,
          log,
          ...(budget.perAssetRaw === undefined ? {} : { maxSessionRaw: budget.perAssetRaw.toString() }),
        });
        return await analyzePortfolio(holdings, { buyer, signal, cancelled: extra.signal, parentId, log });
      } catch (err) {
        // Never let the MCP SDK turn a raw error message into the tool result.
        return internalErrorResult(err, log);
      } finally {
        // Every purchase has settled by now (analyzePortfolio waits for all of them).
        const spent = authorizedBy(buyer, reservation.amountRaw, log);
        reservation.settle(spent);
        if (spent > 0n || ledger.limitRaw !== undefined) {
          log(
            `analysis authorized ${spent} raw; analyst total ${ledger.committedRaw}` +
              `${ledger.limitRaw === undefined ? "" : ` of ${ledger.limitRaw}`} raw`,
          );
        }
      }
    },
  );

  return server;
}

/**
 * What one analysis authorized, for the ledger. Anything unreadable counts as
 * the whole reservation, so a broken count can only make the ledger stricter.
 */
function authorizedBy(buyer: DataBuyer | undefined, reservedRaw: bigint, log: (line: string) => void): bigint {
  if (!buyer) return 0n;
  let raw: unknown;
  try {
    raw = buyer.spentRaw();
  } catch {
    raw = undefined;
  }
  if (typeof raw !== "string" || !/^\d{1,40}$/.test(raw)) {
    log("could not read what the analysis authorized; counting its whole reservation against CASCET_MAX_TOTAL");
    return reservedRaw;
  }
  const spent = BigInt(raw);
  if (spent > reservedRaw && reservedRaw > 0n) {
    log(`warning: the analysis authorized ${spent} raw, more than the ${reservedRaw} raw it reserved`);
  }
  return spent;
}

/**
 * Cascade link: the CasCet gateway forwards the inbound payment id in
 * `_meta.cascet.paymentId`. Only a well-formed payment id is accepted, so a
 * caller that reaches the analyst directly cannot push arbitrary text into
 * X-CASCET-PARENT-ID and the downstream receipts.
 */
export function cascadeParentOf(meta: unknown, log: (line: string) => void): string | undefined {
  const cascet = typeof meta === "object" && meta !== null ? (meta as { cascet?: unknown }).cascet : undefined;
  const id = typeof cascet === "object" && cascet !== null ? (cascet as { paymentId?: unknown }).paymentId : undefined;
  if (id === undefined) return undefined;
  if (isPaymentId(id)) return id;
  log("ignoring a malformed cascade parent id in _meta.cascet.paymentId");
  return undefined;
}
