import casperSdk from "casper-js-sdk";
import { normalizePayTo } from "@cascet/core";

const { PublicKey } = casperSdk;

const PUBLIC_KEY_HEX = /^(01[0-9a-f]{64}|02[0-9a-f]{66})$/;
const ACCOUNT_HASH = /^(00|account-hash-)[0-9a-f]{64}$/;

/**
 * The payee value for a Casper public key: `"00" + account hash`, which is what
 * `payTo` and `CASCET_ALLOWED_PAYTO` expect. Accepts an ed25519 (`"01" + 64 hex`)
 * or secp256k1 (`"02" + 66 hex`) public key in any letter case. An account hash
 * that is passed in already is returned in normalized form.
 */
export function accountHashFromPublicKey(publicKeyHex: string): string {
  const value = publicKeyHex.trim().toLowerCase();
  if (ACCOUNT_HASH.test(value)) return normalizePayTo(value);
  if (!PUBLIC_KEY_HEX.test(value)) {
    throw new Error(
      `expected a Casper public key: "01" + 64 hex (ed25519) or "02" + 66 hex (secp256k1); got ${JSON.stringify(
        publicKeyHex.trim().slice(0, 80),
      )}`,
    );
  }
  let key: InstanceType<typeof PublicKey>;
  try {
    key = PublicKey.fromHex(value);
  } catch (err) {
    throw new Error(`invalid Casper public key: ${err instanceof Error ? err.message : String(err)}`);
  }
  return `00${key.accountHash().toHex()}`;
}
