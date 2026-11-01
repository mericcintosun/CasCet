import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_PURCHASES } from "./analysis.js";
import { SpendLedger, analysisBudget, minRaw } from "./spend-ledger.js";

const ONE_ASSET = [`hash-${"b".repeat(64)}`];

describe("analysisBudget", () => {
  it("takes the tighter of the per-analysis cap and purchases x the per-call cap", () => {
    const cfg = { maxPerCallRaw: "1000000000", maxSessionRaw: "5000000000", allowedAssets: ONE_ASSET };
    assert.deepEqual(analysisBudget(cfg, 4), { perAssetRaw: 4_000_000_000n, worstCaseRaw: 4_000_000_000n });
    assert.deepEqual(analysisBudget(cfg, 1), { perAssetRaw: 1_000_000_000n, worstCaseRaw: 1_000_000_000n });
    assert.deepEqual(analysisBudget({ ...cfg, maxSessionRaw: "1500000000" }, 4), {
      perAssetRaw: 1_500_000_000n,
      worstCaseRaw: 1_500_000_000n,
    });
  });

  it("uses whichever cap is configured", () => {
    assert.deepEqual(analysisBudget({ maxPerCallRaw: "7", allowedAssets: ONE_ASSET }, 3), { perAssetRaw: 21n, worstCaseRaw: 21n });
    assert.deepEqual(analysisBudget({ maxSessionRaw: "9", allowedAssets: ONE_ASSET }, 3), { perAssetRaw: 9n, worstCaseRaw: 9n });
    assert.deepEqual(analysisBudget({}, 3), {}, "no cap: unbounded");
  });

  it("multiplies the per-asset budget by the number of assets the analysis can pay in", () => {
    const twoAssets = [...ONE_ASSET, `hash-${"c".repeat(64)}`];
    assert.equal(analysisBudget({ maxSessionRaw: "10", allowedAssets: twoAssets }, 4).worstCaseRaw, 20n);
    // Without an asset allowlist every purchase could use another asset.
    assert.equal(analysisBudget({ maxSessionRaw: "10" }, 3).worstCaseRaw, 30n);
    // Never more assets than purchases.
    assert.equal(analysisBudget({ maxSessionRaw: "10", allowedAssets: twoAssets }, 1).worstCaseRaw, 10n);
  });

  it("bounds the largest possible plan", () => {
    assert.equal(MAX_PURCHASES, 4);
  });
});

describe("SpendLedger", () => {
  it("admits analyses while committed + reserved + worst case fits the limit", () => {
    const ledger = new SpendLedger(10n);
    const a = ledger.admit(4n);
    const b = ledger.admit(4n);
    assert.ok(a.ok && b.ok);
    assert.equal(ledger.reservedRaw, 8n);
    // Only the running analyses are in the way: "busy", not "limit".
    assert.deepEqual(ledger.admit(4n), { ok: false, reason: "busy" });
    a.reservation.settle(1n);
    b.reservation.settle(3n);
    assert.equal(ledger.reservedRaw, 0n);
    assert.equal(ledger.committedRaw, 4n);
    const c = ledger.admit(6n);
    assert.ok(c.ok);
    c.reservation.settle(6n);
    // 10 committed: nothing fits any more, and never will before a restart.
    assert.deepEqual(ledger.admit(1n), { ok: false, reason: "limit" });
  });

  it("refuses an analysis that could never fit", () => {
    const ledger = new SpendLedger(10n);
    assert.deepEqual(ledger.admit(11n), { ok: false, reason: "limit" });
    assert.deepEqual(ledger.admit(undefined), { ok: false, reason: "limit" }, "unbounded analysis under a limit");
    assert.equal(ledger.reservedRaw, 0n);
  });

  it("counts only the first settle of a reservation", () => {
    const ledger = new SpendLedger(10n);
    const a = ledger.admit(5n);
    assert.ok(a.ok);
    a.reservation.settle(2n);
    a.reservation.settle(5n);
    assert.equal(ledger.committedRaw, 2n);
    assert.equal(ledger.reservedRaw, 0n);
  });

  it("commits what was really authorized, even above the reservation", () => {
    const ledger = new SpendLedger(10n);
    const a = ledger.admit(2n);
    assert.ok(a.ok);
    a.reservation.settle(3n);
    assert.equal(ledger.committedRaw, 3n);
  });

  it("only keeps count without a limit", () => {
    const ledger = new SpendLedger();
    const a = ledger.admit(undefined);
    assert.ok(a.ok);
    a.reservation.settle(7n);
    assert.equal(ledger.committedRaw, 7n);
    assert.ok(ledger.admit(10n ** 30n).ok);
  });
});

describe("minRaw", () => {
  it("returns the smaller amount, or the one that is set", () => {
    assert.equal(minRaw(3n, 5n), 3n);
    assert.equal(minRaw(5n, 3n), 3n);
    assert.equal(minRaw(undefined, 3n), 3n);
    assert.equal(minRaw(3n, undefined), 3n);
    assert.equal(minRaw(undefined, undefined), undefined);
  });
});
