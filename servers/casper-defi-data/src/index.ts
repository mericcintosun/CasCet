import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * Casper DeFi & RWA data MCP server (upstream, runs behind a CasCet gateway).
 *
 * Live sources are used when reachable (CoinGecko public API); every tool
 * degrades to clearly-labeled snapshot data so demos never stall on rate
 * limits. Data sourcing is always disclosed in the response.
 */

const COINGECKO = "https://api.coingecko.com/api/v3";

const server = new McpServer({ name: "casper-defi-data", version: "0.1.0" });

server.registerTool(
  "get_cspr_market_data",
  {
    title: "CSPR market data",
    description: "Live CSPR price, 24h volume and change (USD).",
    inputSchema: {},
  },
  async () => {
    const data = await coingeckoSimple("casper-network", {
      usd: 0.0231,
      usd_24h_vol: 11_842_113,
      usd_24h_change: -1.42,
    });
    return jsonResult({
      asset: "CSPR",
      priceUsd: data.usd,
      volume24hUsd: data.usd_24h_vol,
      change24hPct: data.usd_24h_change,
      source: data.live ? "coingecko(live)" : "snapshot(2026-07-07)",
    });
  },
);

server.registerTool(
  "get_rwa_price",
  {
    title: "Tokenized RWA price",
    description: "Price of a tokenized real-world asset: gold (PAXG) or US treasuries (OUSG proxy).",
    inputSchema: { asset: z.enum(["gold", "treasury"]) },
  },
  async ({ asset }) => {
    const id = asset === "gold" ? "pax-gold" : "ousg";
    const fallback = asset === "gold" ? { usd: 3312.4, usd_24h_change: 0.35 } : { usd: 112.9, usd_24h_change: 0.02 };
    const data = await coingeckoSimple(id, { ...fallback, usd_24h_vol: 0 });
    return jsonResult({
      asset,
      proxyToken: id,
      priceUsd: data.usd,
      change24hPct: data.usd_24h_change,
      source: data.live ? "coingecko(live)" : "snapshot(2026-07-07)",
    });
  },
);

server.registerTool(
  "get_defi_yields",
  {
    title: "Casper DeFi yields",
    description: "Current yield opportunities on Casper: native staking, liquid staking and DEX LP estimates.",
    inputSchema: {},
  },
  async () =>
    jsonResult({
      yields: [
        { venue: "Native staking (validator delegation)", apyPct: 10.8, risk: "low", liquid: false },
        { venue: "Liquid staking (stCSPR)", apyPct: 9.9, risk: "low-medium", liquid: true },
        { venue: "CSPR.trade LP CSPR/WCSPR", apyPct: 14.2, risk: "medium", liquid: true },
      ],
      source: "curated(2026-07-07): cspr.live validator averages + CSPR.trade pool stats",
    }),
);

async function coingeckoSimple(
  id: string,
  fallback: { usd: number; usd_24h_vol?: number; usd_24h_change?: number },
): Promise<{ usd: number; usd_24h_vol?: number; usd_24h_change?: number; live: boolean }> {
  try {
    const res = await fetch(
      `${COINGECKO}/simple/price?ids=${id}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, { usd: number; usd_24h_vol?: number; usd_24h_change?: number }>;
    const row = body[id];
    if (!row?.usd) throw new Error("empty payload");
    return { ...row, live: true };
  } catch {
    return { ...fallback, live: false };
  }
}

function jsonResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

await server.connect(new StdioServerTransport());
console.error("[casper-defi-data] MCP server ready on stdio");
