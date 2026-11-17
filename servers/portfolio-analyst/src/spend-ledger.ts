import type { AnalystConfig } from "./config.js";

/**
 * Process-wide bound on what the analyst's wallet may authorize (L03).
 *
 * Every analysis gets its own paying fetch (the cascade parent id differs per
 * inbound call), so the client's session budget only caps ONE analysis. Before
 * an analysis buys anything it therefore reserves the most it can authorize,
 * and it is refused when committed + reserved + that worst case would pass
 * CASCET_MAX_TOTAL. When the analysis ends its reservation is released and what
 * it actually authorized is committed. Concurrent analyses can never overshoot
 * the total together, and a refused analysis buys nothing.
 *
 * The ledger counts signed authorizations, as the client does: an
 * authorization can be settled by whoever holds it until it expires, so it is
 * spent once signed. The count lives in memory and starts at zero on restart.
 */
export class SpendLedger {
  private committed = 0n;
  private reserved = 0n;

  /** @param limitRaw CASCET_MAX_TOTAL in raw token units; undefined = no limit. */
  constructor(readonly limitRaw?: bigint) {}

  /** Raw units authorized by analyses that have finished. */
  get committedRaw(): bigint {
    return this.committed;
  }

  /** Raw units reserved by analyses still in flight. */
  get reservedRaw(): bigint {
    return this.reserved;
  }

  /**
   * Admit one analysis whose worst case is `worstCaseRaw` (undefined = unbounded).
   * Refused with "limit" when it cannot fit even with nothing in flight (the
   * total only grows, so it will not fit before a restart), or with "busy" when
   * it only fails to fit while other analyses hold reservations.
   */
  admit(worstCaseRaw: bigint | undefined): Admission {
    if (this.limitRaw !== undefined) {
      // An unbounded analysis can never be admitted under a total limit (the config rejects that setup).
      if (worstCaseRaw === undefined || this.committed + worstCaseRaw > this.limitRaw) return { ok: false, reason: "limit" };
      if (this.committed + this.reserved + worstCaseRaw > this.limitRaw) return { ok: false, reason: "busy" };
    }
    const amountRaw = worstCaseRaw ?? 0n;
    this.reserved += amountRaw;
    let open = true;
    return {
      ok: true,
      reservation: {
        amountRaw,
        settle: (spentRaw: bigint) => {
          if (!open) return;
          open = false;
          this.reserved -= amountRaw;
          this.committed += spentRaw > 0n ? spentRaw : 0n;
        },
      },
    };
  }
}

export type Admission = { ok: true; reservation: Reservation } | { ok: false; reason: "limit" | "busy" };

export interface Reservation {
  /** What was reserved: the analysis' worst case. */
  readonly amountRaw: bigint;
  /** Release the reservation and commit what the analysis authorized. Only the first call counts. */
  settle(spentRaw: bigint): void;
}

/** What one analysis may authorize, from the configured caps and the size of its purchase plan. */
export interface AnalysisBudget {
  /**
   * Session budget (per asset) of the analysis' paying fetch: the tighter of
   * CASCET_MAX_SESSION and purchases x CASCET_MAX_PER_CALL. Undefined = no cap.
   */
  perAssetRaw?: bigint;
  /** Most the analysis can authorize, summed over assets; what the ledger reserves. Undefined = unbounded. */
  worstCaseRaw?: bigint;
}

/**
 * Worst case of one analysis that makes `purchases` purchases.
 *
 * Each purchase is one paid request, and @x402/fetch signs at most one payment
 * per request (it only re-signs when an onPaymentResponse hook reports a
 * recovery, and @cascet/client registers none), so purchases x per-call cap
 * bounds the analysis. The client enforces the per-asset session budget
 * itself, and the asset allowlist bounds how many assets it can pay in: with
 * one allowlisted asset the whole worst case is enforced by the client.
 */
export function analysisBudget(
  cfg: Pick<AnalystConfig, "maxPerCallRaw" | "maxSessionRaw" | "allowedAssets">,
  purchases: number,
): AnalysisBudget {
  const n = Number.isFinite(purchases) ? Math.max(0, Math.trunc(purchases)) : 0;
  const fromPerCall = cfg.maxPerCallRaw === undefined ? undefined : BigInt(cfg.maxPerCallRaw) * BigInt(n);
  const fromSession = cfg.maxSessionRaw === undefined ? undefined : BigInt(cfg.maxSessionRaw);
  const perAssetRaw = minRaw(fromPerCall, fromSession);
  if (perAssetRaw === undefined) return {};
  const assets = Math.min(cfg.allowedAssets?.length ?? n, n);
  return { perAssetRaw, worstCaseRaw: perAssetRaw * BigInt(assets) };
}

/** The smaller of two optional amounts; undefined only when both are. */
export function minRaw(a: bigint | undefined, b: bigint | undefined): bigint | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a < b ? a : b;
}
