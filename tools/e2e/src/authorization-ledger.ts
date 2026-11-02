import type { AuthorizationStyle } from "@cascet/core";
import type { GasCharge } from "./gas-budget.js";

/**
 * Ledger of x402 authorizations this facilitator has seen (M09, M21), held in
 * memory, with an optional state file for the ones that have a transaction.
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
 * Single-process by design: Node runs these handlers on one thread, so
 * check-and-mark sequences without an `await` in between are atomic.
 *
 * Restarts (F11): what must survive one is every authorization that has a
 * settlement transaction (submitted, settled, failed). The transaction is
 * recorded before it is broadcast ({@link AuthorizationLedger.recordSubmission}),
 * every change to those entries is reported ({@link AuthorizationLedgerOptions.onChange}),
 * a state file saves {@link AuthorizationLedger.persistedAuthorizations} and a
 * new process puts them back ({@link AuthorizationLedger.restore}). A restored
 * pending entry is handled like a pending settlement of this process: a settle
 * retry of the same payment follows its transaction, and nothing is submitted
 * for the authorization again.
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

/**
 * The settlement transaction built for a claim, recorded before it is
 * broadcast (write-ahead), with the payment it settles.
 */
export interface SubmissionRecord {
  txHash: string;
  /** Fingerprint of the exact payment the transaction settles. */
  fingerprint: string;
  /** Authorization style the transaction is built with. */
  style: AuthorizationStyle;
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
  /**
   * The transaction built for this claim, recorded before it is broadcast: a
   * state file holds it from then on, so no restart forgets a transaction that
   * may have reached the node.
   */
  submission?: SubmissionRecord;
  /** Set while the submitted transaction's outcome is unknown to the payment's settles. */
  unresolved?: UnresolvedSettlement;
}

/**
 * What a state file keeps of one authorization that has a settlement
 * transaction: enough never to submit a second one and to answer a retry with
 * its hash, and, while it is pending, what a settle retry of the same payment
 * needs to follow it and what still counts against the payer's balance.
 */
export interface PersistedAuthorization {
  id: AuthorizationId;
  txHash: string;
  /** `submitted`: no final outcome was seen here, so the transaction may still execute. */
  state: "submitted" | "settled" | "failed";
  /** Unix seconds: from then on neither the authorization nor its transaction can execute. */
  validBefore: number;
  /** Submitted only: the value still counted as in flight against the payer's balance. */
  value?: bigint;
  /** Submitted only: what the last settle of the payment answered; "unknown" when none answered. */
  status?: UnresolvedSettlement["status"];
  /** Submitted only: the payment's fingerprint; without it no retry can follow the transaction, only learn its hash. */
  fingerprint?: string;
  /** Submitted only (with the fingerprint): the style the transaction was built with. */
  style?: AuthorizationStyle;
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
  /**
   * Called after every change to the entries a state file keeps
   * ({@link AuthorizationLedger.persistedAuthorizations}): a transaction recorded,
   * submitted, settled, failed, released or expired, or its pending status
   * changed. Synchronous; a state file schedules a save from it.
   */
  onChange?: () => void;
  now?: () => number;
}

const norm = (s: string) => s.toLowerCase().replace(/^0x/, "");

export function ledgerKey(id: AuthorizationId): string {
  return [id.network, norm(id.asset).replace(/^hash-/, ""), norm(id.from), norm(id.nonce)].join("|");
}

/** Does a state file keep this entry? Every entry with a transaction, broadcast or about to be. */
const persisted = (entry: LedgerEntry): boolean => entry.txHash !== undefined || entry.submission !== undefined;

