import { resolve } from "node:path";
import { cascetConfigSchema, type CascetConfig } from "@cascet/core";
import { startGateway } from "@cascet/gateway";
import { createPayingFetch, PaidMcpHttpClient } from "@cascet/client";
import { startRealFacilitator } from "./real-facilitator.js";

/**
 * REAL x402 settlement on Casper MAINNET.
 *
 * Everything is live on mainnet:
 *  - Cep18X402 payment token (transfer_with_authorization), package below,
 *  - the 5 CasCet Odra contracts (ReceiptRegistry anchors this settle),
 *  - a self-hosted facilitator fee-sponsored by the CasCet mainnet deployer key.
 *
 * The agent (payer) holds the token on mainnet; it pays the seller (payTo) and
 * the facilitator settles the transfer on mainnet. Proof: a cspr.live (mainnet)
 * transaction.
 *
 * Run: pnpm --filter @cascet/e2e demo-real-mainnet
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const KEYS = resolve(import.meta.dirname, "../keys");
const FACILITATOR_PORT = 4501;
const NODE_URL = "https://node.mainnet.casper.network/rpc";
const MAINNET_KEY = resolve(ROOT, "contracts/keys/mainnet_deployer_secret_key.pem");

// Mainnet Cep18X402 payment token.
const X402_TOKEN = "hash-8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41";
// payTo (seller) = the mainnet deployer's serialized account-hash Key ("00" + hash).
const SELLER = "00b9a38c827771d6bc510dd5f1e24fee61acdd4f97f758f4d68fe1dea13a7a140d";
// Mainnet ReceiptRegistry (anchors the settled receipt).
const RECEIPT_REGISTRY = "hash-f86bef35062e92d06b8171cf4131fdf557463589aca9112a348e5eb24159eb93";

// Self-hosted mainnet facilitator, fee-sponsored by the deployer, allowlisted.
const facilitator = await startRealFacilitator({
  port: FACILITATOR_PORT,
  network: "casper:casper",
  keyPath: MAINNET_KEY,
  keyAlgo: "ed25519",
  rpcUrl: NODE_URL,
  allowedPayTo: [SELLER],
  allowedAssets: [X402_TOKEN],
});

const dataConfig: CascetConfig = cascetConfigSchema.parse({
  name: "casper-defi-data",
  upstream: { type: "stdio", command: "node", args: [resolve(ROOT, "servers/casper-defi-data/dist/index.js")] },
  network: "casper:casper",
  payTo: SELLER,
  asset: { packageHash: X402_TOKEN, name: "CasCet X402 Token", symbol: "WCSPR", decimals: 9, version: "1", tokensPerUsd: 50 },
  facilitator: { url: facilitator.url },
  anchoring: {
    contractPackageHash: RECEIPT_REGISTRY,
    keyPath: MAINNET_KEY,
    keyAlgo: "ed25519",
    nodeUrl: NODE_URL,
    chainName: "casper",
  },
  pricing: { tools: { get_cspr_market_data: { price: "$0.01" } } },
  port: 4402,
});

const gateway = await startGateway(dataConfig);
console.log("\n──────── REAL x402 payment on Casper MAINNET ────────\n");

const paying = await createPayingFetch({
  privateKeyPath: resolve(KEYS, "agent.pem"),
  allowedPayTo: [SELLER],
  allowedAssets: [X402_TOKEN],
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
const settled = receipts.find(r => r.id === paymentId && r.status === "settled");
console.log("──────── real MAINNET settlement ────────");
console.log(`settlement tx: ${settled?.txHash ?? "(pending)"}`);
if (settled?.txHash) console.log(`  https://cspr.live/transaction/${settled.txHash}`);
if (!settled) throw new Error("MAINNET FAIL: no settled receipt");
console.log(`\n✅ REAL x402 settlement succeeded on Casper MAINNET\n`);

await new Promise(r => setTimeout(r, 14_000)); // let anchoring submit
await gateway.close();
facilitator.close();
process.exit(0);
