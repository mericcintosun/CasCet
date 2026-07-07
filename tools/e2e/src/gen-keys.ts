import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import casperSdk from "casper-js-sdk";

const { PrivateKey, KeyAlgorithm } = casperSdk;

/**
 * Generate throwaway ed25519 wallets for the local demo:
 *  - agent: the root buyer (plays "Claude's wallet")
 *  - analyst: portfolio-analyst server's wallet (buys data downstream)
 *  - seller-data / seller-analyst: payees for the two gateways
 */
const KEYS_DIR = resolve(import.meta.dirname, "../keys");
mkdirSync(KEYS_DIR, { recursive: true });

for (const name of ["agent", "analyst", "seller-data", "seller-analyst"]) {
  const pemPath = resolve(KEYS_DIR, `${name}.pem`);
  if (existsSync(pemPath)) {
    console.log(`skip ${name} (exists)`);
    continue;
  }
  const key = PrivateKey.generate(KeyAlgorithm.ED25519);
  writeFileSync(pemPath, key.toPem(), { mode: 0o600 });
  writeFileSync(resolve(KEYS_DIR, `${name}.pub`), key.publicKey.toHex());
  console.log(`✅ ${name}: ${key.publicKey.toHex()}`);
}
