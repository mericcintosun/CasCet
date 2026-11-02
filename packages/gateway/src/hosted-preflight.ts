import type { AfterVerifyHook, BeforeVerifyHook } from "@x402/core/server";
import { normalizePackageHash, type ResolvedAsset } from "@cascet/core";
import { paymentHoldOf, type InFlightPayments, type InFlightTotal, type PaymentHold } from "./in-flight.js";
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
 *   other payments in that asset that are in flight (see in-flight.ts).
 *
 * With `inFlight`, a payment is reserved on its call's hold, until the call
 * ends, only once the facilitator verified it (the afterVerify hook): the
 * gateway's own checks never look at the signature, so a payment anyone can
 * forge from a payer's public key must not hold back that payer's real
 * payments. The afterVerify hook checks the balance read before verify
 * against the payments in flight again and reserves the amount in one step,
 * so concurrent payments cannot each pass on a balance that funds only one of
 * them. It then reads the balance again, the payment counting meanwhile, and
 * refuses the payment if that balance does not cover it: a payment of the
 * payer that settled while this one was being verified is no longer in
 * flight, and only a fresh read shows what it spent.
 *
 * Read failures fail closed: when the token state cannot be read within the
 * deadline (one for the reads before verify and the read after it) the
 * payment is refused with `preflight_unavailable` (nothing was charged, the
 * buyer may retry), as the self-hosted facilitator does. A token that cannot
 * be used at all is refused with `unsupported_asset`.
 *
 * Neither hook ever throws. x402 only logs a verify hook that throws and then
 * goes on as if it had passed, which would turn every failure here into a
 * pass.
 */

/**
 * Total time the preflight of one payment may spend reading the token state,
 * retries included: the reads before verify and the balance read after it
 * share it.
 */
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
   * passes and that the facilitator verifies reserves its amount on the hold
   * its call's x402 request context carries (see in-flight.ts); a payment
   * without one is refused. Without it the balance is compared with the
   * payment alone.
   */
  inFlight?: InFlightPayments;
  /** Default {@link HOSTED_PREFLIGHT_DEADLINE_MS}. */
  deadlineMs?: number;
  now?: () => number;
}

/** The two verify hooks of the preflight (see the module comment). */
export interface HostedPreflightHooks {
  /** The on-chain checks, before x402 asks the facilitator to verify a payment. */
  beforeVerify: BeforeVerifyHook;
  /**
   * With `inFlight`: once the facilitator verified a payment that passed the
   * checks, the funds check against the payments in flight and the
   * reservation, in one step, then the same check on the payer's balance read
   * again. Does nothing for a payment it did not verify.
   */
  afterVerify: AfterVerifyHook;
}

type Abort = { abort: true; reason: string; message: string };
const abort = (reason: string, message: string): Abort => ({ abort: true, reason, message });

/** Unix seconds as x402 Casper authorizations carry them (a decimal string), or undefined. */
function unixSeconds(value: unknown): number | undefined {
  return typeof value === "string" && /^\d{1,12}$/.test(value) ? Number(value) : undefined;
}

const NOTHING_IN_FLIGHT: InFlightTotal = { count: 0, amount: 0n };

/** The refusal of a payment of `amount` that `balance` does not fund on top of the payer's `pending` payments, if it does not. */
function shortOfFunds(balance: bigint, amount: bigint, pending: InFlightTotal): Abort | undefined {
  if (balance >= pending.amount + amount) return undefined;
  if (pending.count === 0) return abort(PreflightReason.insufficientFunds, `payer balance ${balance} is below ${amount}`);
  return abort(insufficientFundsInFlight(pending.count), `payer balance ${balance} does not cover ${amount} plus ${pending.amount} already in flight`);
}

/** A payment that passed the checks before verify, as the afterVerify hook needs it. */
interface CheckedPayment {
  payer: string;
  amount: bigint;
  validBefore: number;
  /** The payer's balance, read before verify. */
  balance: bigint;
  /** What the reads before verify left of the deadline (ms): the balance read after verify gets that long. */
  leftMs: number;
}

