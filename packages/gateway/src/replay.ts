/**
 * Replay guard for x402 transfer authorizations.
 *
 * Every authorization is single-use at a gateway: its (payer, nonce) pair is
 * reserved before the facilitator is asked to verify it, so a duplicate, even
 * a concurrent one, is refused without any facilitator or upstream work. A
 * reservation whose verification fails is released; one that verifies is kept
 * until the authorization's `validBefore` has passed (after which the token
 * itself refuses it).
 */
export type ReserveResult = "reserved" | "duplicate" | "full";

interface Entry {
  expiresAt: number;
  committed: boolean;
}

export interface ReplayGuardOptions {
  /** Hard cap on tracked authorizations. When reached, new payments are refused rather than evicting live entries. */
  maxEntries?: number;
  now?: () => number;
}

export class ReplayGuard {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private lastPrune = 0;

  constructor(opts: ReplayGuardOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 100_000;
    this.now = opts.now ?? Date.now;
  }

  /** Reserve an authorization until `expiresAtMs`. */
  reserve(key: string, expiresAtMs: number): ReserveResult {
    const now = this.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) return "duplicate";
    if (existing) this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      this.prune(true);
      if (this.entries.size >= this.maxEntries) return "full";
    } else {
      this.prune(false);
    }
    this.entries.set(key, { expiresAt: expiresAtMs, committed: false });
    return "reserved";
  }

  /** The authorization verified: keep it until it expires. */
  commit(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.committed = true;
  }

  /** The authorization did not verify: free the reservation. */
  release(key: string): void {
    const entry = this.entries.get(key);
    if (entry && !entry.committed) this.entries.delete(key);
  }

  /** Record an authorization already used before this process started (from the receipt log). */
  markUsed(key: string, expiresAtMs: number): void {
    if (expiresAtMs <= this.now()) return;
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt >= expiresAtMs) return;
    this.entries.set(key, { expiresAt: expiresAtMs, committed: true });
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(force: boolean): void {
    const now = this.now();
    if (!force && (this.entries.size < 1_024 || now - this.lastPrune < 1_000)) return;
    this.lastPrune = now;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

/** Replay key of an authorization: on-chain nonces are scoped per payer (and per token). */
export function replayKey(payer: string, nonce: string): string {
  return `${payer.toLowerCase()}:${nonce.toLowerCase().replace(/^0x/, "")}`;
}
