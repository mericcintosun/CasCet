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
 * It settles CasCet's x402 token (`amount`) and CEP-3009 tokens such as the
 * official Wrapped CSPR (`value`) side by side; add them to
 * CASCET_ALLOWED_ASSETS, e.g. on testnet:
 *   CASCET_ALLOWED_ASSETS=hash-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3,hash-3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e
 * At start-up it reads every token's ABI, chain_name and name and logs how
 * each one is settled (style, pinned name, gas limit).
 *
 * Every variable is documented in src/facilitator-env.ts. The facilitator
 * refuses to start on mainnet when the fee-payer key is an owner account
 * (CASCET_OWNER_ACCOUNT_HASH; the CasCet deployer always counts) or a seller,
 * or when it is an associated key of one of them, and anywhere when a token's
 * on-chain ABI or name contradicts its configured style or name.
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
    // Per asset: declared style, pinned name and version, gas limit.
    assets: cfg.assets,
    ownerAccountHashes: cfg.ownerAccountHashes,
    dailyGasCapMotes: cfg.dailyGasCapMotes,
    settleWaitMs: cfg.settleWaitMs,
    preflight: cfg.preflight,
    preflightDeadlineMs: cfg.preflightDeadlineMs,
  });
  console.log(`facilitator up at ${fac.url} (net=${fac.network})`);
  // A running /settle may already have submitted a transaction: the first
  // signal lets running requests finish and answer (new ones get 503); a
  // second one exits at once. Give a process manager about 90 s to stop it.
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) {
      console.warn(`[run-facilitator] ${signal} again: exiting now; reconcile unfinished settlements by transaction hash or nonce`);
      process.exit(1);
    }
    stopping = true;
    console.log(`[run-facilitator] ${signal}: finishing running /verify and /settle requests, then exiting (repeat to exit at once)`);
    fac.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (err) {
  console.error(`[run-facilitator] refusing to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
