import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPayingFetch, PaidMcpHttpClient } from "@cascet/client";

/**
 * Portfolio analyst MCP server — CasCet's cascading-payments flagship.
 *
 * Its `analyze_portfolio` tool is itself a PAYING CUSTOMER: it buys market
 * data from the (paid) casper-defi-data gateway using this server's own
 * Casper wallet, links those downstream payments to the inbound payment via
 * X-CASCET-PARENT-ID, and discloses its cost breakdown in the result.
 *
 * Env:
 *   DATA_GATEWAY_URL   MCP url of the paid data gateway (e.g. http://localhost:4402/mcp)
 *   CASCET_KEY_PATH    PEM key of THIS server's wallet (it spends real testnet tokens)
 *   CASCET_MAX_PER_CALL / CASCET_MAX_SESSION  optional budget (raw token units)
 */

const DATA_GATEWAY_URL = process.env.DATA_GATEWAY_URL ?? "http://localhost:4402/mcp";
const KEY_PATH = process.env.CASCET_KEY_PATH;

const server = new McpServer({ name: "portfolio-analyst", version: "0.1.0" });

const holdingSchema = z.object({
  asset: z.enum(["CSPR", "gold", "treasury"]),
  amountUsd: z.number().positive().describe("Current position size in USD"),
});

server.registerTool(
  "analyze_portfolio",
  {
    title: "Analyze portfolio (premium)",
    description:
      "Deep portfolio analysis over live market data. NOTE: this tool autonomously PURCHASES " +
      "data from other paid MCP services and reports its own cost breakdown (cascading x402 payments).",
    inputSchema: { holdings: z.array(holdingSchema).min(1) },
  },
  async ({ holdings }, extra) => {
    if (!KEY_PATH) {
      return errorResult("server misconfigured: CASCET_KEY_PATH missing — analyst has no wallet to buy data with");
    }

    // Cascade link: the gateway forwards the inbound payment id via _meta.
    const meta = (extra as { _meta?: { cascet?: { paymentId?: string } } })._meta;
    const parentId = meta?.cascet?.paymentId;

    const purchases: Array<{ tool: string; paymentId?: string }> = [];
    const paying = await createPayingFetch({
      privateKeyPath: KEY_PATH,
      budget: {
        maxPerCallRaw: process.env.CASCET_MAX_PER_CALL,
        maxSessionRaw: process.env.CASCET_MAX_SESSION,
      },
      parentId,
      onPayment: info => console.error(`[analyst] 💸 buying data: ${info.amountRaw} raw → ${info.payTo.slice(0, 10)}…`),
    });
    const dataClient = new PaidMcpHttpClient(DATA_GATEWAY_URL, paying.fetch);

    // Buy exactly the data this portfolio needs — every call settles on Casper.
    const needsCspr = holdings.some(h => h.asset === "CSPR");
    const rwaAssets = [...new Set(holdings.filter(h => h.asset !== "CSPR").map(h => h.asset))];

    const prices: Record<string, { priceUsd: number; change24hPct?: number }> = {};
    if (needsCspr) {
      const { result, paymentId } = await dataClient.callTool("get_cspr_market_data", {});
      purchases.push({ tool: "get_cspr_market_data", paymentId });
      const d = parseToolJson(result);
      prices.CSPR = { priceUsd: d.priceUsd as number, change24hPct: d.change24hPct as number };
    }
    for (const asset of rwaAssets) {
      const { result, paymentId } = await dataClient.callTool("get_rwa_price", { asset });
      purchases.push({ tool: `get_rwa_price(${asset})`, paymentId });
      const d = parseToolJson(result);
      prices[asset] = { priceUsd: d.priceUsd as number, change24hPct: d.change24hPct as number };
    }
    const { result: yieldsRaw, paymentId: yieldsPayment } = await dataClient.callTool("get_defi_yields", {});
    purchases.push({ tool: "get_defi_yields", paymentId: yieldsPayment });
    const yields = parseToolJson(yieldsRaw).yields as Array<{ venue: string; apyPct: number; risk: string }>;

    // Deterministic analysis over the purchased data.
    const totalUsd = holdings.reduce((s, h) => s + h.amountUsd, 0);
    const allocation = holdings.map(h => ({
      asset: h.asset,
      amountUsd: h.amountUsd,
      weightPct: round((h.amountUsd / totalUsd) * 100),
      change24hPct: prices[h.asset]?.change24hPct ?? null,
    }));
    const volatileWeight = allocation.filter(a => a.asset === "CSPR").reduce((s, a) => s + a.weightPct, 0);
    const riskLevel = volatileWeight > 60 ? "high" : volatileWeight > 30 ? "medium" : "low";
    const bestYield = [...yields].sort((a, b) => b.apyPct - a.apyPct)[0];
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
              marketData: prices,
              costBreakdown: {
                note: "data purchased autonomously from paid MCP services via x402 on Casper",
                totalSpentRaw: paying.spentRaw(),
                purchases,
                cascadeParent: parentId ?? null,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

function parseToolJson(result: Record<string, unknown>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  const text = content?.find(c => c.type === "text")?.text;
  if (!text) throw new Error("downstream tool returned no text content");
  return JSON.parse(text) as Record<string, unknown>;
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

await server.connect(new StdioServerTransport());
console.error("[portfolio-analyst] MCP server ready on stdio");
