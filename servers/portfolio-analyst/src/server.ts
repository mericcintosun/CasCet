import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { analyzeInputShape, analyzePortfolio, type DataBuyer } from "./analysis.js";
import { createDataBuyer, type BuyerContext } from "./buyer.js";
import type { AnalystConfig, ConfigResult } from "./config.js";
import { errorResult, internalErrorResult, isPaymentId } from "./sanitize.js";

/** Caps the size of one tools/call `arguments` payload before schema validation runs. */
const MAX_TOOL_INPUT_ELEMENTS = 1_000;

const MISCONFIGURED =
  "analysis unavailable: this analyst is not configured to buy market data (operator: see the server log)";

export interface AnalystServerOptions {
  /** Result of loadAnalystConfig; an invalid config makes every analysis fail closed. */
  config: ConfigResult;
  /** Builds the per-call data buyer. Defaults to the analyst's real wallet (createDataBuyer). */
  createBuyer?: (cfg: AnalystConfig, ctx: BuyerContext) => Promise<DataBuyer>;
  log?: (line: string) => void;
}

export function createAnalystServer(opts: AnalystServerOptions): McpServer {
  const log = opts.log ?? ((line: string) => console.error(`[analyst] ${line}`));
  const createBuyer = opts.createBuyer ?? createDataBuyer;
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
      const parentId = cascadeParentOf(extra._meta, log);
      // Purchases stop when the caller cancels (extra.signal: MCP cancellation,
      // gateway timeout, closed transport) or when the purchase deadline passes.
      const signal = AbortSignal.any([extra.signal, AbortSignal.timeout(cfg.timeoutMs)]);
      try {
        const buyer = await createBuyer(cfg, { parentId, signal, log });
        return await analyzePortfolio(holdings, { buyer, signal, cancelled: extra.signal, parentId, log });
      } catch (err) {
        // Never let the MCP SDK turn a raw error message into the tool result.
        return internalErrorResult(err, log);
      }
    },
  );

  return server;
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
