import { readFileSync, statSync } from "node:fs";
import casperSdk from "casper-js-sdk";

/**
 * Loading Casper secret keys from PEM files for the facilitator and the
 * real-settlement demos. The key material is never logged or returned as
 * text; only the key object (to sign) or its public account hash leaves here.
 */

export type KeyAlgo = "ed25519" | "secp256k1";

/** Load a secret key PEM; `label` names the role in error messages (e.g. "fee-payer"). */
export function loadSecretKeyFile(path: string, algo: KeyAlgo, label: string, warn?: (message: string) => void) {
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read the ${label} key file ${path}: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
  }
  try {
    if ((statSync(path).mode & 0o077) !== 0) {
      warn?.(`${label} key file ${path} is readable by group/others; run: chmod 600 ${path}`);
    }
  } catch {
    /* permissions are advisory */
  }
  const algorithm = algo === "secp256k1" ? casperSdk.KeyAlgorithm.SECP256K1 : casperSdk.KeyAlgorithm.ED25519;
  try {
    return casperSdk.PrivateKey.fromPem(pem, algorithm);
  } catch {
    throw new Error(`the ${label} key file ${path} is not a valid ${algo} PEM`);
  }
}

/** Account hash (bare 64 hex) of the key in a PEM file. */
export function accountHashOfKeyFile(path: string, algo: KeyAlgo, label: string, warn?: (message: string) => void): string {
  return loadSecretKeyFile(path, algo, label, warn).publicKey.accountHash().toHex();
}
