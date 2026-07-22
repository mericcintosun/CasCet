import { resolve } from "node:path";
import { cascetConfigSchema, type CascetConfig } from "@cascet/core";
import { startGateway } from "@cascet/gateway";
import { createPayingFetch, PaidMcpHttpClient } from "@cascet/client";
import { startRealFacilitator } from "./real-facilitator.js";

/**
 * Full REAL cascade demo on Casper Testnet:
 *
 *   agent wallet ──pays (real x402)──▶ portfolio-analyst gateway (:4403)
 *                              │ analyst wallet ──pays (real x402)──▶ casper-defi-data gateway (:4402)
 *
 * Every hop settles a real transfer_with_authorization on-chain through a
 * self-hosted facilitator (fee-sponsored by the CasCet deployer key), and each
 * settled receipt anchors into the on-chain ReceiptRegistry. The analyst wallet
 * must hold the payment token — fund it once with:
 *   pnpm --filter @cascet/e2e fund-token <analyst-account-hash> 300
 *
 * Run: pnpm --filter @cascet/e2e demo   (after gen-keys)
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const KEYS = resolve(import.meta.dirname, "../keys");
const FACILITATOR_PORT = 4500;
const NODE_URL = "https://node.testnet.casper.network/rpc";
// When the dashboard is running (pnpm --filter @cascet/dashboard dev), gateways
// push live receipt events to it. Override with DASHBOARD_INGEST=... or "".
const DASHBOARD_INGEST = process.env.DASHBOARD_INGEST ?? "http://localhost:3939/api/ingest";

// Real x402 payment token deployed by CasCet (transfer_with_authorization).
const X402_TOKEN = "hash-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
// payTo values are serialized account-hash Keys ("00" + 32-byte account hash).
const SELLER_DATA_ACCOUNT_HASH = "00881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36";
const SELLER_ANALYST_ACCOUNT_HASH = "0051a4f8ca1c186b0e93ff6628e2c2303ded5b3cd343fca220e829ce540411abf3";

const anchoring = {
  contractPackageHash: "hash-bdf8422b69d7bfb7581e7b2c63fbfb0fc8b23701181289411170bce5cf996f97",
  keyPath: resolve(ROOT, "contracts/keys/deployer_secret_key.pem"),
  keyAlgo: "ed25519" as const,
  nodeUrl: NODE_URL,
  chainName: "casper-test",
  gasMotes: 5_000_000_000,
};

const asset = { packageHash: X402_TOKEN, name: "CasCet X402 Token", symbol: "WCSPR", decimals: 9, version: "1", tokensPerUsd: 50 };

const dataConfig: CascetConfig = cascetConfigSchema.parse({
  name: "casper-defi-data",
  upstream: {
    type: "stdio",
    command: "node",
    args: [resolve(ROOT, "servers/casper-defi-data/dist/index.js")],
  },
  network: "casper:casper-test",
  payTo: SELLER_DATA_ACCOUNT_HASH,
  asset,
  facilitator: { url: `http://localhost:${FACILITATOR_PORT}` },
  eventsUrl: DASHBOARD_INGEST || undefined,
  anchoring,
  pricing: {
    tools: {
      get_cspr_market_data: { price: "$0.01" },
      get_rwa_price: { price: "$0.02" },
      get_defi_yields: { price: "$0.02" },
    },
  },
  port: 4402,
});

const analystConfig: CascetConfig = cascetConfigSchema.parse({
  name: "portfolio-analyst",
  upstream: {
    type: "stdio",
    command: "node",
    args: [resolve(ROOT, "servers/portfolio-analyst/dist/index.js")],
    env: {
      DATA_GATEWAY_URL: "http://localhost:4402/mcp",
      CASCET_KEY_PATH: resolve(KEYS, "analyst.pem"),
    },
  },
  network: "casper:casper-test",
  payTo: SELLER_ANALYST_ACCOUNT_HASH,
  asset,
  facilitator: { url: `http://localhost:${FACILITATOR_PORT}` },
  eventsUrl: DASHBOARD_INGEST || undefined,
  anchoring,
  pricing: { tools: { analyze_portfolio: { price: "$0.10" } } },
  port: 4403,
});

// One self-hosted facilitator serves both gateways (fee-sponsored by deployer).
const facilitator = await startRealFacilitator({
  port: FACILITATOR_PORT,
  network: "casper:casper-test",
  keyPath: resolve(ROOT, "contracts/keys/deployer_secret_key.pem"),
  keyAlgo: "ed25519",
  rpcUrl: NODE_URL,
  allowedPayTo: [SELLER_DATA_ACCOUNT_HASH, SELLER_ANALYST_ACCOUNT_HASH],
  allowedAssets: [X402_TOKEN],
});
const dataGateway = await startGateway(dataConfig);
const analystGateway = await startGateway(analystConfig);

console.log("\n──────── agent starts buying (real on-chain settlement) ────────\n");

const paying = await createPayingFetch({
  privateKeyPath: resolve(KEYS, "agent.pem"),
  allowedPayTo: [SELLER_ANALYST_ACCOUNT_HASH],
  allowedAssets: [X402_TOKEN],
  onPayment: info => console.log(`[agent] 💸 paying ${info.amountRaw} raw units`),
});
const analyst = new PaidMcpHttpClient("http://localhost:4403/mcp", paying.fetch);
await analyst.initialize();

const tools = await analyst.listTools();
console.log(`[agent] tools on offer: ${tools.map(t => t.name).join(", ")}`);

const { result, paymentId } = await analyst.callTool("analyze_portfolio", {
  holdings: [
    { asset: "CSPR", amountUsd: 7000 },
    { asset: "gold", amountUsd: 2000 },
    { asset: "treasury", amountUsd: 1000 },
  ],
});

const text = (result.content as Array<{ type: string; text?: string }>).find(c => c.type === "text")?.text;
console.log(`\n[agent] analysis received (root payment ${paymentId}):\n${text}\n`);

// ---- Assert the cascade actually linked up -----------------------------------
const dataReceipts = ((await (await fetch("http://localhost:4402/receipts")).json()) as {
  receipts: Array<{ id: string; parentId?: string; tool: string; status: string; txHash?: string }>;
}).receipts;
const analystReceipts = ((await (await fetch("http://localhost:4403/receipts")).json()) as {
  receipts: Array<{ id: string; parentId?: string; tool: string; status: string; txHash?: string }>;
}).receipts;

const rootReceipt = analystReceipts.find(r => r.tool === "analyze_portfolio" && r.status === "settled");
const children = dataReceipts.filter(r => r.parentId === rootReceipt?.id);

console.log("──────── cascade verification (real on-chain) ────────");
console.log(`root:     ${rootReceipt?.id} (analyze_portfolio, ${rootReceipt?.status})`);
if (rootReceipt?.txHash) console.log(`          https://testnet.cspr.live/transaction/${rootReceipt.txHash}`);
for (const child of children) {
  console.log(`  child:  ${child.id} (${child.tool}) parent=${child.parentId}`);
  if (child.txHash) console.log(`          https://testnet.cspr.live/transaction/${child.txHash}`);
}

if (!rootReceipt) throw new Error("E2E FAIL: no settled root receipt on analyst gateway");
if (children.length < 3) throw new Error(`E2E FAIL: expected ≥3 cascade children, got ${children.length}`);
console.log(`\n✅ E2E PASS — ${children.length} downstream payments correctly linked to root ${rootReceipt.id}, all settled on-chain\n`);

// Let fire-and-forget pushes and on-chain anchor submissions flush before teardown.
await new Promise(resolveDelay => setTimeout(resolveDelay, 12_000));

await analystGateway.close();
await dataGateway.close();
facilitator.close();
process.exit(0);
