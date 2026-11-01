import { resolve } from "node:path";
import { readFacilitatorEnv } from "./facilitator-env.js";
import { startRealFacilitator } from "./real-facilitator.js";

/**
 * Run the self-hosted x402 facilitator standalone (for the Python client demo,
 * or any external client). Testnet by default; mainnet with
 * CASCET_NETWORK=casper:casper (or the legacy CASCET_NET=mainnet).
 *
 *   pnpm --filter @cascet/e2e facilitator
 *
 * Mainnet needs dedicated keys and a token (see docs/mainnet-readiness.md):
 *   CASCET_NETWORK=casper:casper \
 *   CASCET_FACILITATOR_KEY=/secure/fee-payer_secret_key.pem \
 *   CASCET_FACILITATOR_TOKEN=$(openssl rand -hex 32) \
 *   CASCET_SELLER_ACCOUNT_HASH=00<seller account hash> \
 *   pnpm --filter @cascet/e2e facilitator
 *
 * Every variable is documented in src/facilitator-env.ts. The facilitator
 * refuses to start on mainnet when the fee-payer key is the contract owner
 * (CASCET_OWNER_ACCOUNT_HASH, default: the CasCet deployer) or a seller.
 */
const ROOT = resolve(import.meta.dirname, "../../..");

let cfg: ReturnType<typeof readFacilitatorEnv>;
try {
  cfg = readFacilitatorEnv(process.env, ROOT);
} catch (err) {
  console.error(`[run-facilitator] configuration error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
for (const warning of cfg.warnings) console.warn(`[run-facilitator] warning: ${warning}`);

try {
  const fac = await startRealFacilitator({
    port: cfg.port,
    host: cfg.host,
    network: cfg.network,
    keyPath: cfg.keyPath,
    keyAlgo: cfg.keyAlgo,
    rpcUrl: cfg.rpcUrl,
    ...(cfg.authToken ? { authToken: cfg.authToken } : {}),
    allowedPayTo: cfg.allowedPayTo,
    allowedAssets: cfg.allowedAssets,
    ...(cfg.ownerAccountHash ? { ownerAccountHash: cfg.ownerAccountHash } : {}),
    paymentMotes: cfg.paymentMotes,
    dailyGasCapMotes: cfg.dailyGasCapMotes,
    settleWaitMs: cfg.settleWaitMs,
    preflight: cfg.preflight,
    preflightDeadlineMs: cfg.preflightDeadlineMs,
    tokenVersion: cfg.tokenVersion,
  });
  console.log(`facilitator up at ${fac.url} (net=${fac.network})`);
  const stop = () => {
    void fac.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (err) {
  console.error(`[run-facilitator] refusing to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
