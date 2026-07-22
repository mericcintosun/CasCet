import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cascetConfigSchema, type CascetConfig } from "@cascet/core";
import { startGateway } from "@cascet/gateway";
import { createPayingFetch, PaidMcpHttpClient } from "@cascet/client";
import { startRealFacilitator } from "./real-facilitator.js";

/**
 * REAL x402 settlement on Casper Testnet — no mock facilitator.
 *
 * Uses:
 *  - a SELF-HOSTED x402 facilitator (src/real-facilitator.ts), fee-sponsored by
 *    the CasCet deployer key. The hosted CSPR.cloud facilitator sends the
 *    settle arg as `value` while the token expects `amount`, so every settle
 *    there reverts `User error: 64658` (Odra MissingArg) — the self-hosted
 *    facilitator sends `amount` and settles correctly.
 *  - the real CEP-18 x402 token deployed by CasCet (supports
 *    transfer_with_authorization), package hash below,
 *  - the demo agent, which already holds a balance of that token on-chain.
 *
 * Run: pnpm --filter @cascet/e2e demo-real
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const KEYS = resolve(import.meta.dirname, "../keys");
const FACILITATOR_PORT = 4501;
const NODE_URL = "https://node.testnet.casper.network/rpc";

// Real x402 payment token deployed by CasCet (transfer_with_authorization).
const X402_TOKEN = "hash-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
// payTo MUST be a serialized account-hash Key: "00" (account tag) + 32-byte
// account hash — NOT a public key. The x402 authorization signs `to` as this
// 33-byte value and the facilitator settles the transfer to that account hash.
const SELLER_DATA_ACCOUNT_HASH = "00881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36";

// Self-hosted facilitator: fee-sponsored by the deployer key (funded with CSPR).
// Allowlist the one seller + token so it refuses to fee-sponsor any other settle.
const facilitator = await startRealFacilitator({
  port: FACILITATOR_PORT,
  network: "casper:casper-test",
  keyPath: resolve(ROOT, "contracts/keys/deployer_secret_key.pem"),
  keyAlgo: "ed25519",
  rpcUrl: NODE_URL,
  allowedPayTo: [SELLER_DATA_ACCOUNT_HASH],
  allowedAssets: [X402_TOKEN],
});

const dataConfig: CascetConfig = cascetConfigSchema.parse({
  name: "casper-defi-data",
  upstream: {
    type: "stdio",
    command: "node",
    args: [resolve(ROOT, "servers/casper-defi-data/dist/index.js")],
  },
  network: "casper:casper-test",
  payTo: SELLER_DATA_ACCOUNT_HASH,
  asset: { packageHash: X402_TOKEN, name: "CasCet X402 Token", symbol: "WCSPR", decimals: 9, version: "1", tokensPerUsd: 50 },
  facilitator: { url: facilitator.url },
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
  allowedPayTo: [SELLER_DATA_ACCOUNT_HASH],
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
const settled = receipts.find(r => r.status === "settled");
console.log("──────── real settlement ────────");
console.log(`settlement tx: ${settled?.txHash ?? "(pending)"}`);
if (settled?.txHash) console.log(`  https://testnet.cspr.live/transaction/${settled.txHash}`);
if (!settled) throw new Error("REAL FAIL: no settled receipt — check facilitator token / balances");
console.log(`\n✅ REAL x402 settlement succeeded on Casper Testnet\n`);

await new Promise(r => setTimeout(r, 12_000)); // let anchoring submit
await gateway.close();
facilitator.close();
process.exit(0);
