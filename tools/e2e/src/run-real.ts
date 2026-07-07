import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cascetConfigSchema, type CascetConfig } from "@cascet/core";
import { startGateway } from "@cascet/gateway";
import { createPayingFetch, PaidMcpHttpClient } from "@cascet/client";

/**
 * REAL x402 settlement on Casper Testnet — no mock facilitator.
 *
 * Uses:
 *  - the hosted CSPR.cloud facilitator (needs CSPR_CLOUD_TOKEN),
 *  - the real CEP-18 x402 token deployed by CasCet (supports
 *    transfer_with_authorization), package hash below,
 *  - the demo agent, which already holds a balance of that token on-chain.
 *
 * Run: CSPR_CLOUD_TOKEN=<token> pnpm --filter @cascet/e2e demo-real
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const KEYS = resolve(import.meta.dirname, "../keys");

const CSPR_CLOUD_TOKEN = process.env.CSPR_CLOUD_TOKEN;
if (!CSPR_CLOUD_TOKEN) {
  console.error("❌ CSPR_CLOUD_TOKEN env var required (get one at https://console.cspr.cloud).");
  process.exit(1);
}

// Real x402 payment token deployed by CasCet (transfer_with_authorization).
const X402_TOKEN = "hash-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
const pub = (name: string) => readFileSync(resolve(KEYS, `${name}.pub`), "utf8").trim();

const dataConfig: CascetConfig = cascetConfigSchema.parse({
  name: "casper-defi-data",
  upstream: {
    type: "stdio",
    command: "node",
    args: [resolve(ROOT, "servers/casper-defi-data/dist/index.js")],
  },
  network: "casper:casper-test",
  payTo: pub("seller-data"),
  asset: { packageHash: X402_TOKEN, name: "CasCet X402 Token", symbol: "WCSPR", decimals: 9, version: "1", tokensPerUsd: 50 },
  facilitator: { url: "https://x402-facilitator.cspr.cloud", apiKey: CSPR_CLOUD_TOKEN },
  anchoring: {
    contractPackageHash: "hash-bdf8422b69d7bfb7581e7b2c63fbfb0fc8b23701181289411170bce5cf996f97",
    keyPath: resolve(ROOT, "contracts/keys/deployer_secret_key.pem"),
    keyAlgo: "ed25519",
    nodeUrl: "https://node.testnet.casper.network/rpc",
    chainName: "casper-test",
  },
  pricing: { tools: { get_cspr_market_data: { price: "$0.01" } } },
  port: 4402,
});

const gateway = await startGateway(dataConfig);
console.log("\n──────── real x402 payment (buyer holds the token on-chain) ────────\n");

const paying = await createPayingFetch({
  privateKeyPath: resolve(KEYS, "agent.pem"),
  onPayment: info => console.log(`[agent] 💸 authorizing ${info.amountRaw} raw token units → ${info.payTo.slice(0, 12)}…`),
});
const client = new PaidMcpHttpClient("http://localhost:4402/mcp", paying.fetch);
await client.initialize();

const { result, paymentId } = await client.callTool("get_cspr_market_data", {});
const text = (result.content as Array<{ type: string; text?: string }>).find(c => c.type === "text")?.text;
console.log(`\n[agent] paid + received (payment ${paymentId}):\n${text}\n`);

const receipts = ((await (await fetch("http://localhost:4402/receipts")).json()) as {
  receipts: Array<{ id: string; tool: string; status: string; txHash?: string }>;
}).receipts;
const settled = receipts.find(r => r.status === "settled");
console.log("──────── real settlement ────────");
console.log(`settlement tx: ${settled?.txHash ?? "(pending)"}`);
if (settled?.txHash) console.log(`  https://testnet.cspr.live/transaction/${settled.txHash}`);
if (!settled) throw new Error("REAL FAIL: no settled receipt — check facilitator token / balances");
console.log(`\n✅ REAL x402 settlement succeeded on Casper Testnet\n`);

await new Promise(r => setTimeout(r, 12_000)); // let anchoring submit
await gateway.close();
process.exit(0);
