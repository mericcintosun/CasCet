import type { BeforeVerifyHook } from "@x402/core/server";
import { normalizePackageHash, type ResolvedAsset } from "@cascet/core";
import { paymentHoldOf, type InFlightPayments, type PaymentHold } from "./in-flight.js";
import { log, logSafe } from "./log.js";
import { TokenUnsupportedError, type TokenProbe } from "./token-probe.js";

/**
 * Gateway-side preflight of payments that the hosted facilitator settles.
 *
 * CasCet's self-hosted facilitator checks every payment against the token's
 * on-chain state before it verifies or settles it. The hosted facilitator
 * (@x402/casper 2.29) does not do so reliably: its nonce pre-check reads a
 * dictionary these tokens do not have and takes the error for "unused". An
 * authorization whose nonce was already used on-chain therefore passes its
 * verify; in the default run-then-settle mode the tool runs, and the settle
 * reverts and burns the hosted fee payer's gas, once per gateway the
 * authorization is presented to. So the gateway runs the same reads itself,
 * through the shared {@link TokenProbe}, before x402 asks the hosted
 * facilitator to verify:
 *
 * - the token's `transfer_with_authorization` takes the argument of the
 *   asset's configured authorization style (a token upgrade can change it);
 * - the authorization's nonce is unused;
 * - the token's on-chain `name` is the EIP-712 domain name the buyer signed;
 * - the payer's balance covers the amount and, with `inFlight`, the payer's
 *   other payments in that asset that passed this preflight and whose calls
 *   have not ended (see in-flight.ts): a payment that passes reserves its
 *   amount on its call's hold until the call ends, so concurrent payments
 *   cannot each pass on a balance that funds only one of them.
 *
 * Read failures fail closed: when the token state cannot be read within the
 * deadline the payment is refused with `preflight_unavailable` (nothing was
 * charged, the buyer may retry), as the self-hosted facilitator does. A token
 * that cannot be used at all is refused with `unsupported_asset`.
 *
 * The hook never throws. x402 only logs a beforeVerify hook that throws and
 * then verifies anyway, which would turn every failure here into a pass.
 */

/** Total time the preflight of one payment may take: every read, retries included. */
export const HOSTED_PREFLIGHT_DEADLINE_MS = 5_000;

/** The reasons a preflight refuses a payment with (x402 puts them in the 402 `error`). */
export const PreflightReason = {
  invalidPayload: "invalid_payload",
  unsupportedAsset: "unsupported_asset",
  authorizationStyleMismatch: "authorization_style_mismatch",
  nonceAlreadyUsed: "nonce_already_used",
  tokenDomainMismatch: "token_domain_mismatch",
  insufficientFunds: "insufficient_funds",
  preflightUnavailable: "preflight_unavailable",
} as const;

/**
 * The reason of a payment refused because the payer's balance does not cover
 * it together with the payer's `count` other payments in flight in the same
 * asset (x402 puts the reason, not the message, in the 402 `error`).
 */
export function insufficientFundsInFlight(count: number): string {
  return `${PreflightReason.insufficientFunds}: insufficient balance once ${count} in-flight payment${count === 1 ? " is" : "s are"} counted`;
}

export interface HostedPreflightOptions {
  /** Reads the token state. Its clock must be `now` (read deadlines are absolute). */
  probe: TokenProbe;
  /** CAIP-2 network of the gateway; payments on other networks are not checked here. */
  network: string;
  /** The assets to check: those the hosted facilitator settles. Payments in other assets pass untouched. */
  assets: readonly ResolvedAsset[];
  /**
   * The payments in flight. With it the balance must cover the payment plus
   * the payer's other payments in flight in that asset, and a payment that
   * passes reserves its amount on the hold its call's x402 request context
   * carries (see in-flight.ts); a payment without one is refused. Without it
   * the balance is compared with the payment alone.
   */
  inFlight?: InFlightPayments;
  /** Default {@link HOSTED_PREFLIGHT_DEADLINE_MS}. */
  deadlineMs?: number;
  now?: () => number;
}

type Abort = { abort: true; reason: string; message: string };
const abort = (reason: string, message: string): Abort => ({ abort: true, reason, message });

/** Unix seconds as x402 Casper authorizations carry them (a decimal string), or undefined. */
function unixSeconds(value: unknown): number | undefined {
  return typeof value === "string" && /^\d{1,12}$/.test(value) ? Number(value) : undefined;
}

