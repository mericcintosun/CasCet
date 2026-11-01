import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DEFAULT_CSPR_CLOUD, casperStakingApy, coingeckoSimple, csprCloudNetwork, type FetchLike } from "./sources.js";

/** The tools take at most one argument; cap the payload before schema validation runs. */
const MAX_TOOL_INPUT_ELEMENTS = 32;

const APY_METHOD =
  "APY = annual_staking_rewards_issuance × total_supply ÷ one era's bonded stake " +
  "(cspr.cloud total_active_era_stake ÷ 2: it sums the current and the next era); liquid = native × (1 − 0.10)";

export interface DataServerOptions {
  /** Upstream fetch (tests stub it). Defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Environment to read CSPR_CLOUD_URL / CSPR_CLOUD_TOKEN from. Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  log?: (line: string) => void;
}

/**
 * Casper DeFi & RWA data MCP server (upstream, runs behind a CasCet gateway).
 *
 * Live sources are used when reachable (CoinGecko public API, cspr.cloud);
 * every tool degrades to clearly-labeled snapshot data so demos never stall on
 * rate limits. Data sourcing is always disclosed in the response.
 */
export function createDataServer(opts: DataServerOptions = {}): McpServer {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((line: string) => console.error(`[casper-defi-data] ${line}`));
  const csprCloud = env.CSPR_CLOUD_URL ?? DEFAULT_CSPR_CLOUD;

  const server = new McpServer(
    { name: "casper-defi-data", version: "0.1.0" },
    { maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS },
  );

  server.registerTool(
    "get_cspr_market_data",
    {
      title: "CSPR market data",
      description: "Live CSPR price, 24h volume and change (USD).",
      inputSchema: {},
    },
    safeTool("get_cspr_market_data", log, async () => {
      const data = await coingeckoSimple(
        "casper-network",
        { usd: 0.0231, usd_24h_vol: 11_842_113, usd_24h_change: -1.42 },
        fetchImpl,
      );
      return jsonResult({
        asset: "CSPR",
        priceUsd: data.usd,
        volume24hUsd: data.usd_24h_vol,
        change24hPct: data.usd_24h_change,
        source: data.live ? "coingecko(live)" : "snapshot(2026-07-07)",
      });
    }),
  );

  server.registerTool(
    "get_rwa_price",
    {
      title: "Tokenized RWA price",
      description: "Price of a tokenized real-world asset: gold (PAXG) or US treasuries (OUSG proxy).",
      inputSchema: { asset: z.enum(["gold", "treasury"]) },
    },
    safeTool("get_rwa_price", log, async ({ asset }: { asset: "gold" | "treasury" }) => {
      const id = asset === "gold" ? "pax-gold" : "ousg";
      const fallback = asset === "gold" ? { usd: 3312.4, usd_24h_change: 0.35 } : { usd: 112.9, usd_24h_change: 0.02 };
      const data = await coingeckoSimple(id, { ...fallback, usd_24h_vol: 0 }, fetchImpl);
      return jsonResult({
        asset,
        proxyToken: id,
        priceUsd: data.usd,
        change24hPct: data.usd_24h_change,
        source: data.live ? "coingecko(live)" : "snapshot(2026-07-07)",
      });
    }),
  );

  server.registerTool(
    "get_defi_yields",
    {
      title: "Casper DeFi yields",
      description: "Current yield opportunities on Casper: native staking, liquid staking and DEX LP estimates.",
      inputSchema: {},
    },
    safeTool("get_defi_yields", log, async () => {
      // The token is read per call: the CasCet gateway forwards it to this upstream.
      const s = await casperStakingApy({ baseUrl: csprCloud, token: env.CSPR_CLOUD_TOKEN, fetchImpl });
      if (!s.live) {
        return jsonResult({
          yields: [
            { venue: "Native staking (validator delegation)", apyPct: 11.2, risk: "low", liquid: false },
            { venue: "Liquid staking (stCSPR, ~10% commission)", apyPct: 10.1, risk: "low-medium", liquid: true },
          ],
          source: "snapshot(2026-07-07)",
          method: APY_METHOD,
        });
      }
      const network = csprCloudNetwork(csprCloud);
      const liquid = Number((s.nativeApy * 0.9).toFixed(1));
      return jsonResult({
        network: {
          name: network,
          totalStakedCspr: Math.round(s.totalStakedCspr),
          activeValidators: s.activeValidators,
          eraId: s.eraId,
          totalSupplyCspr: Math.round(s.totalSupply),
        },
        yields: [
          { venue: "Native staking (validator delegation)", apyPct: Number(s.nativeApy.toFixed(1)), risk: "low", liquid: false },
          { venue: "Liquid staking (stCSPR, ~10% commission)", apyPct: liquid, risk: "low-medium", liquid: true },
        ],
        source: `cspr.cloud(live, ${network}): /supply + /auction-metrics`,
        method: APY_METHOD,
      });
    }),
  );

  return server;
}

/**
 * Wrap a tool handler so an unexpected exception becomes a generic tool error.
 * Without it the MCP SDK would return the raw exception message (paths, URLs,
 * upstream text) to the buyer; the details go to the operator log instead.
 */
export function safeTool<A extends unknown[]>(
  name: string,
  log: (line: string) => void,
  handler: (...args: A) => Promise<CallToolResult>,
): (...args: A) => Promise<CallToolResult> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (err) {
      const ref = randomUUID().slice(0, 8);
      log(`${name} failed (ref ${ref}): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return { isError: true, content: [{ type: "text", text: `${name} failed: internal error (ref ${ref})` }] };
    }
  };
}

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}
