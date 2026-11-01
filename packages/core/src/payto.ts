import { z } from "zod";

/** How to turn a Casper public key into the payee value CasCet expects. */
export const ACCOUNT_HASH_HINT =
  'run "npx @cascet/cli account-hash <public-key>" and use the "00"-prefixed value it prints';

const ACCOUNT_HASH_KEY = /^00([0-9a-f]{64})$/;
const ACCOUNT_HASH_FORMATTED = /^account-hash-([0-9a-f]{64})$/;
const CONTRACT_PACKAGE_FORMATTED = /^(?:hash|package-hash)-([0-9a-f]{64})$/;
const ED25519_PUBLIC_KEY = /^01[0-9a-f]{64}$/;
const SECP256K1_PUBLIC_KEY = /^02[0-9a-f]{66}$/;

/**
 * Normalize a payee (`payTo`) into the serialized Casper Key that the x402
 * exact-on-Casper scheme signs over:
 *
 * - account hash: `"00" + 64 hex` or `"account-hash-<64 hex>"` → `"00" + hex`
 * - contract package (e.g. a RevenueSplit): `"hash-<64 hex>"` or
 *   `"package-hash-<64 hex>"` → `"01" + hex`
 *
 * Hex is lower-cased. A Casper PUBLIC KEY (`"01" + 64 hex` for ed25519,
 * `"02" + 66 hex` for secp256k1) is rejected with a hint: casper-x402 accepts
 * the ed25519 form structurally, but settlement converts those bytes into an
 * account hash nobody controls, so the payment would be lost.
 *
 * @throws Error with a user-facing message when the value is not a valid payee.
 */
export function normalizePayTo(input: string): string {
  const value = input.trim().toLowerCase();
  let match = ACCOUNT_HASH_KEY.exec(value) ?? ACCOUNT_HASH_FORMATTED.exec(value);
  if (match) return `00${match[1]}`;
  match = CONTRACT_PACKAGE_FORMATTED.exec(value);
  if (match) return `01${match[1]}`;
  if (ED25519_PUBLIC_KEY.test(value) || SECP256K1_PUBLIC_KEY.test(value)) {
    throw new Error(
      `payTo ${show(input)} is a Casper public key, not an account hash; a payment to it would be credited ` +
        `to an account nobody controls. To get the payee value for this key, ${ACCOUNT_HASH_HINT}. ` +
        `(A contract-package payee is written "hash-<64 hex>".)`,
    );
  }
  throw new Error(
    `payTo must be an account hash ("00" + 64 hex, or "account-hash-<64 hex>") or a contract package ` +
      `("hash-<64 hex>" or "package-hash-<64 hex>"); got ${show(input)}. For a public key, ${ACCOUNT_HASH_HINT}.`,
  );
}

/** True when `input` is accepted by {@link normalizePayTo}. */
export function isValidPayTo(input: string): boolean {
  try {
    normalizePayTo(input);
    return true;
  } catch {
    return false;
  }
}

/** Zod schema for a config `payTo`: validates and normalizes with {@link normalizePayTo}. */
export const payToSchema = z.string().transform((value, ctx) => {
  try {
    return normalizePayTo(value);
  } catch (err) {
    ctx.addIssue({ code: "custom", message: err instanceof Error ? err.message : String(err) });
    return z.NEVER;
  }
});

function show(value: string): string {
  const trimmed = value.trim();
  return JSON.stringify(trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed);
}
