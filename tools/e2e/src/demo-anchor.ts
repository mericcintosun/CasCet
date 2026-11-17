import type { AnchoringHealth } from "@cascet/gateway";

/**
 * Which ReceiptRegistry anchor `demo-real` reports for its settled receipt
 * (run-real.ts), so the gas report reads this run's anchor transaction and
 * never another one.
 *
 * The gateway anchors a settled receipt in the background: it queues the
 * anchor while it records the receipt, submits it, and sets the receipt's
 * `anchoredTxHash` only once the anchor executed. A failed anchor leaves its
 * hash in the anchorer's `lastError` ("anchor <hash> failed on-chain: …" or
 * "anchor <hash> not executed within … ms"); a failed submission has none.
 */

/** How long demo-real waits: the gateway confirms an anchor for up to 120 s (`anchoring.confirmTimeoutMs`). */
export const ANCHOR_WAIT_MS = 150_000;
/** Delay between two looks at the receipt. */
export const ANCHOR_POLL_MS = 2_000;

export interface AnchorWaitDeps {
  /** The gateway's anchoring health (`gateway.health().anchoring`). */
  health: () => AnchoringHealth | { state: "disabled" };
  /** A receipt as the gateway lists it (GET /receipts), by payment id. */
  receiptById: (id: string) => Promise<{ anchoredTxHash?: string | undefined } | undefined>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Default {@link ANCHOR_WAIT_MS}. */
  timeoutMs?: number;
  /** Default {@link ANCHOR_POLL_MS}. */
  pollMs?: number;
}

export interface AnchorWait {
  /** The anchor transaction: the executed one, or the one that failed on-chain. */
  hash?: string;
  /** "anchored", or why there is no executed anchor. */
  note: string;
}

/** A submitted anchor's hash in the anchorer's last error (never a hash a submit error happens to mention). */
const SUBMITTED_ANCHOR = /^anchor ([0-9a-f]{64}) /;

/** The hash of the submitted anchor that `lastError` reports, if any. */
export function failedAnchorHash(lastError: string | undefined): string | undefined {
  return lastError === undefined ? undefined : SUBMITTED_ANCHOR.exec(lastError)?.[1];
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Wait until the receipt `paymentId` is anchored, anchoring gives up, or the
 * deadline passes. Each round reads the anchoring health BEFORE the receipt:
 * the gateway sets `anchoredTxHash` before the anchor leaves flight, so an
 * idle anchorer seen first and a receipt without a hash read after it mean the
 * anchor did not execute (and was not about to).
 */
export async function waitForAnchor(paymentId: string, deps: AnchorWaitDeps): Promise<AnchorWait> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = deps.timeoutMs ?? ANCHOR_WAIT_MS;
  const pollMs = deps.pollMs ?? ANCHOR_POLL_MS;
  const deadline = now() + timeoutMs;
  for (;;) {
    const anchoring = deps.health();
    const receipt = await deps.receiptById(paymentId);
    if (receipt?.anchoredTxHash) return { hash: receipt.anchoredTxHash, note: "anchored" };
    if (anchoring.state === "disabled") return { note: "anchoring is off" };
    if (anchoring.queued === 0 && anchoring.inFlight === 0) {
      const failed = failedAnchorHash(anchoring.lastError);
      return { ...(failed ? { hash: failed } : {}), note: `the anchor did not execute: ${anchoring.lastError ?? "skipped"}` };
    }
    const left = deadline - now();
    if (left <= 0) return { note: `still anchoring after ${Math.round(timeoutMs / 1000)} s` };
    await sleep(Math.min(pollMs, left));
  }
}
