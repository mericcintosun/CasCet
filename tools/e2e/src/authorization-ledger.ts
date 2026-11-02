import type { AuthorizationStyle } from "@cascet/core";
import type { GasCharge } from "./gas-budget.js";

/**
 * In-memory ledger of x402 authorizations this facilitator has seen (M09, M21).
 *
 * Every authorization is identified by (network, asset, from, nonce). The
 * ledger answers three questions without touching the chain:
 *  - "is this a duplicate?" — a nonce that is being verified, settled, or was
 *    already submitted by us is rejected (`duplicate_nonce`) instead of burning
 *    the fee payer's gas on a second, doomed deploy;
 *  - "how much of this payer's balance is already spoken for?" — the values
 *    of in-flight authorizations, so one funded balance cannot back several
 *    concurrent payments;
 *  - "is this settle a retry of one whose outcome we never saw?" — the pending
 *    settlement store: a submitted transaction whose settle answered "pending"
 *    or "unknown" is remembered with the fingerprint of the exact payment, so
 *    a retry of that payment (x402 resource servers retry `settlement_pending`
 *    once) follows the same transaction instead of broadcasting another one.
 *
 * Lifecycle: verified → settling → submitted → settled | failed.
 *  - `verified` entries are held briefly (the gateway runs the tool between
 *    /verify and /settle), then expire.
 *  - From `settling` on, entries are kept until the authorization can no longer
 *    execute: max(validBefore, now + tx TTL) + grace, capped at maxRetentionMs.
 *  - `failed` (the transaction executed and reverted) still blocks a resubmission
 *    but no longer counts against the payer's balance.
 *  - `release` drops an entry only when NOTHING was submitted for it.
 *
 * Single-process and in-memory by design: Node runs these handlers on one
 * thread, so check-and-mark sequences without an `await` in between are atomic.
 */

export type LedgerState = "verified" | "settling" | "submitted" | "settled" | "failed";

/**
 * A submitted settlement whose outcome the settle that submitted it did not
 * observe: it answered "pending" (accepted by the node, execution not seen
 * yet) or "unknown" (ambiguous submission).
 */
export interface UnresolvedSettlement {
  status: "pending" | "unknown";
  /** Fingerprint of the exact payment that was submitted: only that payment may follow the transaction. */
  fingerprint: string;
  /** Authorization style the transaction was built with. */
  style: AuthorizationStyle;
  /** Gas counted for the transaction (its full limit), to correct once its real cost is known. */
  gas?: GasCharge;
  /** True while a settle retry is following the transaction (one at a time). */
  following: boolean;
}

export interface AuthorizationId {
  network: string;
  /** CEP-18 package hash, 64 hex. */
  asset: string;
  /** Payer, "00" + 64 hex. */
  from: string;
  /** 32-byte nonce, 64 hex. */
  nonce: string;
}

export interface LedgerEntry {
  readonly key: string;
  readonly id: AuthorizationId;
  readonly value: bigint;
  state: LedgerState;
  validBeforeMs: number;
  expiresAtMs: number;
  txHash?: string;
  /** Expiry of the `verified` hold this settlement claimed, restored by `release`. */
  verifiedExpiresAtMs?: number;
  /** Set while the submitted transaction's outcome is unknown to the payment's settles. */
  unresolved?: UnresolvedSettlement;
}

/** A claim on an unresolved settlement, for a settle retry of the same payment. */
export interface FollowClaim {
  txHash: string;
  unresolved: Readonly<Omit<UnresolvedSettlement, "following">>;
}

export type LedgerAcquire =
  | { ok: true }
  | { ok: false; reason: "duplicate"; state: LedgerState; txHash?: string }
  | { ok: false; reason: "full" };

export interface AuthorizationLedgerOptions {
  /** How long a verified-but-not-yet-settled authorization is held. Default 180 s. */
  verifiedHoldMs?: number;
  /** Extra retention after validBefore / tx TTL (clock skew). Default 60 s. */
  graceMs?: number;
  /** Absolute cap on how long any entry is kept. Default 2 h. */
  maxRetentionMs?: number;
  /** Fail closed (HTTP 503) instead of evicting when this many entries are live. Default 50 000. */
  maxEntries?: number;
  now?: () => number;
}