/** The verify hooks that preflight payments in `assets` (see the module comment). */
export function hostedPreflightHooks(opts: HostedPreflightOptions): HostedPreflightHooks {
  const guarded = new Map(opts.assets.map(asset => [normalizePackageHash(asset.packageHash), asset]));
  const deadlineMs = opts.deadlineMs ?? HOSTED_PREFLIGHT_DEADLINE_MS;
  const now = opts.now ?? Date.now;
  /** With in-flight tracking: the payments that passed the checks, by their call's hold, until the facilitator answered. */
  const checked = new WeakMap<PaymentHold, CheckedPayment>();

  /** The refusal of a payment in `asset` whose token state could not be read (`err`, logged). */
  const readRefusal = (asset: ResolvedAsset, err: unknown): Abort => {
    if (err instanceof TokenUnsupportedError) {
      log.error(`[x402] token of asset "${logSafe(asset.id, 64)}" cannot be used for x402 payments: ${logSafe(err)}`);
      return abort(PreflightReason.unsupportedAsset, "the token cannot be used for x402 payments");
    }
    log.warn(`[x402] preflight of a payment in "${logSafe(asset.id, 64)}" failed: ${logSafe(err)}; refusing it`);
    return abort(PreflightReason.preflightUnavailable, "could not read the token state; retry later");
  };

  const beforeVerify: BeforeVerifyHook = async ({ paymentPayload, requirements, transportContext }) => {
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
      // With in-flight tracking, a payment that passes is reserved on its call's hold once it is verified.
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
      // The payer's verified payments in flight count already: a balance they use up is refused before verify.
      const pending = tracking ? tracking.inFlight.total(opts.network, token, from, tracking.hold) : NOTHING_IN_FLIGHT;
      const refused = shortOfFunds(balance, amount, pending);
      if (refused) return refused;
      if (tracking) {
        checked.set(tracking.hold, { payer: from, amount, validBefore: tracking.validBefore, balance, leftMs: read.deadlineMs - now() });
      }
      return undefined;
    } catch (err) {
      return readRefusal(asset, err);
    }
  };

  const afterVerify: AfterVerifyHook = async ({ requirements, result, transportContext }) => {
    const inFlight = opts.inFlight;
    if (!inFlight || requirements.network !== opts.network) return undefined;
    const asset = guarded.get(normalizePackageHash(requirements.asset));
    if (!asset) return undefined;
    try {
      const hold = paymentHoldOf(transportContext);
      const payment = hold ? checked.get(hold) : undefined;
      if (hold) checked.delete(hold);
      // Not verified (a forged signature, say): x402 refuses it with the facilitator's reason, and nothing is reserved.
      if (!result.isValid) return undefined;
      if (!hold || !payment) {
        log.error(`[x402] a payment in "${logSafe(asset.id, 64)}" was verified without passing the preflight; refusing it`);
        return abort(PreflightReason.preflightUnavailable, "the gateway cannot track this payment while it is in flight");
      }
      // No await from here to the reservation: the funds check (with the balance read before verify) and the
      // reservation are one step, so two concurrent payments of this payer cannot both be reserved on a balance
      // that covers one.
      const token = asset.packageHash;
      const short = shortOfFunds(payment.balance, payment.amount, inFlight.total(opts.network, token, payment.payer, hold));
      if (short) return short;
      const reserved = inFlight.reserve(hold, {
        network: opts.network,
        asset: token,
        payer: payment.payer,
        amount: payment.amount,
        validBefore: payment.validBefore,
      });
      if (reserved === "full") {
        log.warn(`[x402] too many payments in flight to track one more in "${logSafe(asset.id, 64)}"; refusing it`);
        return abort(`${PreflightReason.preflightUnavailable}: too many payments in flight; retry later`, "the in-flight payments are at their limit");
      }
      if (reserved === "released") return abort(PreflightReason.preflightUnavailable, "the call of this payment has already ended");
      // A payment of this payer that settled while this one was being verified is no longer in flight, and the
      // balance read before verify may not show what it spent: read the balance again, this payment counting
      // meanwhile, and check it once more. A refusal ends the call, so its hold is released here already.
      let balance: bigint;
      try {
        balance = await opts.probe.balanceOf(token, payment.payer, { deadlineMs: now() + payment.leftMs });
      } catch (err) {
        hold.release();
        return readRefusal(asset, err);
      }
      const refused = shortOfFunds(balance, payment.amount, inFlight.total(opts.network, token, payment.payer, hold));
      if (refused) hold.release();
      return refused;
    } catch (err) {
      log.warn(`[x402] tracking a verified payment in "${logSafe(asset.id, 64)}" failed: ${logSafe(err)}; refusing it`);
      return abort(PreflightReason.preflightUnavailable, "the gateway cannot track this payment while it is in flight");
    }
  };

  return { beforeVerify, afterVerify };
}
