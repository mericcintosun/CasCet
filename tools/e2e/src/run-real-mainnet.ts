import { resolve } from "node:path";
import { cascetConfigSchema, type CascetConfig } from "@cascet/core";
import { createCasperRpc, startGateway } from "@cascet/gateway";
import { createPayingFetch, PaidMcpHttpClient } from "@cascet/client";
import { accountsSignableBy } from "./account-keys.js";
import { NETWORKS, readFacilitatorEnv } from "./facilitator-env.js";
import { checkRecorderSeparation } from "./facilitator-roles.js";
import { accountHashOfKeyFile } from "./key-file.js";
import { startRealFacilitator } from "./real-facilitator.js";

/**
 * REAL x402 settlement on Casper MAINNET.
 *
 * Everything is live on mainnet:
 *  - Cep18X402 payment token (transfer_with_authorization), package below,
 *  - the 5 CasCet Odra contracts (ReceiptRegistry anchors this settle),
 *  - a self-hosted facilitator fee-sponsored by a DEDICATED fee-payer key.
 *
 * The agent (payer) holds the token on mainnet; it pays the seller (payTo) and
 * the facilitator settles the transfer on mainnet. Proof: a cspr.live (mainnet)
 * transaction.
 *
 * Keys come from the environment, one per role (M07; generate them offline with
 * the key-roles script of this package):
 *   CASCET_FACILITATOR_KEY      fee-payer PEM (required; must not be the owner or the seller)
 *   CASCET_FACILITATOR_TOKEN    shared facilitator token (required, at least 32 characters)
 *   CASCET_SELLER_ACCOUNT_HASH  payTo (default: the deployer account, as before)
 *   CASCET_OWNER_ACCOUNT_HASH   further owner accounts (the deployer account always counts as one)
 *   CASCET_RECORDER_KEY         authorized ReceiptRegistry recorder PEM (optional; no anchoring without it;
 *                               refused if it is the fee payer, an owner or the seller, or an associated
 *                               key of an owner or seller account)
 *
 * Run: pnpm --filter @cascet/e2e demo-real-mainnet
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const KEYS = resolve(import.meta.dirname, "../keys");
const MAINNET = NETWORKS["casper:casper"];
const NODE_URL = MAINNET.rpcUrl;

// Facilitator roles and limits from the environment (throws with an actionable message).
const fac = readFacilitatorEnv(process.env, ROOT, "casper:casper");
for (const warning of fac.warnings) console.warn(`[demo] warning: ${warning}`);

// Mainnet Cep18X402 payment token.
const X402_TOKEN = `hash-${MAINNET.token}`;
// payTo (seller): a serialized account-hash Key ("00" + hash).
const SELLER = fac.allowedPayTo[0]!;
// Mainnet ReceiptRegistry (anchors the settled receipt).
const RECEIPT_REGISTRY = MAINNET.receiptRegistry;
// The anchoring recorder is its own key: never the fee payer, the owner or a
// seller (compared by account, not by file path).
const recorderEnv = process.env.CASCET_RECORDER_KEY?.trim();
const RECORDER_KEY = recorderEnv ? resolve(recorderEnv) : undefined;
if (RECORDER_KEY) {
  const recorder = accountHashOfKeyFile(RECORDER_KEY, "ed25519", "recorder");
  const roles = checkRecorderSeparation({
    network: "casper:casper",
    recorderAccountHash: recorder,
    feePayerAccountHash: accountHashOfKeyFile(fac.keyPath, fac.keyAlgo, "fee-payer"),
    ownerAccountHashes: fac.ownerAccountHashes,
    sellerAccountHashes: fac.allowedPayTo,
  });
  if (roles.errors.length > 0) {
    throw new Error(`CASCET_RECORDER_KEY: ${roles.errors.join("; ")} (docs/mainnet-readiness.md)`);
  }
  // Read-only: the hot recorder key must not be able to sign for an owner or seller account.
  const signable = await accountsSignableBy(createCasperRpc(fac.rpcUrl), [...fac.ownerAccountHashes, ...fac.allowedPayTo], recorder);
  if (signable.length > 0) {
    throw new Error(`CASCET_RECORDER_KEY is an associated key of ${signable.map(a => `${a.slice(0, 10)}…`).join(", ")} (docs/mainnet-readiness.md)`);
  }
} else {
  console.warn("[demo] CASCET_RECORDER_KEY not set: the receipt is not anchored on-chain");
}

// Self-hosted mainnet facilitator: dedicated fee payer, token-protected, allowlisted.
// It refuses to start if the fee payer is an owner or the seller, or can sign for one.
const facilitator = await startRealFacilitator({
  port: fac.port,
  network: "casper:casper",
  keyPath: fac.keyPath,
  keyAlgo: fac.keyAlgo,
  rpcUrl: fac.rpcUrl,
  ...(fac.authToken ? { authToken: fac.authToken } : {}),
  allowedPayTo: fac.allowedPayTo,
  allowedAssets: fac.allowedAssets,
  ownerAccountHashes: fac.ownerAccountHashes,
  paymentMotes: fac.paymentMotes,
  dailyGasCapMotes: fac.dailyGasCapMotes,
  settleWaitMs: fac.settleWaitMs,
  preflight: fac.preflight,
  preflightDeadlineMs: fac.preflightDeadlineMs,
  tokenVersion: fac.tokenVersion,
  ...(fac.tokenName ? { tokenName: fac.tokenName } : {}),
});

const dataConfig: CascetConfig = cascetConfigSchema.parse({
  name: "casper-defi-data",
  upstream: { type: "stdio", command: "node", args: [resolve(ROOT, "servers/casper-defi-data/dist/index.js")] },
  network: "casper:casper",
  payTo: SELLER,
  asset: { packageHash: X402_TOKEN, name: "CasCet X402 Token", symbol: "WCSPR", decimals: 9, version: "1", tokensPerUsd: 50 },
  facilitator: { url: facilitator.url, ...(fac.authToken ? { apiKey: fac.authToken } : {}) },
  ...(RECORDER_KEY
    ? {
        anchoring: {
          contractPackageHash: RECEIPT_REGISTRY,
          keyPath: RECORDER_KEY,
          keyAlgo: "ed25519",
          nodeUrl: NODE_URL,
          chainName: "casper",
        },
      }
    : {}),
  pricing: { tools: { get_cspr_market_data: { price: "$0.01" } } },
  port: 4402,
});

const gateway = await startGateway(dataConfig);
console.log("\n──────── REAL x402 payment on Casper MAINNET ────────\n");

const paying = await createPayingFetch({
  privateKeyPath: resolve(KEYS, "agent.pem"),
  networks: ["casper:casper"], // the client pays on testnet only unless mainnet is listed
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

if (RECORDER_KEY) await new Promise(r => setTimeout(r, 14_000)); // let anchoring submit
await gateway.close();
await facilitator.close();
process.exit(0);
