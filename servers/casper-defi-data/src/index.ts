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
const CSPR_CLOUD = process.env.CSPR_CLOUD_URL ?? "https://api.testnet.cspr.cloud";

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
  async () => {
    const s = await casperStakingApy();
    if (!s.live) {
      return jsonResult({
        yields: [
          { venue: "Native staking (validator delegation)", apyPct: 11.2, risk: "low", liquid: false },
          { venue: "Liquid staking (stCSPR, ~10% commission)", apyPct: 10.1, risk: "low-medium", liquid: true },
        ],
        source: "snapshot(2026-07-07)",
        method: "APY = annual_staking_rewards_issuance × total_supply ÷ total_active_stake; liquid = native × (1 − 0.10)",
      });
    }
    const liquid = Number((s.nativeApy * 0.9).toFixed(1));
    return jsonResult({
      network: {
        totalStakedCspr: Math.round(s.totalStakedCspr),
        activeValidators: s.activeValidators,
        eraId: s.eraId,
        totalSupplyCspr: Math.round(s.totalSupply),
      },
      yields: [
        { venue: "Native staking (validator delegation)", apyPct: Number(s.nativeApy.toFixed(1)), risk: "low", liquid: false },
        { venue: "Liquid staking (stCSPR, ~10% commission)", apyPct: liquid, risk: "low-medium", liquid: true },
      ],
      source: "cspr.cloud(live): /supply + /auction-metrics",
      method: "APY = annual_staking_rewards_issuance × total_supply ÷ total_active_stake; liquid = native × (1 − 0.10)",
    });
  },
);

/**
 * Compute the real Casper native-staking APY from live cspr.cloud data:
 * annual staking-reward issuance (fraction of total supply) × total supply,
 * divided by the total CSPR currently bonded. Needs CSPR_CLOUD_TOKEN in the
 * environment (the CasCet gateway forwards it to this upstream); degrades to a
 * clearly-labeled snapshot when the token is absent or the API is unreachable.
 */
async function casperStakingApy(): Promise<
  | { live: false }
  | { live: true; nativeApy: number; totalStakedCspr: number; totalSupply: number; activeValidators: number; eraId: number }
> {
  const token = process.env.CSPR_CLOUD_TOKEN;
  if (!token) return { live: false };
  try {
    const headers = { Authorization: token };
    const opts = { headers, signal: AbortSignal.timeout(4000) } as const;
    const [supplyRes, auctionRes] = await Promise.all([
      fetch(`${CSPR_CLOUD}/supply`, opts),
      fetch(`${CSPR_CLOUD}/auction-metrics`, opts),
    ]);
    if (!supplyRes.ok || !auctionRes.ok) throw new Error("http");
    const supply = ((await supplyRes.json()) as { data: { total: number; annual_staking_rewards_issuance: number } }).data;
    const auction = ((await auctionRes.json()) as {
      data: { total_active_era_stake: string; active_validator_number: number; current_era_id: number };
    }).data;
    const totalSupply = Number(supply.total);
    const totalStakedCspr = Number(BigInt(auction.total_active_era_stake)) / 1e9;
    if (!totalSupply || !totalStakedCspr) throw new Error("empty");
    const nativeApy = (supply.annual_staking_rewards_issuance * totalSupply * 100) / totalStakedCspr;
    return {
      live: true,
      nativeApy,
      totalStakedCspr,
      totalSupply,
      activeValidators: auction.active_validator_number,
      eraId: auction.current_era_id,
    };
  } catch {
    return { live: false };
  }
}

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