export class AuthorizationLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly verifiedHoldMs: number;
  private readonly graceMs: number;
  private readonly maxRetentionMs: number;
  private readonly maxEntries: number;
  private readonly onChange: (() => void) | undefined;
  private readonly now: () => number;

  constructor(opts: AuthorizationLedgerOptions = {}) {
    this.verifiedHoldMs = opts.verifiedHoldMs ?? 180_000;
    this.graceMs = opts.graceMs ?? 60_000;
    this.maxRetentionMs = opts.maxRetentionMs ?? 2 * 60 * 60_000;
    this.maxEntries = opts.maxEntries ?? 50_000;
    this.onChange = opts.onChange;
    this.now = opts.now ?? Date.now;
  }

  private changed(): void {
    this.onChange?.();
  }

  /** Remove an entry; a state file is told when it kept the entry. */
  private drop(key: string, entry: LedgerEntry): void {
    this.entries.delete(key);
    if (persisted(entry)) this.changed();
  }

  /** Live entry for an authorization, if any (expired entries are dropped). */
  peek(id: AuthorizationId): LedgerEntry | undefined {
    const key = ledgerKey(id);
    const entry = this.entries.get(key);
    if (entry && entry.expiresAtMs <= this.now()) {
      this.drop(key, entry);
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

  /**
   * Write-ahead: record the transaction built for a `settling` claim, with the
   * payment it settles, before it is broadcast, so a state file holds it before
   * any node can. The claim stays `settling` in memory until
   * {@link markSubmitted}; {@link release} drops the record with the claim (the
   * node rejected the transaction, or it was never broadcast). False when there
   * is no `settling` claim to record it on: then nothing may be submitted.
   */
  recordSubmission(id: AuthorizationId, submission: SubmissionRecord): boolean {
    const entry = this.entries.get(ledgerKey(id));
    if (!entry || entry.state !== "settling") return false;
    entry.submission = { txHash: submission.txHash, fingerprint: submission.fingerprint, style: submission.style };
    this.changed();
    return true;
  }

  /** A transaction was (or may have been) submitted: keep the entry until it can no longer execute. */
  markSubmitted(id: AuthorizationId, txHash: string, mayExecuteUntilMs: number): void {
    const entry = this.entries.get(ledgerKey(id));
    if (!entry) return;
    entry.state = "submitted";
    entry.txHash = txHash;
    entry.expiresAtMs = this.settleRetention(entry.validBeforeMs, mayExecuteUntilMs);
    this.changed();
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
    delete entry.submission;
    entry.expiresAtMs = this.settleRetention(entry.validBeforeMs);
    this.changed();
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
    this.changed();
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
    if (unresolved.status === status) return;
    unresolved.status = status;
    this.changed();
  }

  /**
   * Undo a claim for which nothing was submitted (settle failed before
   * submission). A claim taken over from /verify returns to its `verified`
   * hold, so a concurrent replay still cannot pass /verify; otherwise the
   * entry is dropped. A transaction recorded for the claim but never accepted
   * by the node goes with it. Submitted or settled entries are never released.
   */
  release(id: AuthorizationId): void {
    const key = ledgerKey(id);
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.state === "settling" && entry.verifiedExpiresAtMs !== undefined && entry.verifiedExpiresAtMs > this.now()) {
      const recorded = entry.submission !== undefined;
      entry.state = "verified";
      entry.expiresAtMs = entry.verifiedExpiresAtMs;
      delete entry.verifiedExpiresAtMs;
      delete entry.submission;
      if (recorded) this.changed();
      return;
    }
    if (entry.state === "verified" || entry.state === "settling") this.drop(key, entry);
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

  /**
   * The live entries a state file keeps: every authorization with a settlement
   * transaction. A transaction recorded for broadcast but not yet confirmed
   * submitted is kept as `submitted` with status "unknown": it may have reached
   * the node. So is a submitted one whose settle has not answered yet.
   */
  persistedAuthorizations(): PersistedAuthorization[] {
    const now = this.now();
    const out: PersistedAuthorization[] = [];
    for (const e of this.entries.values()) {
      if (e.expiresAtMs <= now) continue;
      const validBefore = Math.floor(e.validBeforeMs / 1000);
      if (e.state === "settled" || e.state === "failed") {
        if (e.txHash) out.push({ id: e.id, txHash: e.txHash, state: e.state, validBefore });
        continue;
      }
      const txHash = e.state === "submitted" ? e.txHash : e.state === "settling" ? e.submission?.txHash : undefined;
      if (!txHash) continue;
      const payment = e.unresolved ?? e.submission;
      out.push({
        id: e.id,
        txHash,
        state: "submitted",
        validBefore,
        value: e.value,
        status: e.state === "submitted" && e.unresolved ? e.unresolved.status : "unknown",
        ...(payment ? { fingerprint: payment.fingerprint, style: payment.style } : {}),
      });
    }
    return out;
  }

  /**
   * Start-up: put back what a state file kept, into an empty ledger. Entries
   * whose validBefore passed more than the grace period ago are dropped: their
   * transactions can no longer execute. A restored pending entry is followable
   * at once by a settle retry of the same payment (the settle that submitted it
   * is gone) and keeps its value in flight; any other settle of the
   * authorization is a duplicate carrying its hash. Returns how many entries
   * were restored.
   */
  restore(records: readonly PersistedAuthorization[]): number {
    if (this.entries.size > 0) throw new Error("restore() runs at start-up, on an empty ledger");
    const now = this.now();
    for (const r of records) {
      const validBeforeMs = r.validBefore * 1000;
      if (validBeforeMs + this.graceMs <= now) continue;
      const key = ledgerKey(r.id);
      if (this.entries.has(key)) throw new Error(`the state lists authorization ${key} twice`);
      const pending = r.state === "submitted";
      this.entries.set(key, {
        key,
        id: { ...r.id },
        value: pending ? (r.value ?? 0n) : 0n,
        state: r.state,
        validBeforeMs,
        expiresAtMs: Math.min(validBeforeMs + this.graceMs, now + this.maxRetentionMs),
        txHash: r.txHash,
        ...(pending && r.fingerprint !== undefined && r.style !== undefined
          ? { unresolved: { status: r.status ?? "unknown", fingerprint: r.fingerprint, style: r.style, following: false } }
          : {}),
      });
    }
    return this.entries.size;
  }

  /** Remove expired entries; returns how many were removed. */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    let removedPersisted = false;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= now) {
        this.entries.delete(key);
        removed++;
        if (persisted(entry)) removedPersisted = true;
      }
    }
    if (removedPersisted) this.changed();
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }
}
