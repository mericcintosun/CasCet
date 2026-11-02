import { resolve } from "node:path";
import { cascetConfigSchema, type CascetConfig } from "@cascet/core";
import { createCasperRpc, startGateway } from "@cascet/gateway";
import { createPayingFetch, PaidMcpHttpClient } from "@cascet/client";
import { accountsSignableBy } from "./account-keys.js";
import { runMainnetDemoCall, type DemoReceipt } from "./demo-paid-call.js";
import { facilitatorOptionsFromEnv, NETWORKS, readFacilitatorEnv } from "./facilitator-env.js";
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
 * transaction. The buyer waits longer than the gateway's longest paid call, the
 * run prints its settlement transaction even when the call fails, and with a
 * recorder it waits for the receipt's anchor and prints it (demo-paid-call.ts).
 *
 * Keys come from the environment, one per role (M07; generate them offline with
 * the key-roles script of this package):
 *   CASCET_FACILITATOR_KEY      fee-payer PEM (required; must not be the owner or the seller)
 *   CASCET_FACILITATOR_TOKEN    shared facilitator token (required, at least 32 characters)
 *   CASCET_FACILITATOR_STATE_FILE
 *                               the facilitator's state file (required; "none" runs without one, with a
 *                               warning): every settlement is saved there before it is broadcast
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
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function main(): Promise<number> {
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
  // Every environment setting reaches it, per asset too: declared style, pinned
  // name and version, gas limit (CASCET_ASSET_STYLES, CASCET_ASSET_NAMES,
  // CASCET_SETTLE_PAYMENT_MOTES_BY_ASSET).
  const facilitator = await startRealFacilitator(facilitatorOptionsFromEnv(fac));

  let dataConfig: CascetConfig;
  try {
    dataConfig = cascetConfigSchema.parse({
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
  } catch (err) {
    await facilitator.close();
    throw err;
  }

  // From here on the gateway and the facilitator are closed whatever happens.
  return runMainnetDemoCall(
    {
      config: dataConfig,
      buyerKeyPath: resolve(KEYS, "agent.pem"),
      seller: SELLER,
      asset: X402_TOKEN,
      tool: "get_cspr_market_data",
      explorer: MAINNET.explorer,
    },
    {
      startGateway,
      createPayingFetch,
      newClient: (url, fetchImpl, options) => new PaidMcpHttpClient(url, fetchImpl, options),
      listReceipts: async base => {
        const response = await fetch(`${base}/receipts`);
        if (!response.ok) throw new Error(`GET /receipts answered ${response.status}`);
        return ((await response.json()) as { receipts: DemoReceipt[] }).receipts;
      },
      facilitator,
    },
  );
}

main().then(
  code => process.exit(code),
  (err: unknown) => {
    console.error(`[demo] ${message(err)}`);
    process.exit(1);
  },
);
