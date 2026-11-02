import { resolve } from "node:path";
import { cascetConfigSchema, type CascetConfig } from "@cascet/core";
import { startGateway } from "@cascet/gateway";
import { createPayingFetch, PaidMcpHttpClient } from "@cascet/client";
import { facilitatorOptionsFromEnv, NETWORKS, readFacilitatorEnv } from "./facilitator-env.js";
import { checkRecorderSeparation } from "./facilitator-roles.js";
import { accountHashOfKeyFile } from "./key-file.js";
import { startRealFacilitator } from "./real-facilitator.js";

/**
 * REAL x402 settlement on Casper Testnet — no mock facilitator.
 *
 * Uses:
 *  - a SELF-HOSTED x402 facilitator (src/real-facilitator.ts), fee-sponsored by
 *    the CasCet deployer key. The hosted CSPR.cloud facilitator now sends the
 *    CEP-3009 settle arg `value`, while this (earlier reference) token expects
 *    `amount`, so a hosted settle reverts `User error: 64658` (Odra MissingArg);
 *    the self-hosted facilitator builds its own settlement in each token's
 *    style (`amount` here) and settles.
 *  - the real CEP-18 x402 token deployed by CasCet (supports
 *    transfer_with_authorization), package hash below,
 *  - the demo agent, which already holds a balance of that token on-chain.
 *
 * Keys come from the environment (same variables as the standalone
 * facilitator, see src/facilitator-env.ts); on testnet they default to the
 * deployer key so the demo runs as before:
 *   CASCET_FACILITATOR_KEY      fee-payer PEM
 *   CASCET_RECORDER_KEY         ReceiptRegistry recorder PEM (anchoring)
 *   CASCET_SELLER_ACCOUNT_HASH  payTo
 *   CASCET_FACILITATOR_TOKEN    optional shared token (also sent by the gateway)
 *
 * Run: pnpm --filter @cascet/e2e demo-real
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const KEYS = resolve(import.meta.dirname, "../keys");
const TESTNET = NETWORKS["casper:casper-test"];
const NODE_URL = TESTNET.rpcUrl;

const fac = readFacilitatorEnv(process.env, ROOT, "casper:casper-test");
for (const warning of fac.warnings) console.warn(`[demo] warning: ${warning}`);
const recorderEnv = process.env.CASCET_RECORDER_KEY?.trim();
const RECORDER_KEY = recorderEnv ? resolve(recorderEnv) : resolve(ROOT, "contracts/keys/deployer_secret_key.pem");
// Same role rules as mainnet, as warnings: the testnet demo may run on one key.
for (const warning of checkRecorderSeparation({
  network: "casper:casper-test",
  recorderAccountHash: accountHashOfKeyFile(RECORDER_KEY, "ed25519", "recorder"),
  feePayerAccountHash: accountHashOfKeyFile(fac.keyPath, fac.keyAlgo, "fee-payer"),
  ownerAccountHashes: fac.ownerAccountHashes,
  sellerAccountHashes: fac.allowedPayTo,
}).warnings) {
  console.warn(`[demo] warning: ${warning}`);
}

// Real x402 payment token deployed by CasCet (transfer_with_authorization).
const X402_TOKEN = `hash-${TESTNET.token}`;
// payTo MUST be a serialized account-hash Key: "00" (account tag) + 32-byte
// account hash — NOT a public key. The x402 authorization signs `to` as this
// 33-byte value and the facilitator settles the transfer to that account hash.
const SELLER_DATA_ACCOUNT_HASH = fac.allowedPayTo[0]!;

// Self-hosted facilitator: fee-sponsored by CASCET_FACILITATOR_KEY (funded with CSPR).
// Allowlist the seller + token so it refuses to fee-sponsor any other settle.
// Every environment setting reaches it, per asset too: declared style, pinned
// name and version, gas limit (CASCET_ASSET_STYLES, CASCET_ASSET_NAMES,
// CASCET_SETTLE_PAYMENT_MOTES_BY_ASSET).
const facilitator = await startRealFacilitator(facilitatorOptionsFromEnv(fac));

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
  facilitator: { url: facilitator.url, ...(fac.authToken ? { apiKey: fac.authToken } : {}) },
  anchoring: {
    contractPackageHash: TESTNET.receiptRegistry,
    keyPath: RECORDER_KEY,
    keyAlgo: "ed25519",
    nodeUrl: NODE_URL,
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
// This payment's own receipt: gateway receipts persist, so "any settled receipt"
// could be one from an earlier run (L12).
const settled = receipts.find(r => r.id === paymentId && r.status === "settled");
console.log("──────── real settlement ────────");
console.log(`settlement tx: ${settled?.txHash ?? "(pending)"}`);
if (settled?.txHash) console.log(`  https://testnet.cspr.live/transaction/${settled.txHash}`);
if (!settled) throw new Error("REAL FAIL: no settled receipt — check facilitator token / balances");
console.log(`\n✅ REAL x402 settlement succeeded on Casper Testnet\n`);

await new Promise(r => setTimeout(r, 12_000)); // let anchoring submit
await gateway.close();
await facilitator.close();
process.exit(0);
