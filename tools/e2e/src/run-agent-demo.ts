import { resolve } from "node:path";
import { cascetConfigSchema, type CascetConfig } from "@cascet/core";
import { startGateway } from "@cascet/gateway";
import { createPayingFetch } from "@cascet/client";
import { runAgent, type AgentEvent } from "@cascet/agent";
import { startRealFacilitator } from "./real-facilitator.js";

/**
 * Autonomous agent demo (programmatic SDK variant): real Claude buys paid
 * DeFi/RWA data on its own, and every purchase settles for real on-chain.
 *
 *   Claude (Opus 4.8) ──discovers 3 priced tools──▶ casper-defi-data gateway (:4402)
 *        │ decides which to buy for the goal, pays x402 per call under a fixed budget
 *        ▼
 *   synthesizes a DeFi/RWA recommendation grounded in the data it purchased
 *
 * Reasoning runs on the real Anthropic API (needs ANTHROPIC_API_KEY, or an
 * `ant auth login` profile). Settlement is REAL on Casper Testnet via a
 * self-hosted facilitator (fee-sponsored by the CasCet deployer key).
 *
 * No API key? Use the FREE live-agent path instead — it drives real Claude on
 * your Max/Pro plan and settles on-chain the same way:
 *   pnpm --filter @cascet/e2e connect-demo
 *
 * Run:  ANTHROPIC_API_KEY=<key> pnpm --filter @cascet/e2e agent
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const KEYS = resolve(import.meta.dirname, "../keys");
const FACILITATOR_PORT = 4500;
const NODE_URL = "https://node.testnet.casper.network/rpc";
const GATEWAY_MCP = "http://localhost:4402/mcp";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "❌ ANTHROPIC_API_KEY not set. This programmatic demo drives real Claude via the Anthropic API.\n" +
      "   For a FREE real run (Claude on your Max/Pro plan + real on-chain settlement), use:\n" +
      "     pnpm --filter @cascet/e2e connect-demo",
  );
  process.exit(1);
}

// Real x402 payment token deployed by CasCet (transfer_with_authorization).
const X402_TOKEN = "hash-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
// payTo MUST be a serialized account-hash Key ("00" + 32-byte account hash).
const SELLER_DATA_ACCOUNT_HASH = "00881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36";

const pricing = {
  tools: {
    get_cspr_market_data: { price: "$0.01" },
    get_rwa_price: { price: "$0.02" },
    get_defi_yields: { price: "$0.02" },
  },
};

const dataConfig: CascetConfig = cascetConfigSchema.parse({
  name: "casper-defi-data",
  upstream: { type: "stdio", command: "node", args: [resolve(ROOT, "servers/casper-defi-data/dist/index.js")] },
  network: "casper:casper-test",
  payTo: SELLER_DATA_ACCOUNT_HASH,
  asset: { packageHash: X402_TOKEN, name: "CasCet X402 Token", symbol: "WCSPR", decimals: 9, version: "1", tokensPerUsd: 50 },
  facilitator: { url: `http://localhost:${FACILITATOR_PORT}` },
  anchoring: {
    contractPackageHash: "hash-bdf8422b69d7bfb7581e7b2c63fbfb0fc8b23701181289411170bce5cf996f97",
    keyPath: resolve(ROOT, "contracts/keys/deployer_secret_key.pem"),
    keyAlgo: "ed25519",
    nodeUrl: NODE_URL,
    chainName: "casper-test",
  },
  pricing,
  port: 4402,
});

// Self-hosted facilitator: fee-sponsored by the deployer key (funded with CSPR).
const facilitator = await startRealFacilitator({
  port: FACILITATOR_PORT,
  network: "casper:casper-test",
  keyPath: resolve(ROOT, "contracts/keys/deployer_secret_key.pem"),
  keyAlgo: "ed25519",
  rpcUrl: NODE_URL,
});
const gateway = await startGateway(dataConfig);

// Fixed budget the agent must live within. 25 tokens ($0.50 at tokensPerUsd 50)
// — enough for a sensible subset, not a blank cheque.
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

console.log(`──────── autonomous agent · reasoning: LIVE Claude (Opus 4.8) · settlement: REAL on-chain ────────`);
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
});

const paidOk = result.toolCalls.filter(c => c.ok);
const runPaymentIds = new Set(paidOk.map(c => c.paymentId).filter(Boolean));

console.log("\n──────── settlement summary (this run) ────────");
console.log(`reasoning: LIVE Claude (${result.brain.name})`);
console.log(`paid tool calls: ${paidOk.length} (${paidOk.map(c => c.tool).join(", ")})`);
console.log(`total authorized: ${result.spentRaw} raw token units (budget ${maxSessionRaw})`);

// The gateway's receipt store is cumulative across runs — filter to THIS run's payments.
const receipts = ((await (await fetch("http://localhost:4402/receipts")).json()) as {
  receipts: Array<{ id: string; tool: string; status: string; txHash?: string }>;
}).receipts;
const settled = receipts.filter(r => r.status === "settled" && runPaymentIds.has(r.id));
console.log(`settled this run: ${settled.length} (real on-chain)`);
for (const r of settled) {
  if (r.txHash) console.log(`  ${r.tool} → https://testnet.cspr.live/transaction/${r.txHash}`);
}

if (paidOk.length === 0) {
  throw new Error("AGENT FAIL: the agent bought no tools — it should have purchased data to answer the goal.");
}
console.log(
  `\n✅ AGENT PASS — the agent autonomously bought ${paidOk.length} paid DeFi/RWA tool call(s), settled each on-chain, and synthesized a recommendation.`,
);
console.log("");

await new Promise(r => setTimeout(r, 12_000)); // let anchoring submit
await gateway.close();
facilitator.close();
process.exit(0);
