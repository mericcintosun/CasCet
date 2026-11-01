import type { Network, PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import type { AuthorizationId, AuthorizationLedger } from "./authorization-ledger.js";
import type { DailyGasBudget } from "./gas-budget.js";
import type { BuiltTransaction, ExecutionOutcome, SettlementChain, SettlementInput, SubmitOutcome } from "./settlement.js";
import { TokenStateError, type TokenStateReader } from "./token-state.js";

/**
 * Policy core of the self-hosted facilitator: everything between "the HTTP
 * request was authenticated and rate-limited" and "a settlement transaction
 * is on chain". It is transport-free and dependency-injected, so every rule
 * is unit-tested without a node or a key.
 *
 * Both /verify and /settle run the FULL check list (M21): request shape,
 * allowlists, CEP-3009 field formats (payer and payee must be account-hash
 * Keys, publicKey and signature algorithm tags must match), a validity window
 * that still leaves time to settle before validBefore, the casper-x402
 * signature check, the in-flight nonce ledger (M09), and an on-chain preflight
 * (nonce not used, balance covers the value plus everything already in flight,
 * EIP-712 domain name equals the token's on-chain name). The validity window is
 * checked again after the preflight, because the reads can take seconds.
 * /settle then caps the transaction's TTL at the authorization's validBefore,
 * reserves gas only right before submission (M08) and never reports a failure
 * for a transaction whose outcome is merely unknown (M22).
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
  invalidPayTo: "invalid_payto",
  invalidPayer: "invalid_payer",
  payToMismatch: "payto_mismatch",
  invalidAmount: "invalid_amount",
  invalidValidity: "invalid_validity_window",
  validityTooLong: "validity_window_too_long",
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
 *                   request here (409 duplicate_nonce, `transaction` = that
 *                   earlier submission when there is one), or its nonce is
 *                   already used on-chain (409 nonce_already_used). The earlier
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

export interface FacilitatorCoreConfig {
  network: Network;
  /** Allowed payees, normalized "00" + 64 hex. Undefined = any (testnet only). */
  allowedPayTo?: string[];
  /** Allowed CEP-18 package hashes, normalized 64 hex. Undefined = any (testnet only). */
  allowedAssets?: string[];
  /** Pinned EIP-712 domain version (`extra.version`). */
  tokenVersion?: string;
  /** Pinned EIP-712 domain name; when unset and preflight is on, the token's on-chain name is used. */
  tokenName?: string;
  /** Gas limit (motes) of each settlement transaction. */
  paymentMotes: bigint;
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

export interface FacilitatorCoreDeps {
  /** casper-x402 cryptographic verification (EIP-712 digest, signature, pubkey ↔ payer). */
  verifySignature(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  /** On-chain reads; undefined disables the preflight. Its clock must be `now` (deadlines are absolute). */
  tokenState?: Pick<TokenStateReader, "balanceOf" | "isNonceUsed" | "tokenName">;
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

/** Normalize an allowlist payee entry to "00" + 64 hex. */
export function normalizePayTo(entry: string): string {
  const s = entry.trim().toLowerCase().replace(/^0x/, "");
  if (s.startsWith("account-hash-") && HEX64.test(s.slice(13))) return `00${s.slice(13)}`;
  if (ACCOUNT_KEY.test(s)) return s;
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

/** Policy and CEP-3009 format checks that need no signature or chain access. */
export function checkAuthorization(
  p: ParsedPayment,
  config: FacilitatorCoreConfig,
  nowSec: number,
): { ok: true; auth: CheckedAuthorization } | { ok: false; rejection: Rejection } {
  const reject = (status: number, reason: string, message: string) => ({ ok: false as const, rejection: { status, reason, message } });
  const req = p.requirements;
  const a = p.authorization;

  const asset = req.asset.toLowerCase().replace(/^hash-/, "");
  if (!HEX64.test(asset)) return reject(200, Reason.invalidAsset, "asset must be a 64-hex contract package hash");
  if (config.allowedAssets && !config.allowedAssets.includes(asset)) return reject(403, Reason.assetNotAllowlisted, "asset not allowlisted");

  const payTo = req.payTo.toLowerCase();
  if (!ACCOUNT_KEY.test(payTo)) {
    // A "01" (contract-package) payee would be settled to Key::Account(hash) by
    // casper-x402 1.0.0 and revert on the signature check, burning gas.
    return reject(200, Reason.invalidPayTo, "payTo must be an account-hash Key: 00 + 64 hex");
  }
  if (config.allowedPayTo && !config.allowedPayTo.includes(payTo)) return reject(403, Reason.payToNotAllowlisted, "payTo not allowlisted");

  const from = a.from.toLowerCase();
  if (!ACCOUNT_KEY.test(from)) return reject(200, Reason.invalidPayer, "authorization.from must be an account-hash Key: 00 + 64 hex");
  if (a.to.toLowerCase() !== payTo) return reject(200, Reason.payToMismatch, "authorization.to does not match payTo");

  if (!UINT.test(a.value) || a.value === "0" || a.value.length > 78 || BigInt(a.value) > U256_MAX) {
    return reject(200, Reason.invalidAmount, "authorization.value must be a positive canonical decimal U256");
  }
  if (a.value !== req.amount) return reject(200, Reason.invalidAmount, "authorization.value does not match the required amount");

  if (!UINT.test(a.validAfter) || !UINT.test(a.validBefore) || a.validAfter.length > 12 || a.validBefore.length > 12) {
    return reject(200, Reason.invalidValidity, "validAfter / validBefore must be unix seconds");
  }
  const validAfter = Number(a.validAfter);
  const validBefore = Number(a.validBefore);
  if (validAfter >= validBefore) return reject(200, Reason.invalidValidity, "validAfter must be before validBefore");
  const late = windowRejection(validBefore, nowSec, config.minSettleWindowSeconds ?? DEFAULT_MIN_SETTLE_WINDOW_SECONDS);
  if (late) return { ok: false, rejection: late };
  if (validBefore - nowSec > config.maxValiditySeconds) {
    return reject(200, Reason.validityTooLong, `authorization must expire within ${config.maxValiditySeconds}s`);
  }

  const nonce = a.nonce.toLowerCase().replace(/^0x/, "");
  if (!HEX64.test(nonce)) return reject(200, Reason.invalidNonce, "nonce must be 32 bytes of hex");

  const publicKey = p.publicKey.toLowerCase();
  if (!PUBLIC_KEY.test(publicKey)) return reject(200, Reason.invalidPublicKey, "publicKey must be an ed25519 (01…) or secp256k1 (02…) key");
  const signature = p.signature.toLowerCase().replace(/^0x/, "");
  if (!SIGNATURE.test(signature)) return reject(200, Reason.invalidSignature, "signature must be 65 bytes of hex");
  if (signature.slice(0, 2) !== publicKey.slice(0, 2)) {
    return reject(200, Reason.algorithmMismatch, "signature algorithm tag does not match the public key");
  }

  const extra = req.extra ?? {};
  if (config.tokenVersion !== undefined && extra["version"] !== config.tokenVersion) {
    return reject(200, Reason.tokenDomainMismatch, `EIP-712 domain version must be "${config.tokenVersion}"`);
  }
  if (config.tokenName !== undefined && extra["name"] !== config.tokenName) {
    return reject(200, Reason.tokenDomainMismatch, `EIP-712 domain name must be "${config.tokenName}"`);
  }

  return {
    ok: true,
    auth: { asset, payTo, from, to: payTo, value: BigInt(a.value), validAfter, validBefore, nonce, publicKey, signature },
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

  type Preflight = { ok: true; balance?: bigint } | { ok: false; rejection: Rejection };

  const preflight = async (a: CheckedAuthorization, extra: Record<string, unknown>): Promise<Preflight> => {
    const reader = deps.tokenState;
    if (!reader) return { ok: true };
    // One budget for every read of this preflight, retries included.
    const opts = { deadlineMs: deps.now() + (config.preflightDeadlineMs ?? DEFAULT_PREFLIGHT_DEADLINE_MS) };
    let used: boolean;
    let balance: bigint;
    let name: string | undefined;
    try {
      [used, balance, name] = await Promise.all([
        reader.isNonceUsed(a.asset, a.from, a.nonce, opts),
        reader.balanceOf(a.asset, a.from, opts),
        config.tokenName === undefined ? reader.tokenName(a.asset, opts) : Promise.resolve(undefined),
      ]);
    } catch (err) {
      const detail = err instanceof TokenStateError ? err.message : "unexpected error";
      deps.log.error(`preflight unavailable: ${logText(detail)}`);
      return { ok: false, rejection: { status: 503, reason: Reason.preflightUnavailable, message: "could not read the token state; retry later" } };
    }
    if (used) {
      return {
        ok: false,
        rejection: {
          status: 409,
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
    return { ok: true, balance };
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

  const duplicate = (state: string, txHash?: string): Rejection => ({
    status: 409,
    reason: Reason.duplicateNonce,
    message: `this authorization is already ${state} at this facilitator${txHash ? ` (transaction ${txHash})` : ""}`,
    ...(txHash ? { existingTransaction: txHash } : {}),
    settlementStatus: "duplicate",
  });
  const busy: Rejection = { status: 503, reason: Reason.busy, message: "too many authorizations in flight; retry later" };

  async function verify(p: ParsedPayment): Promise<CoreResult<VerifyResponse>> {
    const checked = checkAuthorization(p, config, nowSec());
    if (!checked.ok) return verificationRejected(checked.rejection);
    const a = checked.auth;
    const known = deps.ledger.peek(idOf(a));
    if (known) return verificationRejected(duplicate(known.state), a.from);

    const badSignature = await signatureCheck(p);
    if (badSignature) return verificationRejected(badSignature, a.from);

    const pre = await preflight(a, p.requirements.extra ?? {});
    if (!pre.ok) return verificationRejected(pre.rejection, a.from);
    const late = stillInTime(a);
    if (late) return verificationRejected(late, a.from);

    // Atomic section: the funds check and the ledger mark run without an await.
    const noFunds = fundsCheck(a, pre.balance);
    if (noFunds) return verificationRejected(noFunds, a.from);
    const mark = deps.ledger.markVerified(idOf(a), a.value, a.validBefore);
    if (!mark.ok) return verificationRejected(mark.reason === "full" ? busy : duplicate(mark.state), a.from);

    deps.log.info(`verified payer=${short(a.from)} payTo=${short(a.payTo)} amount=${logText(a.value)}`);
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

  async function settle(p: ParsedPayment): Promise<CoreResult<SettleResponse>> {
    const startedMs = deps.now();
    const checked = checkAuthorization(p, config, nowSec());
    if (!checked.ok) return settlementRejected(checked.rejection);
    const a = checked.auth;
    const id = idOf(a);

    // Full verification again at settle time (M21): never trust an earlier /verify.
    const badSignature = await signatureCheck(p);
    if (badSignature) return settlementRejected(badSignature, a.from);

    const claim = deps.ledger.beginSettle(id, a.value, a.validBefore);
    if (!claim.ok) return settlementRejected(claim.reason === "full" ? busy : duplicate(claim.state, claim.txHash), a.from);
    // From here until submission, every early exit releases the claim.

    const pre = await preflight(a, p.requirements.extra ?? {});
    if (!pre.ok) {
      deps.ledger.release(id);
      return settlementRejected(pre.rejection, a.from);
    }
    const noFunds = fundsCheck(a, pre.balance);
    if (noFunds) {
      deps.ledger.release(id);
      return settlementRejected(noFunds, a.from);
    }

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
      tx = deps.chain.build(a, config.paymentMotes, ttlMs);
    } catch (err) {
      deps.ledger.release(id);
      deps.log.error(`building the settlement failed: ${logText(err)}`);
      return settlementRejected({ status: 200, reason: Reason.buildFailed, message: "could not build the settlement transaction" }, a.from);
    }

    // Reserve gas only now, immediately before submission (M08).
    const reservation = deps.gas.tryReserve(config.paymentMotes);
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
        `settled tx=${logText(hash)} payer=${short(payer)} payTo=${short(a.payTo)} amount=${logText(a.value)}` +
          (outcome.costMotes !== undefined ? ` gas=${logText(outcome.costMotes)}` : ""),
      );
      return {
        status: 200,
        body: {
          success: true,
          transaction: hash,
          network,
          payer,
          extra: {
            settlementStatus: "success" satisfies SettlementStatus,
            ...(outcome.costMotes !== undefined ? { gasCostMotes: outcome.costMotes.toString() } : {}),
          },
        },
      };
    }

    if (outcome.kind === "failure") {
      deps.gas.commit(reservation, outcome.costMotes);
      deps.ledger.markFailed(id, hash);
      deps.log.warn(`settlement reverted tx=${logText(hash)} payer=${short(payer)}: ${logText(outcome.errorMessage)}`);
      return {
        status: 200,
        body: {
          success: false,
          errorReason: Reason.failedOnChain,
          errorMessage: `transaction execution failed: ${outcome.errorMessage}`,
          transaction: hash,
          network,
          payer,
          extra: { settlementStatus: "failed" satisfies SettlementStatus },
        },
      };
    }

    // Outcome not observed before the deadline: count the full gas limit, keep the
    // nonce locked, and hand back the hash so the caller can reconcile (M22).
    deps.gas.commit(reservation);
    const status: SettlementStatus = submitted.kind === "unknown" && !outcome.seen ? "unknown" : "pending";
    deps.log.warn(
      `settlement ${status} tx=${logText(hash)} payer=${short(payer)}${outcome.lastError ? ` (${logText(outcome.lastError)})` : ""}`,
    );
    return {
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
        extra: { settlementStatus: status },
      },
    };
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
