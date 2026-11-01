/**
 * Daily cap on the gas the facilitator's fee payer sponsors (M08).
 *
 *  - The budget is per UTC day and resets at 00:00 UTC.
 *  - A settlement reserves its gas limit only right before it is submitted.
 *  - If nothing was submitted, the reservation is released.
 *  - Once submitted, the reservation is converted into spend: the real
 *    on-chain cost when the execution result is known (cost − refund), the
 *    full reserved limit otherwise (pending/unknown outcome, conservative).
 */

export interface GasReservation {
  readonly id: number;
  readonly motes: bigint;
}

export interface GasBudgetSnapshot {
  day: string;
  capMotes: bigint;
  spentMotes: bigint;
  reservedMotes: bigint;
  availableMotes: bigint;
}

export interface DailyGasBudgetOptions {
  capMotes: bigint;
  now?: () => number;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export class DailyGasBudget {
  private readonly capMotes: bigint;
  private readonly now: () => number;
  private day: string;
  private spentMotes = 0n;
  private reservedMotes = 0n;
  private nextId = 1;
  private readonly open = new Map<number, bigint>();

  constructor(opts: DailyGasBudgetOptions) {
    if (opts.capMotes <= 0n) throw new Error("daily gas cap must be positive");
    this.capMotes = opts.capMotes;
    this.now = opts.now ?? Date.now;
    this.day = utcDay(this.now());
  }

  /** Start a new UTC day: yesterday's spend no longer counts; in-flight reservations still do. */
  private rollover(): void {
    const today = utcDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.spentMotes = 0n;
    }
  }

  /** Reserve gas for one submission, or `undefined` when the day's cap would be exceeded. */
  tryReserve(motes: bigint): GasReservation | undefined {
    if (motes <= 0n) throw new Error("reservation must be positive");
    this.rollover();
    if (this.spentMotes + this.reservedMotes + motes > this.capMotes) return undefined;
    const id = this.nextId++;
    this.open.set(id, motes);
    this.reservedMotes += motes;
    return { id, motes };
  }

  /** Nothing was submitted: give the reservation back. Idempotent. */
  release(reservation: GasReservation): void {
    const motes = this.open.get(reservation.id);
    if (motes === undefined) return;
    this.open.delete(reservation.id);
    this.reservedMotes -= motes;
  }

  /**
   * A transaction was (or may have been) submitted: count it against today's
   * budget with its real cost when known, otherwise the full reservation.
   * Idempotent.
   */
  commit(reservation: GasReservation, actualMotes?: bigint): void {
    const motes = this.open.get(reservation.id);
    if (motes === undefined) return;
    this.open.delete(reservation.id);
    this.reservedMotes -= motes;
    this.rollover();
    this.spentMotes += actualMotes !== undefined && actualMotes >= 0n ? actualMotes : motes;
  }

  snapshot(): GasBudgetSnapshot {
    this.rollover();
    const used = this.spentMotes + this.reservedMotes;
    return {
      day: this.day,
      capMotes: this.capMotes,
      spentMotes: this.spentMotes,
      reservedMotes: this.reservedMotes,
      availableMotes: used >= this.capMotes ? 0n : this.capMotes - used,
    };
  }
}