const norm = (s: string) => s.toLowerCase().replace(/^0x/, "");

export function ledgerKey(id: AuthorizationId): string {
  return [id.network, norm(id.asset).replace(/^hash-/, ""), norm(id.from), norm(id.nonce)].join("|");
}

export class AuthorizationLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly verifiedHoldMs: number;
  private readonly graceMs: number;
  private readonly maxRetentionMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: AuthorizationLedgerOptions = {}) {
    this.verifiedHoldMs = opts.verifiedHoldMs ?? 180_000;
    this.graceMs = opts.graceMs ?? 60_000;
    this.maxRetentionMs = opts.maxRetentionMs ?? 2 * 60 * 60_000;
    this.maxEntries = opts.maxEntries ?? 50_000;
    this.now = opts.now ?? Date.now;
  }

  /** Live entry for an authorization, if any (expired entries are dropped). */
  peek(id: AuthorizationId): LedgerEntry | undefined {
    const key = ledgerKey(id);
    const entry = this.entries.get(key);
    if (entry && entry.expiresAtMs <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private duplicate(entry: LedgerEntry): LedgerAcquire {
    return { ok: false, reason: "duplicate", state: entry.state, ...(entry.txHash ? { txHash: entry.txHash } : {}) };
  }

  private hasRoom(): boolean {
    if (this.entries.size < this.maxEntries) return true;
    this.sweep();
    return this.entries.size < this.maxEntries;
  }

  private settleRetention(validBeforeMs: number, minUntilMs = 0): number {
    const now = this.now();
    return Math.min(Math.max(validBeforeMs, minUntilMs, now) + this.graceMs, now + this.maxRetentionMs);
  }

  /**
   * /verify: reject any authorization the ledger already knows, otherwise mark
   * it `verified` for a short hold so a concurrent replay cannot also pass.
   */
  markVerified(id: AuthorizationId, value: bigint, validBeforeSec: number): LedgerAcquire {
    const existing = this.peek(id);
    if (existing) return this.duplicate(existing);
    if (!this.hasRoom()) return { ok: false, reason: "full" };
    const key = ledgerKey(id);
    const validBeforeMs = validBeforeSec * 1000;
    const now = this.now();
    this.entries.set(key, {
      key,
      id,
      value,
      state: "verified",
      validBeforeMs,
      expiresAtMs: Math.min(validBeforeMs + this.graceMs, now + this.verifiedHoldMs),
    });
    return { ok: true };
  }

  /**
   * /settle: claim the authorization for settlement. A `verified` entry for the
   * same value (the normal verify → settle flow) or no entry may proceed;
   * anything already settling, submitted or settled — or a second, different
   * authorization reusing a verified nonce — is a duplicate.
   */
  beginSettle(id: AuthorizationId, value: bigint, validBeforeSec: number): LedgerAcquire {
    const existing = this.peek(id);
    if (existing && (existing.state !== "verified" || existing.value !== value)) return this.duplicate(existing);
    if (!existing && !this.hasRoom()) return { ok: false, reason: "full" };
    const key = ledgerKey(id);
    const validBeforeMs = validBeforeSec * 1000;
    this.entries.set(key, {
      key,
      id,
      value,
      state: "settling",
      validBeforeMs,
      expiresAtMs: this.settleRetention(validBeforeMs),
      ...(existing ? { verifiedExpiresAtMs: existing.expiresAtMs } : {}),
    });
    return { ok: true };
  }

  /** A transaction was (or may have been) submitted: keep the entry until it can no longer execute. */
  markSubmitted(id: AuthorizationId, txHash: string, mayExecuteUntilMs: number): void {
    const entry = this.entries.get(ledgerKey(id));
    if (!entry) return;
    entry.state = "submitted";
    entry.txHash = txHash;
    entry.expiresAtMs = this.settleRetention(entry.validBeforeMs, mayExecuteUntilMs);
  }

  /** The transfer executed successfully: the value is now reflected in the on-chain balance. */
  markSettled(id: AuthorizationId, txHash: string): void {
    this.finish(id, txHash, "settled");
  }

  /** The transaction executed and reverted: nothing moved, but do not resubmit it. */
  markFailed(id: AuthorizationId, txHash: string): void {
    this.finish(id, txHash, "failed");
  }

  private finish(id: AuthorizationId, txHash: string, state: "settled" | "failed"): void {
    const entry = this.entries.get(ledgerKey(id));
    if (!entry) return;
    entry.state = state;
    entry.txHash = txHash;
    delete entry.unresolved;
    entry.expiresAtMs = this.settleRetention(entry.validBeforeMs);
  }

  /**
   * The settle that submitted `txHash` answers without a final outcome
   * ("pending" or "unknown"): remember the transaction with the fingerprint of
   * the exact payment, so a retry of that payment can follow it
   * ({@link followUnresolved}) instead of submitting another transaction.
   */
  markUnresolved(id: AuthorizationId, txHash: string, unresolved: Omit<UnresolvedSettlement, "following">): void {
    const entry = this.entries.get(ledgerKey(id));
    if (!entry || entry.state !== "submitted" || entry.txHash !== txHash) return;
    entry.unresolved = { ...unresolved, following: false };
  }

  /**
   * Pending-settlement lookup for a settle retry: when this authorization has
   * an unresolved transaction, was submitted for the SAME payment
   * (`fingerprint`) and no other request is following it, claim it and return
   * its hash. Anything else (no entry, a final outcome, another payment for the
   * same nonce, a concurrent follower) returns `undefined`. The facilitator
   * core then answers every settle of an entry that has a transaction hash
   * ({@link peek}) as a duplicate carrying that hash, before any other check,
   * so a retry near validBefore is never told "not submitted".
   */
  followUnresolved(id: AuthorizationId, fingerprint: string): FollowClaim | undefined {
    const entry = this.peek(id);
    const unresolved = entry?.unresolved;
    if (!entry || entry.state !== "submitted" || !entry.txHash || !unresolved) return undefined;
    if (unresolved.following || unresolved.fingerprint !== fingerprint) return undefined;
    unresolved.following = true;
    const { following: _following, ...rest } = unresolved;
    return { txHash: entry.txHash, unresolved: rest };
  }

  /**
   * A follower saw no final outcome either: the next retry may follow the
   * transaction again (`status` records what this follower answered).
   */
  stopFollowing(id: AuthorizationId, status: UnresolvedSettlement["status"]): void {
    const unresolved = this.entries.get(ledgerKey(id))?.unresolved;
    if (!unresolved) return;
    unresolved.following = false;
    unresolved.status = status;
  }

  /**
   * Undo a claim for which nothing was submitted (settle failed before
   * submission). A claim taken over from /verify returns to its `verified`
   * hold, so a concurrent replay still cannot pass /verify; otherwise the
   * entry is dropped. Submitted or settled entries are never released.
   */
  release(id: AuthorizationId): void {
    const key = ledgerKey(id);
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.state === "settling" && entry.verifiedExpiresAtMs !== undefined && entry.verifiedExpiresAtMs > this.now()) {
      entry.state = "verified";
      entry.expiresAtMs = entry.verifiedExpiresAtMs;
      delete entry.verifiedExpiresAtMs;
      return;
    }
    if (entry.state === "verified" || entry.state === "settling") this.entries.delete(key);
  }

  /**
   * Sum of the values of this payer's authorizations that are in flight on
   * this asset and not yet reflected in its on-chain balance (verified,
   * settling, submitted), excluding `except`.
   */
  reservedSpend(network: string, asset: string, from: string, except?: AuthorizationId): bigint {
    const now = this.now();
    const skip = except ? ledgerKey(except) : undefined;
    const a = norm(asset).replace(/^hash-/, "");
    const f = norm(from);
    let total = 0n;
    for (const e of this.entries.values()) {
      if (e.expiresAtMs <= now || e.key === skip || e.state === "settled" || e.state === "failed") continue;
      if (e.id.network === network && norm(e.id.asset).replace(/^hash-/, "") === a && norm(e.id.from) === f) total += e.value;
    }
    return total;
  }

  /** Remove expired entries; returns how many were removed. */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= now) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }
}
