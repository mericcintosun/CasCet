import casperSdk from "casper-js-sdk";

/**
 * The CEP-3009 transfer authorization inside an x402 "exact" Casper payment
 * payload, parsed and normalized so the gateway can apply its own checks
 * (replay, price, payee, validity window) before it asks the facilitator.
 */
export interface CasperAuthorization {
  /** Payer account: "00" + account hash, lowercase hex. Only accounts sign authorizations. */
  from: string;
  /** Payee address: "00" + account hash or "01" + package hash, lowercase hex. */
  to: string;
  /** Raw token units, decimal string. */
  value: string;
  /** Unix seconds. */
  validAfter: number;
  /** Unix seconds. */
  validBefore: number;
  /** 32-byte nonce, lowercase hex without 0x. */
  nonce: string;
}

export type AuthorizationParse = { ok: true; authorization: CasperAuthorization } | { ok: false; reason: string };

const ACCOUNT = /^00[0-9a-f]{64}$/;
const ADDRESS = /^(00|01)[0-9a-f]{64}$/;
// Casper public keys: tag 01 + 32-byte ed25519 key, or tag 02 + 33-byte compressed secp256k1 key.
const PUBLIC_KEY = /^(?:01[0-9a-f]{64}|02[0-9a-f]{66})$/;
// Casper signatures: the signing key's algorithm tag + 64 bytes.
const SIGNATURE = /^(?:01|02)[0-9a-f]{128}$/;
const NONCE = /^[0-9a-f]{64}$/;
const UINT256 = /^\d{1,78}$/;
const UNIX_SECONDS = /^\d{1,12}$/;

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Normalize a Casper address / hash string: lowercase, no 0x prefix. */
export function normalizeHex(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, "");
}

/**
 * Canonical "00" + account hash form of an account address given as
 * "00<hex>", "account-hash-<hex>" or "0x00<hex>" (any case). Anything else is
 * returned lowercased, so it never equals a canonical address by accident.
 */
export function normalizeAccountAddress(value: string): string {
  const hex = normalizeHex(value);
  const prefixed = /^account-hash-([0-9a-f]{64})$/.exec(hex);
  return prefixed ? `00${prefixed[1]}` : hex;
}

/** Account hash (64 lowercase hex) of a Casper public key, or undefined when it is not a valid key. */
function accountHashOf(publicKeyHex: string): string | undefined {
  try {
    return casperSdk.PublicKey.fromHex(publicKeyHex).accountHash().toHex().toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Extract and validate the authorization of an x402 v2 Casper "exact" payment
 * payload.
 *
 * Besides the shape, this refuses authorizations that @make-software/casper-x402
 * 1.0.0 verifies but that can never settle, so they never get a free run in
 * run-then-settle mode:
 * - `from` must be an account ("00" tag). The facilitator only compares the
 *   hash part with the public key's account hash, but settles `from` as an
 *   account-hash key, so the tag the buyer signed over must be "00".
 * - The signature's algorithm tag must equal the public key's. casper-js-sdk
 *   drops the tag byte when it verifies, while the token checks it on-chain.
 * - The public key must belong to `from`.
 */
export function parseCasperAuthorization(paymentPayload: unknown): AuthorizationParse {
  if (typeof paymentPayload !== "object" || paymentPayload === null) {
    return { ok: false, reason: "invalid_payload: not an object" };
  }
  const envelope = paymentPayload as { x402Version?: unknown; payload?: unknown };
  if (envelope.x402Version !== 2) {
    return { ok: false, reason: "invalid_payload: only x402Version 2 payments are accepted" };
  }
  const inner = (typeof envelope.payload === "object" && envelope.payload !== null ? envelope.payload : {}) as {
    authorization?: unknown;
    signature?: unknown;
    publicKey?: unknown;
  };
  const auth = inner.authorization as Record<string, unknown> | undefined;
  if (typeof auth !== "object" || auth === null) {
    return { ok: false, reason: "invalid_payload: missing authorization" };
  }

  const from = normalizeHex(str(auth.from) ?? "");
  const to = normalizeHex(str(auth.to) ?? "");
  const value = str(auth.value) ?? "";
  const validAfter = str(auth.validAfter) ?? "";
  const validBefore = str(auth.validBefore) ?? "";
  const nonce = normalizeHex(str(auth.nonce) ?? "");
  const signature = normalizeHex(str(inner.signature) ?? "");
  const publicKey = normalizeHex(str(inner.publicKey) ?? "");

  if (!ACCOUNT.test(from)) {
    return {
      ok: false,
      reason: 'invalid_payload: authorization.from must be an account address ("00" + 64 hex); only accounts sign authorizations',
    };
  }
  if (!ADDRESS.test(to)) return { ok: false, reason: "invalid_payload: authorization.to is not a Casper address" };
  if (!UINT256.test(value) || BigInt(value) === 0n) {
    return { ok: false, reason: "invalid_payload: authorization.value must be a positive integer" };
  }
  if (!UNIX_SECONDS.test(validAfter) || !UNIX_SECONDS.test(validBefore)) {
    return { ok: false, reason: "invalid_payload: authorization validity bounds must be unix seconds" };
  }
  if (!NONCE.test(nonce)) return { ok: false, reason: "invalid_payload: authorization.nonce must be 32 bytes of hex" };
  if (!PUBLIC_KEY.test(publicKey)) {
    return { ok: false, reason: "invalid_payload: publicKey must be a Casper public key (01 + 32 bytes or 02 + 33 bytes)" };
  }
  if (!SIGNATURE.test(signature)) {
    return { ok: false, reason: "invalid_payload: signature must be 65 bytes (algorithm tag + 64 bytes)" };
  }
  if (signature.slice(0, 2) !== publicKey.slice(0, 2)) {
    return { ok: false, reason: "invalid_payload: the signature's algorithm tag does not match the public key's" };
  }
  if (accountHashOf(publicKey) !== from.slice(2)) {
    return { ok: false, reason: "invalid_payload: publicKey does not belong to authorization.from" };
  }

  return {
    ok: true,
    authorization: {
      from,
      to,
      value,
      validAfter: Number(validAfter),
      validBefore: Number(validBefore),
      nonce,
    },
  };
}
