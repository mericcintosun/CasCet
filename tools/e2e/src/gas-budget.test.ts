import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DailyGasBudget } from "./gas-budget.js";
import { FakeClock } from "./test-helpers.js";

const CSPR = 1_000_000_000n;
const noonUtc = Date.UTC(2026, 10, 1, 12, 0, 0);

describe("daily sponsored-gas cap (M08)", () => {
  test("reserves up to the cap and refuses beyond it", () => {
    const gas = new DailyGasBudget({ capMotes: 10n * CSPR, now: () => noonUtc });
    assert.ok(gas.tryReserve(4n * CSPR));
    assert.ok(gas.tryReserve(4n * CSPR));
    assert.equal(gas.tryReserve(4n * CSPR), undefined);
    assert.equal(gas.snapshot().availableMotes, 2n * CSPR);
  });

  test("releasing a reservation (nothing submitted) gives the gas back, once", () => {
    const gas = new DailyGasBudget({ capMotes: 8n * CSPR, now: () => noonUtc });
    const r = gas.tryReserve(4n * CSPR)!;
    gas.tryReserve(4n * CSPR);
    assert.equal(gas.tryReserve(4n * CSPR), undefined);
    gas.release(r);
    gas.release(r);
    assert.equal(gas.snapshot().reservedMotes, 4n * CSPR);
    assert.ok(gas.tryReserve(4n * CSPR));
  });

  test("a submitted settle counts its real on-chain cost when known", () => {
    const gas = new DailyGasBudget({ capMotes: 100n * CSPR, now: () => noonUtc });
    const known = gas.tryReserve(4n * CSPR)!;
    gas.commit(known, 3_010_000_000n);
    const unknown = gas.tryReserve(4n * CSPR)!;
    gas.commit(unknown); // pending/unknown outcome: count the full limit
    gas.commit(unknown, 1n); // idempotent
    const s = gas.snapshot();
    assert.equal(s.spentMotes, 3_010_000_000n + 4n * CSPR);
    assert.equal(s.reservedMotes, 0n);
  });

  test("the cap resets at 00:00 UTC; in-flight reservations carry over", () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 1, 23, 59, 0));
    const gas = new DailyGasBudget({ capMotes: 8n * CSPR, now: clock.now });
    gas.commit(gas.tryReserve(4n * CSPR)!);
    const inFlight = gas.tryReserve(4n * CSPR)!;
    assert.equal(gas.tryReserve(4n * CSPR), undefined);

    clock.ms = Date.UTC(2026, 10, 2, 0, 0, 1);
    const s = gas.snapshot();
    assert.equal(s.day, "2026-11-02");
    assert.equal(s.spentMotes, 0n);
    assert.equal(s.reservedMotes, 4n * CSPR);
    assert.ok(gas.tryReserve(4n * CSPR));
    // The in-flight settle lands after midnight: it is counted on the new day.
    gas.commit(inFlight, 3n * CSPR);
    assert.equal(gas.snapshot().spentMotes, 3n * CSPR);
  });

  test("rejects nonsensical caps and reservations", () => {
    assert.throws(() => new DailyGasBudget({ capMotes: 0n }));
    assert.throws(() => new DailyGasBudget({ capMotes: CSPR }).tryReserve(0n));
  });
});