/** The `beforeVerify` hook that preflights payments in `assets` (see the module comment). */
export function hostedPreflightHook(opts: HostedPreflightOptions): BeforeVerifyHook {
  const guarded = new Map(opts.assets.map(asset => [normalizePackageHash(asset.packageHash), asset]));
  const deadlineMs = opts.deadlineMs ?? HOSTED_PREFLIGHT_DEADLINE_MS;
  const now = opts.now ?? Date.now;

  return async ({ paymentPayload, requirements, transportContext }) => {
    if (requirements.network !== opts.network) return undefined;
    const asset = guarded.get(normalizePackageHash(requirements.asset));
    if (!asset) return undefined;
    try {
      const authorization = (
        paymentPayload.payload as { authorization?: { from?: unknown; nonce?: unknown; validBefore?: unknown } } | undefined
      )?.authorization;
      const from = authorization?.from;
      const nonce = authorization?.nonce;
      if (typeof from !== "string" || typeof nonce !== "string") {
        return abort(PreflightReason.invalidPayload, "the payment names no payer or nonce");
      }
      // With in-flight tracking, a payment that passes is reserved on its call's hold until the call ends.
      let tracking: { inFlight: InFlightPayments; hold: PaymentHold; validBefore: number } | undefined;
      if (opts.inFlight) {
        const validBefore = unixSeconds(authorization?.validBefore);
        if (validBefore === undefined) return abort(PreflightReason.invalidPayload, "the payment names no validBefore");
        const hold = paymentHoldOf(transportContext);
        if (!hold) {
          log.error(`[x402] a payment in "${logSafe(asset.id, 64)}" reached the preflight without its call's in-flight hold; refusing it`);
          return abort(PreflightReason.preflightUnavailable, "the gateway cannot track this payment while it is in flight");
        }
        tracking = { inFlight: opts.inFlight, hold, validBefore };
      }
      const read = { deadlineMs: now() + deadlineMs };
      const token = asset.packageHash;
      const [style, used, name, balance] = await Promise.all([
        opts.probe.authorizationStyle(token, read),
        opts.probe.isNonceUsed(token, from, nonce, read),
        opts.probe.tokenName(token, read),
        opts.probe.balanceOf(token, from, read),
      ]);
      if (style !== asset.authorization) {
        log.error(`[x402] asset "${logSafe(asset.id, 64)}" is configured as ${asset.authorization}, but its token now takes ${style}`);
        return abort(
          PreflightReason.authorizationStyleMismatch,
          `token ${token} is ${style} on-chain, but the gateway sells it as ${asset.authorization}`,
        );
      }
      if (used) return abort(PreflightReason.nonceAlreadyUsed, "this authorization nonce was already used on-chain");
      const signed = requirements.extra?.name;
      const signedName = typeof signed === "string" ? signed : asset.name;
      if (name !== undefined && name !== signedName) {
        log.error(`[x402] asset "${logSafe(asset.id, 64)}" is configured with name ${logSafe(signedName, 80)}, but its token is named ${logSafe(name, 80)}`);
        return abort(PreflightReason.tokenDomainMismatch, `the EIP-712 domain name must equal the token name "${name}"`);
      }
      const amount = BigInt(requirements.amount);
      if (!tracking) {
        if (balance < amount) return abort(PreflightReason.insufficientFunds, `payer balance ${balance} is below ${amount}`);
        return undefined;
      }
      // No await from here on: the funds check and the reservation are one step, so two concurrent
      // payments of this payer cannot both pass on a balance that covers only one of them.
      const { inFlight, hold, validBefore } = tracking;
      const pending = inFlight.total(opts.network, token, from, hold);
      if (balance < pending.amount + amount) {
        if (pending.count === 0) return abort(PreflightReason.insufficientFunds, `payer balance ${balance} is below ${amount}`);
        return abort(
          insufficientFundsInFlight(pending.count),
          `payer balance ${balance} does not cover ${amount} plus ${pending.amount} already in flight`,
        );
      }
      const reserved = inFlight.reserve(hold, { network: opts.network, asset: token, payer: from, amount, validBefore });
      if (reserved === "full") {
        log.warn(`[x402] too many payments in flight to track one more in "${logSafe(asset.id, 64)}"; refusing it`);
        return abort(`${PreflightReason.preflightUnavailable}: too many payments in flight; retry later`, "the in-flight payments are at their limit");
      }
      if (reserved === "released") return abort(PreflightReason.preflightUnavailable, "the call of this payment has already ended");
      return undefined;
    } catch (err) {
      if (err instanceof TokenUnsupportedError) {
        log.error(`[x402] token of asset "${logSafe(asset.id, 64)}" cannot be used for x402 payments: ${logSafe(err)}`);
        return abort(PreflightReason.unsupportedAsset, "the token cannot be used for x402 payments");
      }
      log.warn(`[x402] preflight of a payment in "${logSafe(asset.id, 64)}" failed: ${logSafe(err)}; refusing it`);
      return abort(PreflightReason.preflightUnavailable, "could not read the token state; retry later");
    }
  };
}
