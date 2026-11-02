import type { PaymentReceipt } from "@cascet/core";

/**
 * Client-side state machine for the /api/onchain feed (finding M16).
 *
 *   loading  → nothing read yet
 *   live     → the last read succeeded
 *   degraded → the last read failed, the previous good data is still shown
 *   error    → no read has ever succeeded; there is no data to show
 *
 * A failure never replaces good data with an empty list, and never reports
 * "live". Pure, so it is unit-tested.
 */
export type OnchainStatus = "loading" | "live" | "degraded" | "error";

export interface OnchainState {
  status: OnchainStatus;
  receipts: PaymentReceipt[];
  /** Message of the most recent failed read, cleared by a successful one. */
  error: string | null;
  /** Epoch ms of the last successful read. */
  updatedAt: number | null;
  network: string | null;
  /** The server read only part of the registry. */
  truncated: boolean;
}

export const INITIAL_ONCHAIN_STATE: OnchainState = {
  status: "loading",
  receipts: [],
  error: null,
  updatedAt: null,
  network: null,
  truncated: false,
};

export type OnchainResult =
  | { ok: true; receipts: PaymentReceipt[]; network: string | null; truncated: boolean }
  | { ok: false; error: string };

const looksLikeReceipt = (r: unknown): r is PaymentReceipt => {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.amountRaw === "string" && typeof o.status === "string";
};

/** Interpret one /api/onchain response (status + parsed JSON body, or null when the body was not JSON). */
export function parseOnchainPayload(httpOk: boolean, httpStatus: number, body: unknown): OnchainResult {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const message = typeof b.error === "string" && b.error ? b.error : null;
  if (!httpOk) return { ok: false, error: message ?? `the receipt feed answered HTTP ${httpStatus}` };
  if (b.ok === false) return { ok: false, error: message ?? "the receipt feed reported a failure" };
  if (!Array.isArray(b.receipts)) return { ok: false, error: "the receipt feed returned a malformed response" };
  return {
    ok: true,
    receipts: b.receipts.filter(looksLikeReceipt),
    network: typeof b.network === "string" ? b.network : null,
    truncated: b.truncated === true,
  };
}

export function reduceOnchain(prev: OnchainState, result: OnchainResult, now: number): OnchainState {
  if (result.ok) {
    return {
      status: "live",
      receipts: result.receipts,
      error: null,
      updatedAt: now,
      network: result.network,
      truncated: result.truncated,
    };
  }
  // Keep whatever was last read successfully; only "error" when nothing ever was.
  return { ...prev, status: prev.updatedAt === null ? "error" : "degraded", error: result.error };
}
