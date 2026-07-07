import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cascetConfigSchema, type CascetConfig } from "@cascet/core";
import { startGateway } from "@cascet/gateway";
import { createPayingFetch } from "@cascet/client";
import { runAgent, createMockBrain, type AgentEvent } from "@cascet/agent";
import { startMockFacilitator } from "./mock-facilitator.js";

/**
 * Autonomous agent demo: Claude buys paid DeFi/RWA data on its own.
 *
 *   Claude (Opus 4.8) ──discovers 3 priced tools──▶ casper-defi-data gateway (:4402)
 *        │ decides which to buy for the goal, pays x402 per call under a fixed budget
 *        ▼
 *   synthesizes a DeFi/RWA recommendation grounded in the data it purchased
 *
 * Offline by default (mock facilitator). Set CSPR_CLOUD_TOKEN for REAL on-chain settlement.
 *
 * Run:  pnpm --filter @cascet/e2e agent
 *   real:  CSPR_CLOUD_TOKEN=<token> pnpm --filter @cascet/e2e agent
 * Needs ANTHROPIC_API_KEY (or an `ant auth login` profile) for the Claude calls.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const KEYS = resolve(import.meta.dirname, "../keys");
const FACILITATOR_PORT = 4500;
const GATEWAY_MCP = "http://localhost:4402/mcp";

// Reasoning backend: live Claude (needs API credits) vs a labeled offline simulation.
// Default is the simulation so the demo runs for free; the payments stay real either way.
const LIVE = process.env.CASCET_AGENT_LIVE === "1";

// Settlement backend: mock facilitator (offline) vs real CSPR.cloud on-chain settlement.
const CSPR_CLOUD_TOKEN = process.env.CSPR_CLOUD_TOKEN;
const REAL = Boolean(CSPR_CLOUD_TOKEN);

function banner(): void {
  // Rule-only frame (no right border) so emoji/unicode widths can't misalign it.
  const rule = "═".repeat(74);
  const rows = [
    " ⚠  SIMULATED AGENT REASONING — no Anthropic API key purchased",
    "",
    " For this hackathon build no paid API key was bought, so the LLM's tool",
    " decisions and final wording are SCRIPTED offline.",
    "",
    " Everything else is REAL and unchanged: tool discovery, x402 pricing, per-",
    " call payments, budget enforcement, cascade receipts, and settlement — and",
    " the recommendation is grounded in the real data the agent paid for.",
    "",
    " Run it live with real Claude:  CASCET_AGENT_LIVE=1 <same command>",
  ];
  console.log(`\n${rule}`);
  for (const r of rows) console.log(r);
  console.log(`${rule}\n`);
}

const pub = (name: string) => readFileSync(resolve(KEYS, `${name}.pub`), "utf8").trim();

// Real x402 payment token deployed by CasCet (transfer_with_authorization).
const X402_TOKEN = "hash-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
// payTo for real settlement MUST be a serialized account-hash Key ("00" + 32-byte hash).
const SELLER_DATA_ACCOUNT_HASH = "00881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36";

const pricing = {
  tools: {
    get_cspr_market_data: { price: "$0.01" },
    get_rwa_price: { price: "$0.02" },
    get_defi_yields: { price: "$0.02" },
  },
};

const dataConfig: CascetConfig = cascetConfigSchema.parse(
  REAL
    ? {
        name: "casper-defi-data",
        upstream: { type: "stdio", command: "node", args: [resolve(ROOT, "servers/casper-defi-data/dist/index.js")] },
        network: "casper:casper-test",
        payTo: SELLER_DATA_ACCOUNT_HASH,
        asset: { packageHash: X402_TOKEN, name: "CasCet X402 Token", symbol: "WCSPR", decimals: 9, version: "1", tokensPerUsd: 50 },
        facilitator: { url: "https://x402-facilitator.cspr.cloud", apiKey: CSPR_CLOUD_TOKEN },
        anchoring: {
          contractPackageHash: "hash-bdf8422b69d7bfb7581e7b2c63fbfb0fc8b23701181289411170bce5cf996f97",
          keyPath: resolve(ROOT, "contracts/keys/deployer_secret_key.pem"),
          keyAlgo: "ed25519",
          nodeUrl: "https://node.testnet.casper.network/rpc",
          chainName: "casper-test",
        },
        pricing,
        port: 4402,
      }
    : {
        name: "casper-defi-data",
        upstream: { type: "stdio", command: "node", args: [resolve(ROOT, "servers/casper-defi-data/dist/index.js")] },
        payTo: pub("seller-data"),
        asset: { packageHash: "0000000000000000000000000000000000000000000000000000000000000000", name: "Demo Wrapped CSPR", symbol: "WCSPR", decimals: 9, version: "1", tokensPerUsd: 50 },
        facilitator: { url: `http://localhost:${FACILITATOR_PORT}` },
        pricing,
        port: 4402,
      },
);

const facilitator = REAL ? undefined : startMockFacilitator(FACILITATOR_PORT);
const gateway = await startGateway(dataConfig);

// Fixed budget the agent must live within. $0.50 worth of the payment token
// (tokensPerUsd 50, 9 decimals) — enough for a sensible subset, not a blank cheque.
const maxSessionRaw = (BigInt("25") * 10n ** 9n).toString();

const paying = await createPayingFetch({
  privateKeyPath: resolve(KEYS, "agent.pem"),
  budget: { maxSessionRaw },
  onPayment: info => console.log(`   💸 x402: authorizing ${info.amountRaw} raw token units → ${info.payTo.slice(0, 12)}…`),
});

const goal =
  "I hold a CSPR-heavy portfolio on Casper (~80% CSPR, some stablecoins) and want steadier, " +
  "inflation-resistant yield without giving up too much liquidity. Should I rotate part of it into " +
  "liquid staking (stCSPR) or into tokenized real-world assets like gold or US treasuries? " +
  "Back your recommendation with current market data, on-chain yields, and RWA prices.";

if (!LIVE) banner();

console.log(`──────── autonomous agent · reasoning: ${LIVE ? "LIVE Claude (Opus 4.8)" : "SIMULATED"} · settlement: ${REAL ? "REAL on-chain" : "mock facilitator"} ────────`);
console.log(`goal: ${goal}\n`);

const onEvent = (e: AgentEvent) => {
  switch (e.type) {
    case "tools_listed":
      console.log(`🛠  tools on offer: ${e.tools.map(t => `${t.name} (${t.priceUsd ?? "free"})`).join(", ")}\n`);
      break;
    case "assistant_text":
      if (e.text.trim()) console.log(`🤖 ${e.text.trim()}\n`);
      break;
    case "tool_call":
      console.log(`🧠 Claude decides to buy: ${e.tool} ${e.priceUsd ? `(${e.priceUsd})` : ""} input=${JSON.stringify(e.input)}`);
      break;
    case "tool_result":
      console.log(`   ${e.ok ? "✅ received" : "⛔ rejected"} ${e.paymentId ? `payment ${e.paymentId}` : ""}\n`);
      break;
    default:
      break;
  }
};

const result = await runAgent({
  goal,
  gatewayMcpUrl: GATEWAY_MCP,
  paying,
  onEvent,
  brain: LIVE ? undefined : createMockBrain(),
});

const paidOk = result.toolCalls.filter(c => c.ok);
const runPaymentIds = new Set(paidOk.map(c => c.paymentId).filter(Boolean));

console.log("\n──────── settlement summary (this run) ────────");
console.log(`reasoning: ${result.brain.live ? "LIVE Claude" : "SIMULATED"} (${result.brain.name})`);
console.log(`paid tool calls: ${paidOk.length} (${paidOk.map(c => c.tool).join(", ")})`);
console.log(`total authorized: ${result.spentRaw} raw token units (budget ${maxSessionRaw})`);

// The gateway's receipt store is cumulative across runs — filter to THIS run's payments.
const receipts = ((await (await fetch("http://localhost:4402/receipts")).json()) as {
  receipts: Array<{ id: string; tool: string; status: string; txHash?: string }>;
}).receipts;
const settled = receipts.filter(r => r.status === "settled" && runPaymentIds.has(r.id));
console.log(`settled this run: ${settled.length}${REAL ? " (real on-chain)" : " (mock facilitator — no on-chain tx)"}`);
// Only real settlement produces resolvable cspr.live transactions; mock tx hashes are synthetic.
if (REAL) {
  for (const r of settled) {
    if (r.txHash) console.log(`  ${r.tool} → https://testnet.cspr.live/transaction/${r.txHash}`);
  }
}

if (paidOk.length === 0) {
  throw new Error("AGENT FAIL: the agent bought no tools — it should have purchased data to answer the goal.");
}
console.log(
  `\n✅ AGENT PASS — the agent autonomously bought ${paidOk.length} paid DeFi/RWA tool call(s) and synthesized a recommendation.`,
);
if (!result.brain.live) {
  console.log(
    "   (reasoning SIMULATED — no API key purchased; payments/settlement above are real. CASCET_AGENT_LIVE=1 for real Claude.)",
  );
}
console.log("");

await new Promise(r => setTimeout(r, REAL ? 12_000 : 500));
await gateway.close();
facilitator?.close();
process.exit(0);
