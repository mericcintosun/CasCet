import { normalizePackageHash } from "@cascet/core";
import { normalizeAccountAddress } from "./authorization.js";

/**
 * Payments in flight, per payer, for the gateway's on-chain preflight of the
 * payments the hosted facilitator settles (hosted-preflight.ts).
 *
 * The preflight compares the payer's token balance with the payment. Other
 * payments of that payer that passed it and have not settled yet are not
 * taken out of that balance, so concurrent payments could each pass while the
 * balance funds only one of them: the others fail at settlement, and in the
 * default run-then-settle mode their tools have run for free. So a payment
 * that passes the preflight and that the facilitator verified reserves its
 * amount here, per (network, asset, payer), and the preflight requires the
 * balance to cover everything reserved plus the new amount, before verify
 * and again, with the reservation, after it. That check and the reservation
 * run with no await in between (Node runs them on one thread), so two
 * concurrent payments can never both be reserved on one balance. The
 * preflight then reads the balance once more, the payment counting meanwhile,
 * and refuses it unless that balance covers it too: a payment of the payer
 * that settled while this one was being verified is no longer reserved, and
 * only a fresh read shows what it spent. Only verified payments are reserved
 * (the facilitator checked their signature): a payment forged from a payer's
 * public key never holds back the payer's real ones.
 *
 * Every reservation belongs to one paid call's {@link PaymentHold}. The
 * gateway opens a hold for each paid call, hands it to x402 with the call's
 * request context ({@link withPaymentHold}; x402 passes that context on to the
 * preflight's verify hooks), and releases it when the call's settlement
 * finishes (settled or failed) or the call ends without one (refused,
 * canceled, an upstream error, a timeout, a throw). When the settlement's
 * outcome is unknown the transfer may still execute and spend the balance,
 * so the call ends keeping its reservation ({@link PaymentHold.keepUntilExpiry}).
 * A reservation that is not released expires {@link IN_FLIGHT_MARGIN_MS}
 * after its authorization's validBefore: by then the authorization can no
 * longer execute, so it cannot spend the balance any more. At most
 * `maxPayments` reservations are live; beyond that new payments are refused,
 * never live reservations forgotten (that would let an unfunded payment
 * through).
 *
 * The reservations live in memory. A restarted gateway rebuilds those that
 * outlive their calls from its receipt log ({@link InFlightPayments.keep}):
 * every payment in a preflighted token whose receipt says `unknown` counts
 * again until it expires (its validBefore is in the authorization's
 * write-ahead record). A receipt does not say whether the on-chain check found
 * the nonce used, so after a restart such a payment counts again too: in
 * doubt the gateway holds its amount back rather than let another payment
 * through on funds it may already have spent.
 */

/** How long after its authorization's validBefore a reservation counts at most (clock skew, inclusion). */
export const IN_FLIGHT_MARGIN_MS = 120_000;
const DEFAULT_MAX_PAYMENTS = 10_000;

/** A payment that passed the preflight, that its facilitator verified and whose call has not ended. */
export interface InFlightPayment {
  /** CAIP-2 network. */
  network: string;
  /** Token contract package hash, in any common spelling. */
  asset: string;
  /** Payer account address, in any common spelling. */
  payer: string;
  /** Raw token units. */
  amount: bigint;
  /** The authorization's validBefore, unix seconds. */
  validBefore: number;
}

/** The payments of one payer in one asset that are in flight. */
export interface InFlightTotal {
  count: number;
  /** Their amounts added up, raw token units. */
  amount: bigint;
}

/**
 * One paid call's share of the payments in flight: its payment's reservation,
 * once the preflight made one. The call ends once, with the first of
 * release() and keepUntilExpiry(); later calls of either change nothing, and
 * nothing can be reserved on the hold afterwards.
 */
export interface PaymentHold {
  /** The call ended: its payment is no longer in flight (it settled, failed, or never reached settlement). */
  release(): void;
  /**
   * The call ended, but its payment may still execute (the outcome of its
   * settlement is unknown): its reservation keeps counting until it expires,
   * {@link IN_FLIGHT_MARGIN_MS} after its authorization's validBefore.
   */
  keepUntilExpiry(): void;
}

export type ReserveOutcome = "reserved" | "full" | "released";

export interface InFlightOptions {
  /** Most reservations live at once (default 10 000); beyond that new payments are refused. */
  maxPayments?: number;
  /** Clock in milliseconds (tests). Default Date.now. */
  now?: () => number;
}

interface Reservation {
  readonly hold: PaymentHold;
  /** The payment's (network, asset, payer). */
  readonly key: string;
  readonly amount: bigint;
  /** When it stops counting (ms). */
  readonly expiresAt: number;
}

export class InFlightPayments {
  /** The reservation of each hold that has one. */
  private readonly reservations = new Map<PaymentHold, Reservation>();
  /** The same reservations, per (network, asset, payer). */
  private readonly byPayment = new Map<string, Set<Reservation>>();
  /** Holds this tracker opened, and those whose call ended. */
  private readonly opened = new WeakSet<PaymentHold>();
  private readonly ended = new WeakSet<PaymentHold>();
  private readonly maxPayments: number;
  private readonly now: () => number;

