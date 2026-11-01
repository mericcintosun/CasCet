import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AuthorizationLedger, ledgerKey, type AuthorizationId } from "./authorization-ledger.js";
import { FakeClock } from "./test-helpers.js";

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const sec = (ms: number) => Math.floor(ms / 1000);

const id = (nonceByte = "aa", from = `00${"11".repeat(32)}`, asset = "cb".repeat(32)): AuthorizationId => ({
  network: "casper:casper-test",
  asset,
  from,
  nonce: nonceByte.repeat(32),
});

function ledger(clock: FakeClock, opts: { maxEntries?: number } = {}) {
  return new AuthorizationLedger({
    now: clock.now,
    verifiedHoldMs: 180_000,
    graceMs: 60_000,
    maxRetentionMs: 2 * 3_600_000,
    ...opts,
  });
}

describe("in-flight nonce ledger (M09)", () => {
  test("the key is normalized (case, 0x, hash- prefix)", () => {
    assert.equal(
      ledgerKey({ network: "casper:casper", asset: `hash-${"CB".repeat(32)}`, from: `00${"AB".repeat(32)}`, nonce: `0x${"EE".repeat(32)}` }),
      ledgerKey({ network: "casper:casper", asset: "cb".repeat(32), from: `00${"ab".repeat(32)}`, nonce: "ee".repeat(32) }),
    );
  });

  test("a verified authorization blocks a second /verify of the same nonce", () => {
    const clock = new FakeClock(T0);
    const l = ledger(clock);
    const validBefore = sec(T0) + 300;
    assert.deepEqual(l.markVerified(id(), 5n, validBefore), { ok: true });
    assert.deepEqual(l.markVerified(id(), 5n, validBefore), { ok: false, reason: "duplicate", state: "verified" });
    assert.deepEqual(l.markVerified(id("bb"), 5n, validBefore), { ok: true });
  });

  test("verify → settle proceeds once; every later attempt is a 409 duplicate", () => {
    const clock = new FakeClock(T0);
    const l = ledger(clock);
    const vb = sec(T0) + 300;
    l.markVerified(id(), 5n, vb);
    assert.deepEqual(l.beginSettle(id(), 5n, vb), { ok: true });
    assert.equal(l.beginSettle(id(), 5n, vb).ok, false);
    l.markSubmitted(id(), "f0".repeat(32), T0 + 600_000);
    assert.deepEqual(l.beginSettle(id(), 5n, vb), { ok: false, reason: "duplicate", state: "submitted", txHash: "f0".repeat(32) });
    l.markSettled(id(), "f0".repeat(32));
    assert.equal(l.markVerified(id(), 5n, vb).ok, false);
  });

  test("a different authorization reusing a verified nonce cannot take it over", () => {
    const clock = new FakeClock(T0);
    const l = ledger(clock);
    l.markVerified(id(), 5n, sec(T0) + 300);
    assert.deepEqual(l.beginSettle(id(), 999n, sec(T0) + 300), { ok: false, reason: "duplicate", state: "verified" });
  });

  test("release undoes a claim only when nothing was submitted", () => {
    const clock = new FakeClock(T0);
    const l = ledger(clock);
    const vb = sec(T0) + 300;

    // Claim taken over from /verify returns to the verified hold.
    l.markVerified(id(), 5n, vb);
    l.beginSettle(id(), 5n, vb);
    l.release(id());
    assert.equal(l.peek(id())?.state, "verified");
    assert.deepEqual(l.beginSettle(id(), 5n, vb), { ok: true });

    // A settle without a prior /verify is dropped entirely.
    l.beginSettle(id("bb"), 5n, vb);
    l.release(id("bb"));
    assert.equal(l.peek(id("bb")), undefined);

    // Submitted entries are never released.
    l.markSubmitted(id(), "f1".repeat(32), T0 + 600_000);
    l.release(id());
    assert.equal(l.peek(id())?.state, "submitted");
  });

  test("verified holds expire; settled entries live until validBefore + grace", () => {
    const clock = new FakeClock(T0);
    const l = ledger(clock);
    const vb = sec(T0) + 900; // 15 minutes
    l.markVerified(id(), 5n, vb);
    clock.advance(180_001); // past the 3-minute verified hold
    assert.equal(l.peek(id()), undefined);
    assert.deepEqual(l.markVerified(id(), 5n, vb), { ok: true });

    l.beginSettle(id(), 5n, vb);
    l.markSubmitted(id(), "f2".repeat(32), clock.ms + 60_000);
    l.markSettled(id(), "f2".repeat(32));
    clock.ms = vb * 1000 + 59_000;
    assert.equal(l.peek(id())?.state, "settled");
    clock.ms = vb * 1000 + 60_001;
    assert.equal(l.peek(id()), undefined);
  });

  test("a pending submission is kept until the transaction can no longer execute", () => {
    const clock = new FakeClock(T0);
    const l = ledger(clock);
    const vb = sec(T0) + 60; // authorization expires before the tx TTL
    l.beginSettle(id(), 5n, vb);
    l.markSubmitted(id(), "f3".repeat(32), T0 + 600_000); // tx TTL 10 min
    clock.ms = T0 + 600_000 + 59_000;
    assert.equal(l.peek(id())?.state, "submitted");
    clock.ms = T0 + 600_000 + 60_001;
    assert.equal(l.peek(id()), undefined);
  });

  test("retention is capped, so a far-future validBefore cannot pin memory forever", () => {
    const clock = new FakeClock(T0);
    const l = ledger(clock);
    l.beginSettle(id(), 5n, sec(T0) + 30 * 24 * 3600);
    clock.advance(2 * 3_600_000 + 1);
    assert.equal(l.peek(id()), undefined);
  });

  test("reservedSpend counts in-flight values of one payer and asset only", () => {
    const clock = new FakeClock(T0);
    const l = ledger(clock);
    const vb = sec(T0) + 300;
    const payer = `00${"11".repeat(32)}`;
    const other = `00${"22".repeat(32)}`;
    l.markVerified(id("01", payer), 10n, vb); // verified
    l.beginSettle(id("02", payer), 20n, vb); // settling
    l.beginSettle(id("03", payer), 40n, vb);
    l.markSubmitted(id("03", payer), "f4".repeat(32), T0 + 600_000); // submitted (pending)
    l.beginSettle(id("04", payer), 80n, vb);
    l.markSubmitted(id("04", payer), "f5".repeat(32), T0 + 600_000);
    l.markSettled(id("04", payer), "f5".repeat(32)); // already in the balance
    l.beginSettle(id("05", payer), 160n, vb);
    l.markSubmitted(id("05", payer), "f6".repeat(32), T0 + 600_000);
    l.markFailed(id("05", payer), "f6".repeat(32)); // reverted: nothing moved
    l.markVerified(id("06", other), 1000n, vb); // other payer
    l.markVerified(id("07", payer, "dd".repeat(32)), 2000n, vb); // other asset

    const asset = "cb".repeat(32);
    assert.equal(l.reservedSpend("casper:casper-test", asset, payer), 70n);
    assert.equal(l.reservedSpend("casper:casper-test", `hash-${asset}`, payer.toUpperCase(), id("02", payer)), 50n);
    assert.equal(l.reservedSpend("casper:casper", asset, payer), 0n);
    clock.advance(180_001); // the verified hold of "01" expires
    assert.equal(l.reservedSpend("casper:casper-test", asset, payer), 60n);
  });

  test("fails closed when full instead of evicting live entries", () => {
    const clock = new FakeClock(T0);
    const l = ledger(clock, { maxEntries: 2 });
    const vb = sec(T0) + 300;
    assert.equal(l.markVerified(id("01"), 1n, vb).ok, true);
    assert.equal(l.beginSettle(id("02"), 1n, vb).ok, true);
    assert.deepEqual(l.markVerified(id("03"), 1n, vb), { ok: false, reason: "full" });
    assert.deepEqual(l.beginSettle(id("03"), 1n, vb), { ok: false, reason: "full" });
    clock.advance(180_001); // "01" (verified) expires; sweep makes room
    assert.equal(l.markVerified(id("03"), 1n, vb).ok, true);
    assert.equal(l.size, 2);
  });
});
