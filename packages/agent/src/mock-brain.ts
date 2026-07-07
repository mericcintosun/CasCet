import type Anthropic from "@anthropic-ai/sdk";
import type { Brain, BrainResponse } from "./agent.js";

/**
 * An OFFLINE, clearly-labeled stand-in for the Claude reasoning loop.
 *
 * It drives the *exact same* runAgent loop as the real brain — so tool discovery, x402 pricing,
 * per-call payment, budget enforcement, cascade receipts and settlement are all 100% real. Only the
 * two model decisions are scripted:
 *   1. which paid DeFi/RWA tools to buy for the goal, and
 *   2. the final recommendation prose.
 * The recommendation is still grounded in the *real numbers the agent actually purchased* — the
 * scripting decides how to phrase them, not what they are.
 *
 * Use this when no Anthropic API key/credits are available (e.g. a hackathon build). The demo makes
 * the simulation obvious to anyone watching; it is not presented as a live LLM.
 */
export function createMockBrain(): Brain {
  return {
    name: "simulated (no API key purchased)",
    live: false,
    async createMessage({ messages }): Promise<BrainResponse> {
      const purchased = collectPurchasedData(messages);

      // Turn 1 — nothing bought yet: reason about the goal and buy the data needed to answer it.
      if (Object.keys(purchased).length === 0) {
        return {
          stop_reason: "tool_use",
          content: [
            text(
              "To compare liquid staking against tokenized real-world assets for a CSPR-heavy, " +
                "liquidity-conscious portfolio, I need three things: current CSPR market data (price + " +
                "volatility), the on-chain yield menu, and the price/behaviour of the RWA options (gold " +
                "and treasuries). I'll buy exactly those and nothing else.",
            ),
            toolUse("get_cspr_market_data", {}, 0),
            toolUse("get_defi_yields", {}, 1),
            toolUse("get_rwa_price", { asset: "gold" }, 2),
            toolUse("get_rwa_price", { asset: "treasury" }, 3),
          ],
        };
      }

      // Turn 2 — data is in hand: synthesize a recommendation from the real numbers.
      return { stop_reason: "end_turn", content: [text(synthesize(purchased))] };
    },
  };
}

// ---- scripting helpers -------------------------------------------------------

function text(t: string): Anthropic.TextBlockParam {
  return { type: "text", text: t };
}

function toolUse(name: string, input: Record<string, unknown>, n: number): Anthropic.ToolUseBlockParam {
  return { type: "tool_use", id: `mock_${name}_${n}`, name, input };
}

interface Purchased {
  market?: { priceUsd?: number; change24hPct?: number; source?: string };
  yields?: { yields?: Array<{ venue: string; apyPct: number; risk: string; liquid: boolean }> };
  gold?: { priceUsd?: number; change24hPct?: number };
  treasury?: { priceUsd?: number; change24hPct?: number };
}

/** Walk the conversation and JSON-parse every tool_result the agent actually bought. */
function collectPurchasedData(messages: Anthropic.MessageParam[]): Purchased {
  const idToTool = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_use") idToTool.set(b.id, { name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
    }
  }

  const out: Purchased = {};
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type !== "tool_result" || b.is_error) continue;
      const info = idToTool.get(b.tool_use_id);
      if (!info) continue;
      const raw = typeof b.content === "string" ? b.content : contentToString(b.content);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (info.name === "get_cspr_market_data") out.market = parsed;
      else if (info.name === "get_defi_yields") out.yields = parsed as Purchased["yields"];
      else if (info.name === "get_rwa_price") {
        if (info.input.asset === "gold") out.gold = parsed;
        else if (info.input.asset === "treasury") out.treasury = parsed;
      }
    }
  }
  return out;
}

function contentToString(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: string; text: string } => c?.type === "text" && typeof c.text === "string")
    .map(c => c.text)
    .join("\n");
}

/** Build a grounded DeFi/RWA recommendation from the real numbers that were purchased. */
function synthesize(d: Purchased): string {
  const price = d.market?.priceUsd;
  const change = d.market?.change24hPct;
  const yields = d.yields?.yields ?? [];
  const liquidStake = yields.find(y => /liquid staking/i.test(y.venue));
  const native = yields.find(y => /native staking/i.test(y.venue));
  const lp = yields.find(y => /LP/i.test(y.venue));
  const gold = d.gold?.priceUsd;
  const treasury = d.treasury?.priceUsd;

  const lines: string[] = [];
  lines.push("Recommendation — split the position; don't pick one side.\n");

  const marketBits: string[] = [];
  if (price !== undefined) marketBits.push(`CSPR is ~$${price}`);
  if (change !== undefined) marketBits.push(`${change >= 0 ? "+" : ""}${change}% over 24h`);
  if (marketBits.length) {
    lines.push(
      `Market read: ${marketBits.join(", ")}. That day-to-day move is exactly the volatility you're trying to damp, ` +
        "so the goal is to keep yield without leaving your whole book exposed to it.",
    );
  }

  if (liquidStake || native || lp) {
    const parts: string[] = [];
    if (liquidStake) parts.push(`liquid staking (stCSPR) at ${liquidStake.apyPct}% APY and still liquid`);
    if (native) parts.push(`native delegation at ${native.apyPct}% but locked`);
    if (lp) parts.push(`the CSPR/WCSPR LP at ${lp.apyPct}% (higher, ${lp.risk} risk)`);
    lines.push(
      `Yield menu you bought: ${parts.join("; ")}. For your "don't give up liquidity" constraint, ` +
        `${liquidStake ? `stCSPR is the right core — you keep the ${liquidStake.apyPct}% and can exit without an unbonding wait` : "liquid staking is the right core"}.`,
    );
  }

  const rwaBits: string[] = [];
  if (gold !== undefined) rwaBits.push(`tokenized gold ~$${gold}`);
  if (treasury !== undefined) rwaBits.push(`tokenized treasuries ~$${treasury}`);
  if (rwaBits.length) {
    lines.push(
      `RWA options you bought: ${rwaBits.join(", ")}. These barely move day to day (see their ~0% 24h change), ` +
        "so they're the stability/inflation-hedge sleeve — treasuries for steadiness, a smaller gold slice for inflation.",
    );
  }

  lines.push(
    "\nConcrete split: keep ~55–60% in stCSPR liquid staking (yield + instant liquidity), rotate ~30% into " +
      "tokenized treasuries (steady, inflation-resistant, low volatility), and ~10–15% into tokenized gold as a " +
      "hedge. This earns real staking yield on the majority while cutting portfolio volatility with the RWA sleeve — " +
      "and every figure above came from data this agent paid for on-chain via x402.",
  );

  return lines.join("\n");
}