  constructor(opts: InFlightOptions = {}) {
    this.maxPayments = Math.max(1, opts.maxPayments ?? DEFAULT_MAX_PAYMENTS);
    this.now = opts.now ?? Date.now;
  }

  /** A hold for one paid call; release it (or keep its reservation until it expires) when the call ends. */
  open(): PaymentHold {
    const hold: PaymentHold = { release: () => this.end(hold, false), keepUntilExpiry: () => this.end(hold, true) };
    this.opened.add(hold);
    return hold;
  }

  /** The payments of `payer` in `asset` on `network` that are in flight, other than `except`'s own. */
  total(network: string, asset: string, payer: string, except?: PaymentHold): InFlightTotal {
    const now = this.now();
    let count = 0;
    let amount = 0n;
    for (const reservation of [...(this.byPayment.get(paymentKey(network, asset, payer)) ?? [])]) {
      if (reservation.expiresAt <= now) {
        this.forget(reservation.hold);
        continue;
      }
      if (reservation.hold === except) continue;
      count++;
      amount += reservation.amount;
    }
    return { count, amount };
  }

  /**
   * Reserve `payment` on `hold`, its call's. A hold carries one reservation:
   * a second one replaces the first. Nothing is reserved when `maxPayments`
   * are live ("full") or when the hold's call already ended or the hold is
   * not this tracker's ("released").
   */
  reserve(hold: PaymentHold, payment: InFlightPayment): ReserveOutcome {
    if (!this.opened.has(hold) || this.ended.has(hold)) return "released";
    this.forget(hold);
    if (this.reservations.size >= this.maxPayments) {
      this.prune();
      if (this.reservations.size >= this.maxPayments) return "full";
    }
    const key = paymentKey(payment.network, payment.asset, payment.payer);
    const reservation: Reservation = { hold, key, amount: payment.amount, expiresAt: expiresAt(payment) };
    this.reservations.set(hold, reservation);
    let same = this.byPayment.get(key);
    if (!same) {
      same = new Set();
      this.byPayment.set(key, same);
    }
    same.add(reservation);
    return "reserved";
  }

  /**
   * Count `payment` until it expires, with no call of its own: a payment whose
   * settlement outcome was unknown when an earlier process of this gateway
   * ended (see the module comment). Nothing is kept for a payment that has
   * already expired, or while `maxPayments` reservations are live ("full").
   */
  keep(payment: InFlightPayment): "kept" | "expired" | "full" {
    if (expiresAt(payment) <= this.now()) return "expired";
    const hold = this.open();
    const reserved = this.reserve(hold, payment);
    hold.keepUntilExpiry();
    return reserved === "reserved" ? "kept" : "full";
  }

  /** Reservations held (expired ones until they are next seen). */
  get size(): number {
    return this.reservations.size;
  }

  /** The call of `hold` ended; its reservation goes unless `keep` (it then counts until it expires). Only the first end counts. */
  private end(hold: PaymentHold, keep: boolean): void {
    if (this.ended.has(hold)) return;
    this.ended.add(hold);
    if (!keep) this.forget(hold);
  }

  private forget(hold: PaymentHold): void {
    const reservation = this.reservations.get(hold);
    if (!reservation) return;
    this.reservations.delete(hold);
    const same = this.byPayment.get(reservation.key);
    same?.delete(reservation);
    if (same?.size === 0) this.byPayment.delete(reservation.key);
  }

  private prune(): void {
    const now = this.now();
    for (const reservation of [...this.reservations.values()]) {
      if (reservation.expiresAt <= now) this.forget(reservation.hold);
    }
  }
}

/** When the reservation of `payment` stops counting (ms): its authorization can no longer execute by then. */
function expiresAt(payment: InFlightPayment): number {
  return payment.validBefore * 1_000 + IN_FLIGHT_MARGIN_MS;
}

/** One (network, asset, payer), whatever the spelling of the asset and the payer. */
function paymentKey(network: string, asset: string, payer: string): string {
  return `${network}|${normalizePackageHash(asset)}|${normalizeAccountAddress(payer)}`;
}

/** Where a paid call's x402 request context carries its {@link PaymentHold}. */
const HOLD = Symbol("cascet.paymentHold");

/**
 * `context` (the x402 HTTP request context of a paid call) carrying the
 * call's `hold`. x402 copies the request context with its own properties
 * (symbols included) into the `transportContext.request` it gives its verify
 * hooks, which is where the preflight finds the hold ({@link paymentHoldOf}).
 */
export function withPaymentHold<T extends object>(context: T, hold: PaymentHold): T {
  return { ...context, [HOLD]: hold };
}

/** The hold of the paid call whose x402 `transportContext` this is, when the gateway gave it one. */
export function paymentHoldOf(transportContext: unknown): PaymentHold | undefined {
  const request = isObject(transportContext) ? transportContext.request : undefined;
  const hold = isObject(request) ? (request as { [HOLD]?: unknown })[HOLD] : undefined;
  return isObject(hold) && typeof hold.release === "function" ? (hold as unknown as PaymentHold) : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
