import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AnchoringHealth } from "@cascet/gateway";
import { ANCHOR_POLL_MS, ANCHOR_WAIT_MS, failedAnchorHash, waitForAnchor, type AnchorWaitDeps } from "./demo-anchor.js";
import { FakeClock } from "./test-helpers.js";

const PAYMENT = "c042893b-b7be-48d4-b29f-38a7c4383806";
const ANCHOR = "70e4c416".padEnd(64, "a");
const REGISTRY = "bdf8422b69d7bfb7581e7b2c63fbfb0fc8b23701181289411170bce5cf996f97";

const idle: AnchoringHealth = { state: "closed", consecutiveFailures: 0, queued: 0, inFlight: 0, anchored: 0, failed: 0, skipped: 0 };
const busy: AnchoringHealth = { ...idle, inFlight: 1 };

/** Deps that answer health and receipt reads from scripted sequences (the last entry repeats), on a fake clock. */
function scripted(
  healths: Array<AnchoringHealth | { state: "disabled" }>,
  receipts: Array<{ anchoredTxHash?: string } | undefined>,
): { deps: AnchorWaitDeps; clock: FakeClock; reads: string[]; sleeps: number[] } {
  const clock = new FakeClock(1_000_000);
  const reads: string[] = [];
  const sleeps: number[] = [];
  let h = 0;
  let r = 0;
  return {
    clock,
    reads,
    sleeps,
    deps: {
      health: () => {
        reads.push("health");
        return healths[Math.min(h++, healths.length - 1)]!;
      },
      receiptById: async id => {
        assert.equal(id, PAYMENT);
        reads.push("receipt");
        return receipts[Math.min(r++, receipts.length - 1)];
      },
      now: clock.now,
      sleep: async ms => {
        sleeps.push(ms);
        clock.advance(ms);
      },
    },
  };
}

describe("demo-real: which anchor is this run's", () => {
  test("an executed anchor: the receipt's anchoredTxHash", async () => {
    const { deps, reads, sleeps } = scripted([busy, busy, idle], [{}, {}, { anchoredTxHash: ANCHOR }]);
    assert.deepEqual(await waitForAnchor(PAYMENT, deps), { hash: ANCHOR, note: "anchored" });
    assert.deepEqual(reads, ["health", "receipt", "health", "receipt", "health", "receipt"], "health is read before the receipt, every round");
    assert.deepEqual(sleeps, [ANCHOR_POLL_MS, ANCHOR_POLL_MS]);
  });

  test("an idle anchorer read before a receipt without a hash means no anchor executed", async () => {
    // The anchorer finished between the two reads of a round: the receipt read after the idle health already has the hash.
    const finished = scripted([busy, idle], [{}, { anchoredTxHash: ANCHOR }]);
    assert.deepEqual(await waitForAnchor(PAYMENT, finished.deps), { hash: ANCHOR, note: "anchored" });
    const nothing = scripted([idle], [{}]);
    assert.deepEqual(await waitForAnchor(PAYMENT, nothing.deps), { note: "the anchor did not execute: skipped" });
  });

  test("anchoring disabled", async () => {
    const { deps, sleeps } = scripted([{ state: "disabled" }], [{}]);
    assert.deepEqual(await waitForAnchor(PAYMENT, deps), { note: "anchoring is off" });
    assert.deepEqual(sleeps, []);
  });

  test("an anchor that failed on-chain or did not execute in time: its hash, from the anchorer's last error", async () => {
    for (const lastError of [`anchor ${ANCHOR} failed on-chain: User error: 1 (Unauthorized)`, `anchor ${ANCHOR} not executed within 120000 ms`]) {
      const { deps } = scripted([busy, { ...idle, failed: 1, consecutiveFailures: 1, lastError }], [{}]);
      assert.deepEqual(await waitForAnchor(PAYMENT, deps), { hash: ANCHOR, note: `the anchor did not execute: ${lastError}` });
    }
  });

  test("a submission that failed: no hash, even when the error names another 64-hex value", async () => {
    for (const lastError of [
      "anchor submit failed: invalid chain name",
      `anchor submit failed: Invalid transaction: no such contract package hash-${REGISTRY}`,
      "anchor submit failed: anchor submit timed out after 15000 ms",
    ]) {
      const { deps } = scripted([{ ...idle, failed: 1, lastError }], [{}]);
      assert.deepEqual(await waitForAnchor(PAYMENT, deps), { note: `the anchor did not execute: ${lastError}` });
    }
  });

  test("gives up after 150 s while the anchor is still queued or in flight, with a last look at the deadline", async () => {
    const { deps, clock, reads, sleeps } = scripted([{ ...idle, queued: 1 }, busy], [undefined, {}]);
    assert.deepEqual(await waitForAnchor(PAYMENT, deps), { note: "still anchoring after 150 s" });
    assert.equal(ANCHOR_WAIT_MS, 150_000);
    assert.equal(clock.ms - 1_000_000, ANCHOR_WAIT_MS);
    assert.equal(sleeps.reduce((a, b) => a + b, 0), ANCHOR_WAIT_MS);
    assert.ok(sleeps.every(ms => ms > 0 && ms <= ANCHOR_POLL_MS));
    assert.equal(reads.filter(r => r === "receipt").length, sleeps.length + 1, "one look after the last sleep");
  });

  test("an anchor found at the deadline still counts", async () => {
    const rounds = ANCHOR_WAIT_MS / ANCHOR_POLL_MS;
    const receipts = [...Array.from({ length: rounds }, () => ({})), { anchoredTxHash: ANCHOR }];
    const { deps } = scripted([busy], receipts);
    assert.deepEqual(await waitForAnchor(PAYMENT, deps), { hash: ANCHOR, note: "anchored" });
  });

  test("reads only a submitted anchor's hash out of the last error", () => {
    assert.equal(failedAnchorHash(`anchor ${ANCHOR} failed on-chain: x`), ANCHOR);
    assert.equal(failedAnchorHash(`anchor submit failed: hash-${REGISTRY}`), undefined);
    assert.equal(failedAnchorHash(`anchor ${ANCHOR.toUpperCase()} failed on-chain: x`), undefined, "the anchorer logs lower-case hashes");
    assert.equal(failedAnchorHash(undefined), undefined);
  });
});
