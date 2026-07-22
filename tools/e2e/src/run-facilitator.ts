import { resolve } from "node:path";
import { startRealFacilitator } from "./real-facilitator.js";

/**
 * Run the self-hosted x402 facilitator standalone (for the Python client demo,
 * or any external client). Testnet by default; CASCET_NET=mainnet for mainnet.
 *
 *   pnpm --filter @cascet/e2e facilitator
 */
const ROOT = resolve(import.meta.dirname, "../../..");
const mainnet = process.env.CASCET_NET === "mainnet";
const network = mainnet ? "casper:casper" : "casper:casper-test";
const rpcUrl = mainnet ? "https://node.mainnet.casper.network/rpc" : "https://node.testnet.casper.network/rpc";
const keyPath = mainnet
  ? resolve(ROOT, "contracts/keys/mainnet_deployer_secret_key.pem")
  : resolve(ROOT, "contracts/keys/deployer_secret_key.pem");
const token = mainnet
  ? "hash-8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41"
  : "hash-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
const seller = mainnet
  ? "00b9a38c827771d6bc510dd5f1e24fee61acdd4f97f758f4d68fe1dea13a7a140d"
  : "00881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36";

const fac = await startRealFacilitator({
  port: Number(process.env.PORT ?? 4501),
  network,
  keyPath,
  keyAlgo: "ed25519",
  rpcUrl,
  allowedPayTo: [seller],
  allowedAssets: [token],
});
console.log(`facilitator up at ${fac.url} (net=${network})`);
process.on("SIGINT", () => { fac.close(); process.exit(0); });
process.on("SIGTERM", () => { fac.close(); process.exit(0); });
