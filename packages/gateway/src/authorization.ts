/**
 * The CEP-3009 transfer authorization inside an x402 "exact" Casper payment
 * payload, parsed and normalized so the gateway can apply its own checks
 * (replay, price, payee, validity window) before it asks the facilitator.
 */
export interface CasperAuthorization {
  /** Payer address: "00" + account hash (or "01" + package hash), lowercase hex. */
  from: string;
  /** Payee address, same encoding as `from`. */
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

const ADDRESS = /^(00|01)[0-9a-f]{64}$/;
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

/** Extract and validate the authorization of an x402 v2 Casper "exact" payment payload. */
export function parseCasperAuthorization(paymentPayload: unknown): AuthorizationParse {
  if (typeof paymentPayload !== "object" || paymentPayload === null) {
    return { ok: false, reason: "invalid_payload: not an object" };
  }
  const envelope = paymentPayload as { x402Version?: unknown; payload?: unknown };
  if (envelope.x402Version !== 2) {
    return { ok: false, reason: "invalid_payload: only x402Version 2 payments are accepted" };
  }
  const inner = envelope.payload as { authorization?: unknown } | undefined;
  const auth = (typeof inner === "object" && inner !== null ? inner.authorization : undefined) as
    | Record<string, unknown>
    | undefined;
  if (typeof auth !== "object" || auth === null) {
    return { ok: false, reason: "invalid_payload: missing authorization" };
  }

  const from = normalizeHex(str(auth.from) ?? "");
  const to = normalizeHex(str(auth.to) ?? "");
  const value = str(auth.value) ?? "";
  const validAfter = str(auth.validAfter) ?? "";
  const validBefore = str(auth.validBefore) ?? "";
  const nonce = normalizeHex(str(auth.nonce) ?? "");

  if (!ADDRESS.test(from)) return { ok: false, reason: "invalid_payload: authorization.from is not a Casper address" };
  if (!ADDRESS.test(to)) return { ok: false, reason: "invalid_payload: authorization.to is not a Casper address" };
  if (!UINT256.test(value) || BigInt(value) === 0n) {
    return { ok: false, reason: "invalid_payload: authorization.value must be a positive integer" };
  }
  if (!UNIX_SECONDS.test(validAfter) || !UNIX_SECONDS.test(validBefore)) {
    return { ok: false, reason: "invalid_payload: authorization validity bounds must be unix seconds" };
  }
  if (!NONCE.test(nonce)) return { ok: false, reason: "invalid_payload: authorization.nonce must be 32 bytes of hex" };

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
