import type { Network, PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import {
  AUTHORIZATION_STYLE_EXTRA_KEY,
  DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE,
  isKnownCep3009Asset,
  isLegacyAmountToken,
  type AuthorizationStyle,
} from "@cascet/core";
import { TokenStateError, TokenUnsupportedError, type TokenProbe } from "@cascet/gateway";
import type { AuthorizationId, AuthorizationLedger } from "./authorization-ledger.js";
import type { DailyGasBudget } from "./gas-budget.js";
import {
  AMOUNT_ARGUMENT_BY_STYLE,
  type BuiltTransaction,
  type ExecutionOutcome,
  type SettlementChain,
  type SettlementInput,
  type SubmitOutcome,
} from "./settlement.js";

/**
 * Policy core of the self-hosted facilitator: everything between "the HTTP
 * request was authenticated and rate-limited" and "a settlement transaction
 * is on chain". It is transport-free and dependency-injected, so every rule
 * is unit-tested without a node or a key.
 *
 * It settles both authorization styles, per asset ({@link AssetPolicy}): CasCet's
 * x402 token (`legacy-amount`, runtime argument `amount`) and CEP-3009 tokens
 * such as the official Wrapped CSPR (`cep3009-value`, argument `value`). Buyers
 * sign both the same way; the style only decides the argument name of the
 * settlement transaction, and it is never taken from the request: the token's
 * on-chain ABI is read (cached) on every request and must agree with the
 * style the asset is configured or pinned with.
 *
 * Both /verify and /settle run the FULL check list (M21): request shape,
 * asset and payee allowlists, the asset's pinned EIP-712 domain (name,
 * version), CEP-3009 field formats (payer and payee must be account-hash Keys,
 * publicKey and signature algorithm tags must match), a validity window that
 * still leaves time to settle before validBefore, the signature check, the
 * in-flight nonce ledger (M09), and an on-chain preflight (the token's ABI
 * style and chain_name, nonce not used, balance covers the value plus
 * everything already in flight, EIP-712 domain name equals the token's
 * on-chain name). The validity window is checked again after the preflight,
 * because the reads can take seconds. /settle then caps the transaction's TTL
 * at the authorization's validBefore, builds it in the token's style with the
 * asset's own gas limit, reserves that gas only right before submission (M08)
 * and never reports a failure for a transaction whose outcome is merely
 * unknown (M22).
 *
 * HTTP statuses: every verdict about a payment, including allowlist and
 * duplicate rejections, is HTTP 200 with `isValid: false` / `success: false`
 * (what x402 facilitator clients expect). Only conditions that a later retry
 * can clear answer 503: the token state could not be read, the ledger is
 * full, or the daily gas cap is reached.
 */

/** Machine-readable reasons returned in `invalidReason` / `errorReason`. */
export const Reason = {
  invalidRequest: "invalid_request",
  unsupportedVersion: "unsupported_x402_version",
  unsupportedScheme: "unsupported_scheme",
  unsupportedNetwork: "unsupported_network",
  unauthorized: "unauthorized",
  rateLimited: "rate_limited",
  payToNotAllowlisted: "payto_not_allowlisted",
  assetNotAllowlisted: "asset_not_allowlisted",
  invalidAsset: "invalid_asset",
  unsupportedAsset: "unsupported_asset",
  authorizationStyleMismatch: "authorization_style_mismatch",
  invalidPayTo: "invalid_payto",
  invalidPayer: "invalid_payer",
  payToMismatch: "payto_mismatch",
  invalidAmount: "invalid_amount",
  invalidValidity: "invalid_validity_window",
  validityTooLong: "validity_window_too_long",
  notYetValid: "authorization_not_yet_valid",
  expired: "authorization_expired",
  expiresTooSoon: "authorization_expires_too_soon",
  invalidNonce: "invalid_nonce",
  invalidPublicKey: "invalid_public_key",
  invalidSignature: "invalid_signature",
  algorithmMismatch: "signature_algorithm_mismatch",
  tokenDomainMismatch: "token_domain_mismatch",
  duplicateNonce: "duplicate_nonce",
  nonceAlreadyUsed: "nonce_already_used",
  insufficientFunds: "insufficient_funds",
  preflightUnavailable: "preflight_unavailable",
  busy: "facilitator_busy",
  shuttingDown: "facilitator_shutting_down",
  gasCapReached: "daily_gas_cap_reached",
  buildFailed: "settlement_build_failed",
  rejectedByNode: "settlement_rejected",
  failedOnChain: "settlement_failed",
  pending: "settlement_pending",
  unknown: "settlement_unknown",
  internal: "internal_error",
} as const;

/**
 * `extra.settlementStatus` on every /settle response:
 *  - not_submitted: this request submitted nothing, and this facilitator holds
 *                   no transaction for the authorization (determinate: this
 *                   request did not and will not charge the payer)
 *  - duplicate:     this request submitted nothing because the authorization is
 *                   already known: being settled or settled by an earlier
 *                   request here (`duplicate_nonce`, `transaction` = that
 *                   earlier submission when there is one), or its nonce is
 *                   already used on-chain (`nonce_already_used`). The earlier
 *                   transaction may have charged the payer: reconcile by its
 *                   hash or by the nonce instead of treating this as a failure
 *  - success:       the transfer executed (determinate)
 *  - failed:        the transaction executed and reverted; nothing moved (determinate)
 *  - pending:       accepted by the node, execution not observed before the deadline
 *  - unknown:       the outcome is indeterminate (ambiguous submission the node
 *                   never showed, or an internal error on the /settle route)
 * For pending/unknown the response carries the transaction hash when one
 * exists; reconcile it over RPC (`info_get_transaction`, or the token's
 * `used_nonces`) before treating the payment as failed.
 */
export type SettlementStatus = "not_submitted" | "duplicate" | "success" | "failed" | "pending" | "unknown";

export interface CoreResult<T> {
  status: number;
  body: T;
}

export interface FacilitatorLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * How this facilitator settles one asset. Built at start-up from the
 * configuration and the token's on-chain state (see real-facilitator.ts).
 */
export interface AssetPolicy {
  /** Contract package hash, bare lower-case 64 hex. */
  asset: string;
  /**
   * The style this facilitator settles the asset with: configured, known
   * (CasCet's own token), or read from the token's ABI at start-up. Every
   * request reads the ABI again (cached) and refuses the payment when the
   * chain disagrees. Undefined only without an asset allowlist, for a token
   * CasCet does not know: then the chain decides.
   */
  style?: AuthorizationStyle;
  /** Pinned EIP-712 domain name (`extra.name`), checked without RPC; undefined = only the on-chain name. */
  name?: string;
  /** Pinned EIP-712 domain version (`extra.version`). */
  version: string;
  /** Gas limit (motes) of each settlement of this asset; undefined = the style's default. */
  paymentMotes?: bigint;
}

export interface FacilitatorCoreConfig {
  network: Network;
  /** Allowed payees, normalized "00" + 64 hex. Undefined = any (testnet only). */
  allowedPayTo?: string[];
  /**
   * The assets this facilitator settles, each with its own style, domain pins
   * and gas limit. Undefined = any asset (testnet only), with `anyAsset`'s
   * domain pins and the style the token's ABI shows.
   */
  assets?: readonly AssetPolicy[];
  /** Domain pins applied to every asset when there is no asset allowlist. Version default "1". */
  anyAsset?: { name?: string; version?: string };
  /** Gas limit per style for assets without their own. Default DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE. */
  paymentMotesByStyle?: Readonly<Record<AuthorizationStyle, bigint>>;
  /** Total time /settle may spend before answering "pending" with the hash. */
  settleWaitMs: number;
  /** Reject authorizations valid for longer than this (bounds ledger retention). */
  maxValiditySeconds: number;
  /**
   * Reject authorizations that expire sooner than this, at /verify and at
   * /settle. Default {@link DEFAULT_MIN_SETTLE_WINDOW_SECONDS}.
   */
  minSettleWindowSeconds?: number;
  /**
   * Total time the on-chain preflight of one request may take (all its reads,
   * retries included). Default {@link DEFAULT_PREFLIGHT_DEADLINE_MS}.
   */
  preflightDeadlineMs?: number;
}

/**
 * The gateway gives /verify 15 s by default (timeouts.facilitatorMs). Without
 * one overall deadline, three sequential reads (package, contract, item) with an
 * 8 s timeout and one retry each could take about 48 s, and the verify would
 * finish (and hold the payer's value as in flight) after the gateway gave up.
 */
export const DEFAULT_PREFLIGHT_DEADLINE_MS = 10_000;

/**
 * casper-x402 1.0.0 settles an authorization that is valid for 6 more seconds.
 * Casper produces a block every 8 s (chainspec minimum_block_time) and recorded
 * settles were included 4–10 s after submission, so a transaction submitted
 * that late is likely to execute after validBefore, revert, and burn its gas.
 */
export const DEFAULT_MIN_SETTLE_WINDOW_SECONDS = 20;

/**
 * A settlement transaction expires (TTL) at least this long before its
 * authorization does. A Casper block may only include a transaction while
 * block time ≤ transaction timestamp + TTL, so the transfer can never execute
 * at or after validBefore: the node drops a late transaction instead of
 * executing it, reverting, and burning the gas limit.
 */
export const TX_EXPIRY_MARGIN_MS = 2_000;

/**
 * TTL for a settlement transaction built at `nowMs`: the chain's maximum, but
 * never past validBefore − {@link TX_EXPIRY_MARGIN_MS}. Whole seconds, because
 * the node parses the TTL as a duration string ("4m 57s", not "4m 57.345s").
 */
export function settlementTtlMs(validBeforeSec: number, nowMs: number, maxTtlMs: number): number {
  const untilExpiry = validBeforeSec * 1000 - nowMs - TX_EXPIRY_MARGIN_MS;
  return Math.max(0, Math.floor(Math.min(maxTtlMs, untilExpiry) / 1000) * 1000);
}

/** Below this TTL a settlement is not worth submitting (less than one block). */
const MIN_TX_TTL_MS = 1_000;

/** Default gas limit per style, as bigint motes (see DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE in @cascet/core). */
export const DEFAULT_PAYMENT_MOTES_BY_STYLE: Readonly<Record<AuthorizationStyle, bigint>> = Object.freeze({
  "legacy-amount": BigInt(DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE["legacy-amount"]),
  "cep3009-value": BigInt(DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE["cep3009-value"]),
});

/**
 * The style of a token CasCet knows without reading the chain: its own x402
 * token on either network (`legacy-amount`) or a known CEP-3009 token such as
 * the official Wrapped CSPR (`cep3009-value`). Undefined for any other token.
 */
export function knownAuthorizationStyle(network: string, asset: string): AuthorizationStyle | undefined {
  if (isLegacyAmountToken(asset)) return "legacy-amount";
  if (isKnownCep3009Asset(network, asset)) return "cep3009-value";
  return undefined;
}

/** The token reads the preflight needs (a TokenProbe; a fake in tests). */
export type TokenStateReader = Pick<TokenProbe, "authorizationStyle" | "balanceOf" | "isNonceUsed" | "tokenName" | "chainName">;

export interface FacilitatorCoreDeps {
  /** Cryptographic verification (EIP-712 digest, signature, pubkey ↔ payer). */
  verifySignature(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  /** On-chain reads; undefined disables the preflight. Its clock must be `now` (deadlines are absolute). */
  tokenState?: TokenStateReader;
  chain: SettlementChain;
  ledger: AuthorizationLedger;
  gas: DailyGasBudget;
  log: FacilitatorLogger;
  now(): number;
}

export interface ParsedPayment {
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
  publicKey: string;
  signature: string;
}

export type ParseResult = { ok: true; value: ParsedPayment } | { ok: false; status: number; reason: string; message: string };

/** Authorization fields after validation and normalization (lowercase hex). */
export interface CheckedAuthorization extends SettlementInput {
  payTo: string;
}

interface Rejection {
  status: number;
  reason: string;
  message: string;
  /** For duplicates: the transaction this facilitator already submitted for the nonce. */
  existingTransaction?: string;
  /** `extra.settlementStatus` when /settle answers with this rejection (default not_submitted). */
  settlementStatus?: SettlementStatus;
}

const MAX_FIELD = 200;
const HEX64 = /^[0-9a-f]{64}$/;
const ACCOUNT_KEY = /^00[0-9a-f]{64}$/;
const PUBLIC_KEY = /^(01[0-9a-f]{64}|02[0-9a-f]{66})$/;
const SIGNATURE = /^[0-9a-f]{130}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const U256_MAX = (1n << 256n) - 1n;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isShortString = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_FIELD;
const short = (hex: string) => `${logText(hex).slice(0, 10)}…`;

/** Is there still time to settle an authorization that expires at `validBefore`? */
function windowRejection(validBefore: number, nowSec: number, minWindowSeconds: number): Rejection | undefined {
  if (validBefore <= nowSec) return { status: 200, reason: Reason.expired, message: "authorization expired" };
  if (validBefore - nowSec < minWindowSeconds) {
    return {
      status: 200,
      reason: Reason.expiresTooSoon,
      message: `authorization must stay valid for at least ${minWindowSeconds}s to be settled in time`,
    };
  }
  return undefined;
}

/** Single-line, bounded text for log lines (no CR/LF from remote data). */
export function logText(value: unknown): string {
  const s = value instanceof Error ? value.message : String(value);
  return s.replace(/[\r\n\u2028\u2029]+/g, " ").slice(0, 300);
}

/**
 * Contract-package payees ("01" + hash, configured as hash-… / package-hash-…)
 * are refused: casper-x402 1.0.0 and MAKE's Go facilitator always settle to
 * Key::Account, and no testnet settle has shown the CasCet token crediting a
 * Key::Hash payee. Refusing up front costs nothing; a wrong guess would revert
 * every settle and burn its gas.
 */
const CONTRACT_PAYEE_UNSUPPORTED = "contract-package payees (01…, hash-…, package-hash-…) are not supported by this facilitator";

/** Normalize an allowlist payee entry to "00" + 64 hex. */
export function normalizePayTo(entry: string): string {
  const s = entry.trim().toLowerCase().replace(/^0x/, "");
  if (s.startsWith("account-hash-") && HEX64.test(s.slice(13))) return `00${s.slice(13)}`;
  if (ACCOUNT_KEY.test(s)) return s;
  if (/^(hash-|package-hash-|contract-package-)[0-9a-f]{64}$/.test(s)) throw new Error(`${CONTRACT_PAYEE_UNSUPPORTED}: ${entry.slice(0, 80)}`);
  throw new Error(`payee must be an account hash ("00" + 64 hex or account-hash-<hex>): ${entry.slice(0, 80)}`);
}

/** Normalize an allowlist asset entry to a bare 64-hex package hash. */
export function normalizeAsset(entry: string): string {
  const s = entry.trim().toLowerCase().replace(/^(hash-|contract-package-|package-|0x)/, "");
  if (HEX64.test(s)) return s;
  throw new Error(`asset must be a contract package hash (64 hex, optionally hash-…): ${entry.slice(0, 80)}`);
}

/** Validate the shape of a /verify or /settle body (HTTP 400 when malformed). */
export function parsePaymentRequest(body: unknown, network: Network): ParseResult {
  const bad = (message: string, reason: string = Reason.invalidRequest): ParseResult => ({ ok: false, status: 400, reason, message });
  if (!isObject(body)) return bad("body must be a JSON object");
  const { paymentPayload, paymentRequirements } = body;
  if (!isObject(paymentPayload) || !isObject(paymentRequirements)) return bad("paymentPayload and paymentRequirements are required");
  if (paymentPayload["x402Version"] !== 2) return bad("only x402Version 2 is supported", Reason.unsupportedVersion);

  const accepted = paymentPayload["accepted"];
  if (!isObject(accepted) || !isShortString(accepted["scheme"]) || !isShortString(accepted["network"])) {
    return bad("paymentPayload.accepted.scheme and .network are required");
  }
  const req = paymentRequirements;
  for (const field of ["scheme", "network", "asset", "amount", "payTo"]) {
    if (!isShortString(req[field])) return bad(`paymentRequirements.${field} must be a non-empty string`);
  }
  if (req["extra"] !== undefined && !isObject(req["extra"])) return bad("paymentRequirements.extra must be an object");
  if (req["scheme"] !== "exact" || accepted["scheme"] !== "exact") return bad("only the exact scheme is supported", Reason.unsupportedScheme);
  if (req["network"] !== network) return bad(`this facilitator settles on ${network} only`, Reason.unsupportedNetwork);

  const inner = paymentPayload["payload"];
  if (!isObject(inner) || !isShortString(inner["signature"]) || !isShortString(inner["publicKey"])) {
    return bad("paymentPayload.payload.signature and .publicKey are required");
  }
  const auth = inner["authorization"];
  if (!isObject(auth)) return bad("paymentPayload.payload.authorization is required");
  for (const field of ["from", "to", "value", "validAfter", "validBefore", "nonce"]) {
    if (!isShortString(auth[field])) return bad(`authorization.${field} must be a non-empty string`);
  }

  return {
    ok: true,
    value: {
      payload: paymentPayload as unknown as PaymentPayload,
      requirements: { ...(req as unknown as PaymentRequirements), extra: (req["extra"] as Record<string, unknown> | undefined) ?? {} },
      authorization: {
        from: auth["from"] as string,
        to: auth["to"] as string,
        value: auth["value"] as string,
        validAfter: auth["validAfter"] as string,
        validBefore: auth["validBefore"] as string,
        nonce: auth["nonce"] as string,
      },
      publicKey: inner["publicKey"] as string,
      signature: inner["signature"] as string,
    },
  };
}

/**
 * The policy an asset is settled with: its entry in the allowlist, or (without
 * an asset allowlist, testnet only) the open policy with `anyAsset`'s pins and
 * the style CasCet knows for the token, if any. Undefined = not allowlisted.
 */
export function assetPolicyFor(config: FacilitatorCoreConfig, asset: string): AssetPolicy | undefined {
  if (config.assets) return config.assets.find(policy => policy.asset === asset);
  const style = knownAuthorizationStyle(config.network, asset);
  return {
    asset,
    ...(style ? { style } : {}),
    ...(config.anyAsset?.name !== undefined ? { name: config.anyAsset.name } : {}),
    version: config.anyAsset?.version ?? "1",
  };
}

/** Policy and CEP-3009 format checks that need no signature or chain access. */
export function checkAuthorization(
  p: ParsedPayment,
  config: FacilitatorCoreConfig,
  nowSec: number,
): { ok: true; auth: CheckedAuthorization; policy: AssetPolicy } | { ok: false; rejection: Rejection } {
  const reject = (reason: string, message: string) => ({ ok: false as const, rejection: { status: 200, reason, message } });
  const req = p.requirements;
  const a = p.authorization;

  const asset = req.asset.toLowerCase().replace(/^hash-/, "");
  if (!HEX64.test(asset)) return reject(Reason.invalidAsset, "asset must be a 64-hex contract package hash");
  const policy = assetPolicyFor(config, asset);
  if (!policy) return reject(Reason.assetNotAllowlisted, "asset not allowlisted");

  const payTo = req.payTo.toLowerCase();
  if (!ACCOUNT_KEY.test(payTo)) {
    return reject(
      Reason.invalidPayTo,
      /^01[0-9a-f]{64}$/.test(payTo) ? `${CONTRACT_PAYEE_UNSUPPORTED}; payTo must be 00 + 64 hex` : "payTo must be an account-hash Key: 00 + 64 hex",
    );
  }
  if (config.allowedPayTo && !config.allowedPayTo.includes(payTo)) return reject(Reason.payToNotAllowlisted, "payTo not allowlisted");

  const from = a.from.toLowerCase();
  if (!ACCOUNT_KEY.test(from)) return reject(Reason.invalidPayer, "authorization.from must be an account-hash Key: 00 + 64 hex");
  if (a.to.toLowerCase() !== payTo) return reject(Reason.payToMismatch, "authorization.to does not match payTo");

  if (!UINT.test(a.value) || a.value === "0" || a.value.length > 78 || BigInt(a.value) > U256_MAX) {
    return reject(Reason.invalidAmount, "authorization.value must be a positive canonical decimal U256");
  }
  if (a.value !== req.amount) return reject(Reason.invalidAmount, "authorization.value does not match the required amount");

  if (!UINT.test(a.validAfter) || !UINT.test(a.validBefore) || a.validAfter.length > 12 || a.validBefore.length > 12) {
    return reject(Reason.invalidValidity, "validAfter / validBefore must be unix seconds");
  }
  const validAfter = Number(a.validAfter);
  const validBefore = Number(a.validBefore);
  if (validAfter >= validBefore) return reject(Reason.invalidValidity, "validAfter must be before validBefore");
  // The token refuses an authorization before validAfter: settling it now would revert and burn gas.
  if (validAfter > nowSec) return reject(Reason.notYetValid, "authorization is not valid yet (validAfter is in the future)");
  const late = windowRejection(validBefore, nowSec, config.minSettleWindowSeconds ?? DEFAULT_MIN_SETTLE_WINDOW_SECONDS);
  if (late) return { ok: false, rejection: late };
  if (validBefore - nowSec > config.maxValiditySeconds) {
    return reject(Reason.validityTooLong, `authorization must expire within ${config.maxValiditySeconds}s`);
  }

  const nonce = a.nonce.toLowerCase().replace(/^0x/, "");
  if (!HEX64.test(nonce)) return reject(Reason.invalidNonce, "nonce must be 32 bytes of hex");

  const publicKey = p.publicKey.toLowerCase();
  if (!PUBLIC_KEY.test(publicKey)) return reject(Reason.invalidPublicKey, "publicKey must be an ed25519 (01…) or secp256k1 (02…) key");
  const signature = p.signature.toLowerCase().replace(/^0x/, "");
  if (!SIGNATURE.test(signature)) return reject(Reason.invalidSignature, "signature must be 65 bytes of hex");
  if (signature.slice(0, 2) !== publicKey.slice(0, 2)) {
    return reject(Reason.algorithmMismatch, "signature algorithm tag does not match the public key");
  }

  // The asset's pinned EIP-712 domain: a payment signed for another domain is
  // refused here instead of reverting on-chain and burning the gas limit.
  const extra = req.extra ?? {};
  if (extra["version"] !== policy.version) {
    return reject(Reason.tokenDomainMismatch, `EIP-712 domain version must be "${policy.version}"`);
  }
  if (policy.name !== undefined && extra["name"] !== policy.name) {
    return reject(Reason.tokenDomainMismatch, `EIP-712 domain name must be "${policy.name}"`);
  }

  return {
    ok: true,
    auth: { asset, payTo, from, to: payTo, value: BigInt(a.value), validAfter, validBefore, nonce, publicKey, signature },
    policy,
  };
}

export interface FacilitatorCore {
  verify(p: ParsedPayment): Promise<CoreResult<VerifyResponse>>;
  settle(p: ParsedPayment): Promise<CoreResult<SettleResponse>>;
  supported(): SupportedResponse;
}

export function createFacilitatorCore(config: FacilitatorCoreConfig, deps: FacilitatorCoreDeps): FacilitatorCore {
  const network = config.network;
  const nowSec = () => Math.floor(deps.now() / 1000);
  const idOf = (a: CheckedAuthorization): AuthorizationId => ({ network, asset: a.asset, from: a.from, nonce: a.nonce });
  const minWindowSeconds = config.minSettleWindowSeconds ?? DEFAULT_MIN_SETTLE_WINDOW_SECONDS;
  const paymentMotesByStyle = config.paymentMotesByStyle ?? DEFAULT_PAYMENT_MOTES_BY_STYLE;
  /** The on-chain preflight can take seconds: re-check the window after it, with the clock as it is now. */
  const stillInTime = (a: CheckedAuthorization): Rejection | undefined => windowRejection(a.validBefore, nowSec(), minWindowSeconds);

  const verificationRejected = (r: Rejection, payer?: string): CoreResult<VerifyResponse> => {
    deps.log.warn(`verify rejected: ${logText(r.reason)}${payer ? ` payer=${short(payer)}` : ""}`);
    return { status: r.status, body: { isValid: false, invalidReason: r.reason, invalidMessage: r.message, ...(payer ? { payer } : {}) } };
  };

  const settlementRejected = (r: Rejection, payer?: string): CoreResult<SettleResponse> => {
    deps.log.warn(`settle rejected: ${logText(r.reason)}${payer ? ` payer=${short(payer)}` : ""}`);
    return {
      status: r.status,
      body: {
        success: false,
        errorReason: r.reason,
        errorMessage: r.message,
        // A retried settle learns the hash of the earlier submission, so it can
        // reconcile that transaction instead of treating the payment as failed.
        transaction: r.existingTransaction ?? "",
        network,
        ...(payer ? { payer } : {}),
        extra: { settlementStatus: r.settlementStatus ?? ("not_submitted" satisfies SettlementStatus) },
      },
    };
  };

  const signatureCheck = async (p: ParsedPayment): Promise<Rejection | undefined> => {
    let result: VerifyResponse;
    try {
      result = await deps.verifySignature(p.payload, p.requirements);
    } catch (err) {
      deps.log.error(`signature verification threw: ${logText(err)}`);
      return { status: 200, reason: Reason.invalidSignature, message: "signature verification failed" };
    }
    if (result.isValid) return undefined;
    return { status: 200, reason: result.invalidReason ?? Reason.invalidSignature, message: result.invalidMessage ?? "invalid payment" };
  };

  type Preflight = { ok: true; balance?: bigint; style: AuthorizationStyle } | { ok: false; rejection: Rejection };

  const preflight = async (a: CheckedAuthorization, policy: AssetPolicy, extra: Record<string, unknown>): Promise<Preflight> => {
    const reader = deps.tokenState;
    if (!reader) {
      // Nothing reads the chain: settle in the configured (or known) style only.
      if (policy.style) return { ok: true, style: policy.style };
      return {
        ok: false,
        rejection: {
          status: 200,
          reason: Reason.unsupportedAsset,
          message: "this token's authorization style is unknown without the on-chain preflight; allowlist it with its style",
        },
      };
    }
    // One budget for every read of this preflight, retries included.
    const opts = { deadlineMs: deps.now() + (config.preflightDeadlineMs ?? DEFAULT_PREFLIGHT_DEADLINE_MS) };
    let style: AuthorizationStyle;
    let used: boolean;
    let balance: bigint;
    let name: string | undefined;
    let chainName: string | undefined;
    try {
      [style, used, balance, name, chainName] = await Promise.all([
        reader.authorizationStyle(a.asset, opts), // cached with the token's contract
        reader.isNonceUsed(a.asset, a.from, a.nonce, opts),
        reader.balanceOf(a.asset, a.from, opts),
        reader.tokenName(a.asset, opts), // cached; also catches a pinned name that is wrong
        reader.chainName(a.asset, opts), // cached
      ]);
    } catch (err) {
      if (err instanceof TokenUnsupportedError) {
        // Determinate: the token has no usable transfer_with_authorization.
        deps.log.error(`token ${short(a.asset)} cannot be settled: ${logText(err.message)}`);
        return {
          ok: false,
          rejection: {
            status: 200,
            reason: Reason.unsupportedAsset,
            message: "this token has no CEP-3009 transfer_with_authorization this facilitator can call",
          },
        };
      }
      const detail = err instanceof TokenStateError ? err.message : "unexpected error";
      deps.log.error(`preflight unavailable: ${logText(detail)}`);
      return { ok: false, rejection: { status: 503, reason: Reason.preflightUnavailable, message: "could not read the token state; retry later" } };
    }
    if (policy.style !== undefined && style !== policy.style) {
      // The token was upgraded to another ABI, or the configuration is wrong:
      // either way a settle in the configured style would revert and burn gas.
      deps.log.error(
        `token ${short(a.asset)} now takes \`${AMOUNT_ARGUMENT_BY_STYLE[style]}\` (${style}) but is pinned as ${policy.style}: ` +
          "refusing its payments until the configuration is fixed and the facilitator restarted",
      );
      return {
        ok: false,
        rejection: {
          status: 200,
          reason: Reason.authorizationStyleMismatch,
          message: `the token's transfer_with_authorization takes \`${AMOUNT_ARGUMENT_BY_STYLE[style]}\` (${style}); this facilitator settles it as ${policy.style}`,
        },
      };
    }
    if (chainName !== undefined && chainName !== network) {
      return {
        ok: false,
        rejection: {
          status: 200,
          reason: Reason.tokenDomainMismatch,
          message: `the token's EIP-712 chain_name is "${logText(chainName).slice(0, 40)}", not ${network}`,
        },
      };
    }
    if (used) {
      return {
        ok: false,
        rejection: {
          status: 200,
          reason: Reason.nonceAlreadyUsed,
          message: "this authorization nonce was already used on-chain",
          // Used by an earlier transfer (which charged the payer) or a cancellation.
          settlementStatus: "duplicate",
        },
      };
    }
    if (name !== undefined && extra["name"] !== name) {
      return { ok: false, rejection: { status: 200, reason: Reason.tokenDomainMismatch, message: `EIP-712 domain name must equal the token name "${name}"` } };
    }
    return { ok: true, balance, style };
  };

  /** Must run synchronously right before the ledger mark (no await in between). */
  const fundsCheck = (a: CheckedAuthorization, balance: bigint | undefined): Rejection | undefined => {
    if (balance === undefined) return undefined;
    const reserved = deps.ledger.reservedSpend(network, a.asset, a.from, idOf(a));
    if (balance >= reserved + a.value) return undefined;
    return {
      status: 200,
      reason: Reason.insufficientFunds,
      message:
        reserved > 0n
          ? `payer balance ${balance} does not cover ${a.value} plus ${reserved} already in flight`
          : `payer balance ${balance} is below ${a.value}`,
    };
  };

  /** The style advertised in the requirements is informational: log a disagreement, never act on it. */
  const noteStyleHint = (p: ParsedPayment, style: AuthorizationStyle): void => {
    const hint = p.requirements.extra?.[AUTHORIZATION_STYLE_EXTRA_KEY];
    if (hint === undefined || hint === style) return;
    const shown = typeof hint === "string" ? hint : JSON.stringify(hint);
    deps.log.warn(`requirements advertise ${AUTHORIZATION_STYLE_EXTRA_KEY}=${logText(shown).slice(0, 40)}; the token takes ${style}`);
  };

  const duplicate = (state: string, txHash?: string): Rejection => ({
    status: 200,
    reason: Reason.duplicateNonce,
    message: `this authorization is already ${state} at this facilitator${txHash ? ` (transaction ${txHash})` : ""}`,
    ...(txHash ? { existingTransaction: txHash } : {}),
    settlementStatus: "duplicate",
  });
  const busy: Rejection = { status: 503, reason: Reason.busy, message: "too many authorizations in flight; retry later" };

  async function verify(p: ParsedPayment): Promise<CoreResult<VerifyResponse>> {
    const checked = checkAuthorization(p, config, nowSec());
    if (!checked.ok) return verificationRejected(checked.rejection);
    const { auth: a, policy } = checked;
    const known = deps.ledger.peek(idOf(a));
    if (known) return verificationRejected(duplicate(known.state), a.from);

    const badSignature = await signatureCheck(p);
    if (badSignature) return verificationRejected(badSignature, a.from);

    const pre = await preflight(a, policy, p.requirements.extra ?? {});
    if (!pre.ok) return verificationRejected(pre.rejection, a.from);
    const late = stillInTime(a);
    if (late) return verificationRejected(late, a.from);

    // Atomic section: the funds check and the ledger mark run without an await.
    const noFunds = fundsCheck(a, pre.balance);
    if (noFunds) return verificationRejected(noFunds, a.from);
    const mark = deps.ledger.markVerified(idOf(a), a.value, a.validBefore);
    if (!mark.ok) return verificationRejected(mark.reason === "full" ? busy : duplicate(mark.state), a.from);

    noteStyleHint(p, pre.style);
    deps.log.info(`verified payer=${short(a.from)} payTo=${short(a.payTo)} amount=${logText(a.value)} style=${pre.style}`);
    return { status: 200, body: { isValid: true, payer: a.from } };
  }

  async function submitSafely(tx: BuiltTransaction): Promise<SubmitOutcome> {
    try {
      return await deps.chain.submit(tx);
    } catch (err) {
      return { kind: "unknown", hash: tx.hash, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function waitSafely(hash: string, deadlineMs: number): Promise<ExecutionOutcome> {
    try {
      return await deps.chain.waitForExecution(hash, deadlineMs);
    } catch (err) {
      return { kind: "pending", seen: false, lastError: err instanceof Error ? err.message : String(err) };
    }
  }

  /** The transfer executed. */
  const settledResult = (hash: string, payer: string, style: AuthorizationStyle, costMotes: bigint | undefined): CoreResult<SettleResponse> => ({
    status: 200,
    body: {
      success: true,
      transaction: hash,
      network,
      payer,
      extra: {
        settlementStatus: "success" satisfies SettlementStatus,
        authorizationStyle: style,
        ...(costMotes !== undefined ? { gasCostMotes: costMotes.toString() } : {}),
      },
    },
  });

  /** The transaction executed and reverted: nothing moved. */
  const revertedResult = (hash: string, payer: string, style: AuthorizationStyle, errorMessage: string): CoreResult<SettleResponse> => ({
    status: 200,
    body: {
      success: false,
      errorReason: Reason.failedOnChain,
      errorMessage: `transaction execution failed: ${errorMessage}`,
      transaction: hash,
      network,
      payer,
      extra: { settlementStatus: "failed" satisfies SettlementStatus, authorizationStyle: style },
    },
  });

  /** The outcome was not observed: hand back the hash so the caller can reconcile it (M22). */
  const unresolvedResult = (
    hash: string,
    payer: string,
    style: AuthorizationStyle,
    status: "pending" | "unknown",
  ): CoreResult<SettleResponse> => ({
    status: 200,
    body: {
      success: false,
      errorReason: status === "pending" ? Reason.pending : Reason.unknown,
      errorMessage:
        status === "pending"
          ? "transaction submitted; its execution was not observed yet — reconcile by transaction hash"
          : "submission outcome unknown — reconcile by transaction hash before treating the payment as failed",
      transaction: hash,
      network,
      payer,
      extra: { settlementStatus: status, authorizationStyle: style },
    },
  });

  async function settle(p: ParsedPayment): Promise<CoreResult<SettleResponse>> {
    const startedMs = deps.now();
    const checked = checkAuthorization(p, config, nowSec());
    if (!checked.ok) return settlementRejected(checked.rejection);
    const { auth: a, policy } = checked;
    const id = idOf(a);

    // Full verification again at settle time (M21): never trust an earlier /verify.
    const badSignature = await signatureCheck(p);
    if (badSignature) return settlementRejected(badSignature, a.from);

    const claim = deps.ledger.beginSettle(id, a.value, a.validBefore);
    if (!claim.ok) return settlementRejected(claim.reason === "full" ? busy : duplicate(claim.state, claim.txHash), a.from);
    // From here until submission, every early exit releases the claim.

    const pre = await preflight(a, policy, p.requirements.extra ?? {});
    if (!pre.ok) {
      deps.ledger.release(id);
      return settlementRejected(pre.rejection, a.from);
    }
    const noFunds = fundsCheck(a, pre.balance);
    if (noFunds) {
      deps.ledger.release(id);
      return settlementRejected(noFunds, a.from);
    }
    // The token's own style (equal to the asset's pinned one when it has one)
    // and the asset's own gas limit.
    const style = pre.style;
    const paymentMotes = policy.paymentMotes ?? paymentMotesByStyle[style];
    noteStyleHint(p, style);

    // The checks above can take seconds (a slow read plus its retry). Check the
    // window again right before building: a transfer that would execute after
    // validBefore reverts and burns the whole gas limit.
    const late = stillInTime(a);
    const builtAtMs = deps.now();
    // The transaction must not outlive the authorization: with its TTL capped,
    // the node drops it instead of executing it after validBefore.
    const ttlMs = settlementTtlMs(a.validBefore, builtAtMs, deps.chain.txTtlMs);
    if (late || ttlMs < MIN_TX_TTL_MS) {
      deps.ledger.release(id);
      return settlementRejected(
        late ?? { status: 200, reason: Reason.expiresTooSoon, message: "authorization expires before a settlement could be included" },
        a.from,
      );
    }

    let tx: BuiltTransaction;
    try {
      tx = deps.chain.build(a, { style, paymentMotes, ttlMs });
    } catch (err) {
      deps.ledger.release(id);
      deps.log.error(`building the settlement failed: ${logText(err)}`);
      return settlementRejected({ status: 200, reason: Reason.buildFailed, message: "could not build the settlement transaction" }, a.from);
    }

    // Reserve the asset's gas limit only now, immediately before submission (M08).
    const reservation = deps.gas.tryReserve(paymentMotes);
    if (!reservation) {
      deps.ledger.release(id);
      return settlementRejected({ status: 503, reason: Reason.gasCapReached, message: "daily sponsored-gas cap reached" }, a.from);
    }

    const submitted = await submitSafely(tx);
    if (submitted.kind === "rejected") {
      deps.gas.release(reservation);
      deps.ledger.release(id);
      deps.log.error(`node rejected the settlement: ${logText(submitted.error)}`);
      return settlementRejected({ status: 200, reason: Reason.rejectedByNode, message: "the node rejected the settlement transaction" }, a.from);
    }

    const hash = submitted.hash;
    // The transaction can be included until its timestamp + TTL, never after validBefore.
    deps.ledger.markSubmitted(id, hash, builtAtMs + ttlMs);
    const outcome = await waitSafely(hash, startedMs + config.settleWaitMs);
    const payer = a.from;

    if (outcome.kind === "success") {
      deps.gas.commit(reservation, outcome.costMotes);
      deps.ledger.markSettled(id, hash);
      deps.log.info(
        `settled tx=${logText(hash)} payer=${short(payer)} payTo=${short(a.payTo)} amount=${logText(a.value)} style=${style}` +
          (outcome.costMotes !== undefined ? ` gas=${logText(outcome.costMotes)}` : ""),
      );
      return settledResult(hash, payer, style, outcome.costMotes);
    }

    if (outcome.kind === "failure") {
      deps.gas.commit(reservation, outcome.costMotes);
      deps.ledger.markFailed(id, hash);
      deps.log.warn(`settlement reverted tx=${logText(hash)} payer=${short(payer)} style=${style}: ${logText(outcome.errorMessage)}`);
      return revertedResult(hash, payer, style, outcome.errorMessage);
    }

    // Outcome not observed before the deadline: count the full gas limit, keep the
    // nonce locked, and hand back the hash so the caller can reconcile (M22).
    deps.gas.commit(reservation);
    const status: "pending" | "unknown" = submitted.kind === "unknown" && !outcome.seen ? "unknown" : "pending";
    deps.log.warn(
      `settlement ${status} tx=${logText(hash)} payer=${short(payer)}${outcome.lastError ? ` (${logText(outcome.lastError)})` : ""}`,
    );
    return unresolvedResult(hash, payer, style, status);
  }

  return {
    verify,
    settle,
    supported() {
      const feePayer = deps.chain.feePayerAccountHash;
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network, extra: { feePayer } }],
        extensions: [],
        signers: { "casper:*": [feePayer] },
      };
    },
  };
}
