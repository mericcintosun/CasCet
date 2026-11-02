import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AuthorizationLedger, ledgerKey, type AuthorizationId, type PersistedAuthorization } from "./authorization-ledger.js";
import { FakeClock } from "./test-helpers.js";

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const sec = (ms: number) => Math.floor(ms / 1000);

const id = (nonceByte = "aa", from = `00${"11".repeat(32)}`, asset = "cb".repeat(32)): AuthorizationId => ({
  network: "casper:casper-test",
  asset,
  from,
  nonce: nonceByte.repeat(32),
});

function ledger(clock: FakeClock, opts: { maxEntries?: number; onChange?: () => void } = {}) {
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

  test("verify → settle proceeds once; every later attempt is a duplicate", () => {
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

describe("pending-settlement store (a settle retry never broadcasts twice)", () => {
  const TX = "f0".repeat(32);
  const FINGERPRINT = "aa".repeat(32);
  const charge = { id: 7, day: "2026-11-01", motes: 4_000_000_000n };

  function submitted(clock: FakeClock) {
    const l = ledger(clock);
    const vb = sec(T0) + 300;
    assert.equal(l.beginSettle(id(), 5n, vb).ok, true);
    l.markSubmitted(id(), TX, T0 + 298_000);
    return l;
  }

  test("only a transaction whose settle answered pending/unknown can be followed, and only by the same payment", () => {
    const clock = new FakeClock(T0);
    const l = submitted(clock);
    // Still being waited on by the request that submitted it: not followable.
    assert.equal(l.followUnresolved(id(), FINGERPRINT), undefined);
    l.markUnresolved(id(), TX, { status: "pending", fingerprint: FINGERPRINT, style: "cep3009-value", gas: charge });
    assert.equal(l.followUnresolved(id(), "bb".repeat(32)), undefined, "another payment for the same nonce");
    assert.equal(l.followUnresolved(id("bb"), FINGERPRINT), undefined, "another authorization");
    assert.deepEqual(l.followUnresolved(id(), FINGERPRINT), {
      txHash: TX,
      unresolved: { status: "pending", fingerprint: FINGERPRINT, style: "cep3009-value", gas: charge },
    });
    // One follower at a time; the others are duplicates.
    assert.equal(l.followUnresolved(id(), FINGERPRINT), undefined);
    assert.deepEqual(l.beginSettle(id(), 5n, sec(T0) + 300), { ok: false, reason: "duplicate", state: "submitted", txHash: TX });
    l.stopFollowing(id(), "unknown");
    assert.equal(l.followUnresolved(id(), FINGERPRINT)?.unresolved.status, "unknown", "followable again");
  });

  test("a final outcome ends it: settled and failed transactions are duplicates, never followed", () => {
    const clock = new FakeClock(T0);
    for (const finish of ["markSettled", "markFailed"] as const) {
      const l = submitted(clock);
      l.markUnresolved(id(), TX, { status: "pending", fingerprint: FINGERPRINT, style: "legacy-amount" });
      l[finish](id(), TX);
      assert.equal(l.peek(id())?.unresolved, undefined);
      assert.equal(l.followUnresolved(id(), FINGERPRINT), undefined);
    }
  });

  test("it only records the transaction this authorization submitted, and expires with the entry", () => {
    const clock = new FakeClock(T0);
    const l = submitted(clock);
    l.markUnresolved(id(), "f1".repeat(32), { status: "pending", fingerprint: FINGERPRINT, style: "legacy-amount" });
    assert.equal(l.peek(id())?.unresolved, undefined, "another hash");
    l.markUnresolved(id(), TX, { status: "pending", fingerprint: FINGERPRINT, style: "legacy-amount" });
    clock.advance(300_000 + 60_001); // validBefore + grace
    assert.equal(l.followUnresolved(id(), FINGERPRINT), undefined);
  });
});

describe("what a state file keeps, and a restart restores (F11)", () => {
  const TX = "f0".repeat(32);
  const FINGERPRINT = "aa".repeat(32);
  const OTHER_PAYMENT = "bb".repeat(32);

  test("a transaction is kept from the moment it is recorded, before broadcast; entries without one are not", () => {
    const clock = new FakeClock(T0);
    let changes = 0;
    const l = ledger(clock, { onChange: () => changes++ });
    const vb = sec(T0) + 300;

    l.markVerified(id(), 5n, vb);
    l.beginSettle(id(), 5n, vb);
    l.markVerified(id("bb"), 7n, vb);
    assert.deepEqual([l.persistedAuthorizations(), changes], [[], 0], "verified and settling claims are memory only");
    assert.equal(l.recordSubmission(id("cc"), { txHash: TX, fingerprint: FINGERPRINT, style: "legacy-amount" }), false, "no claim to record it on");
    assert.equal(l.recordSubmission(id("bb"), { txHash: TX, fingerprint: FINGERPRINT, style: "legacy-amount" }), false, "verified, not claimed");

    // Write-ahead: still `settling` in memory, but kept as a transaction that may have reached the node.
    assert.equal(l.recordSubmission(id(), { txHash: TX, fingerprint: FINGERPRINT, style: "legacy-amount" }), true);
    assert.equal(l.peek(id())?.state, "settling");
    assert.equal(l.peek(id())?.txHash, undefined, "no transaction to report to other requests before the broadcast");
    const unknown = { id: id(), txHash: TX, state: "submitted", validBefore: vb, value: 5n, status: "unknown", fingerprint: FINGERPRINT, style: "legacy-amount" };
    assert.deepEqual(l.persistedAuthorizations(), [unknown]);
    assert.equal(changes, 1);

    // The node rejected it: the record goes with the claim, which returns to its verified hold.
    l.release(id());
    assert.equal(l.peek(id())?.state, "verified");
    assert.deepEqual([l.persistedAuthorizations(), changes], [[], 2]);

    // Recorded, broadcast, still waited on by its settle: submitted, status unknown.
    l.beginSettle(id(), 5n, vb);
    l.recordSubmission(id(), { txHash: TX, fingerprint: FINGERPRINT, style: "legacy-amount" });
    l.markSubmitted(id(), TX, T0 + 298_000);
    assert.deepEqual(l.persistedAuthorizations(), [unknown]);
    // The settle answers pending, a follower answers unknown, then the outcome is known.
    l.markUnresolved(id(), TX, { status: "pending", fingerprint: FINGERPRINT, style: "legacy-amount" });
    assert.deepEqual(l.persistedAuthorizations(), [{ ...unknown, status: "pending" }]);
    const before = changes;
    assert.ok(l.followUnresolved(id(), FINGERPRINT));
    l.stopFollowing(id(), "pending");
    assert.equal(changes, before, "following and an unchanged status save nothing");
    l.followUnresolved(id(), FINGERPRINT);
    l.stopFollowing(id(), "unknown");
    assert.deepEqual(l.persistedAuthorizations(), [unknown]);
    l.markSettled(id(), TX);
    assert.deepEqual(l.persistedAuthorizations(), [{ id: id(), txHash: TX, state: "settled", validBefore: vb }], "a final outcome keeps only the hash");
    assert.equal(changes, 7);
  });

  test("restored: a pending transaction is followed by the same payment only, stays in flight, and is never settled again", () => {
    const clock = new FakeClock(T0);
    const vb = sec(T0) + 300;
    const first = ledger(clock);
    first.beginSettle(id(), 5n, vb);
    first.recordSubmission(id(), { txHash: TX, fingerprint: FINGERPRINT, style: "cep3009-value" });
    first.markSubmitted(id(), TX, T0 + 298_000);
    first.markUnresolved(id(), TX, { status: "pending", fingerprint: FINGERPRINT, style: "cep3009-value" });
    first.beginSettle(id("bb"), 7n, vb);
    first.markSubmitted(id("bb"), "f1".repeat(32), T0 + 298_000);
    first.markFailed(id("bb"), "f1".repeat(32));
    const saved = first.persistedAuthorizations();

    clock.advance(30_000); // a restart
    let changes = 0;
    const next = ledger(clock, { onChange: () => changes++ });
    assert.equal(next.restore(saved), 2);
    assert.equal(changes, 0, "restoring is not a change to save");
    assert.deepEqual(next.persistedAuthorizations(), saved, "a restart loses nothing");

    // Every other settle or verify of the authorization is a duplicate with the hash.
    assert.deepEqual(next.beginSettle(id(), 5n, vb), { ok: false, reason: "duplicate", state: "submitted", txHash: TX });
    assert.deepEqual(next.markVerified(id(), 5n, vb), { ok: false, reason: "duplicate", state: "submitted", txHash: TX });
    assert.deepEqual(next.beginSettle(id("bb"), 7n, vb), { ok: false, reason: "duplicate", state: "failed", txHash: "f1".repeat(32) });
    // Only the identical payment follows the transaction, one follower at a time.
    assert.equal(next.followUnresolved(id(), OTHER_PAYMENT), undefined);
    assert.deepEqual(next.followUnresolved(id(), FINGERPRINT), {
      txHash: TX,
      unresolved: { status: "pending", fingerprint: FINGERPRINT, style: "cep3009-value" },
    });
    assert.equal(next.followUnresolved(id(), FINGERPRINT), undefined);
    // The pending value still counts against the payer's balance; the reverted one does not.
    assert.equal(next.reservedSpend("casper:casper-test", "cb".repeat(32), `00${"11".repeat(32)}`), 5n);
    next.markSettled(id(), TX);
    assert.equal(next.reservedSpend("casper:casper-test", "cb".repeat(32), `00${"11".repeat(32)}`), 0n);
    assert.equal(changes, 1);
  });

  test("a pending record without the payment's fingerprint is not followable: its hash is still answered", () => {
    const clock = new FakeClock(T0);
    const l = ledger(clock);
    l.restore([{ id: id(), txHash: TX, state: "submitted", validBefore: sec(T0) + 300, value: 5n, status: "unknown" }]);
    assert.equal(l.followUnresolved(id(), FINGERPRINT), undefined);
    assert.deepEqual(l.beginSettle(id(), 5n, sec(T0) + 300), { ok: false, reason: "duplicate", state: "submitted", txHash: TX });
  });

  test("expired authorizations are pruned: on restore, from the saved list, and by the sweep (which reports it)", () => {
    const clock = new FakeClock(T0);
    const now = sec(T0);
    const record = (nonceByte: string, validBefore: number): PersistedAuthorization => ({
      id: id(nonceByte),
      txHash: TX,
      state: "settled",
      validBefore,
    });
    let changes = 0;
    const l = ledger(clock, { onChange: () => changes++ });
    // validBefore + 60 s grace: gone, just about to go, live.
    assert.equal(l.restore([record("01", now - 61), record("02", now - 59), record("03", now + 300)]), 2);
    assert.deepEqual(l.persistedAuthorizations().map(r => r.id.nonce), ["02".repeat(32), "03".repeat(32)]);
    clock.advance(1_000);
    assert.deepEqual(l.persistedAuthorizations().map(r => r.id.nonce), ["03".repeat(32)], "an expired entry is never saved");
    l.markVerified(id("04"), 1n, now + 600);
    clock.advance(180_000); // the verified hold expires too
    assert.equal(l.sweep(), 2);
    assert.equal(changes, 1, "one save for the sweep that dropped a kept entry");
    clock.advance(300_000);
    assert.equal(l.peek(id("03")), undefined);
    assert.equal(changes, 2, "dropping a kept entry on lookup is reported too");
  });

  test("restore runs once, on an empty ledger, and refuses a duplicate record", () => {
    const clock = new FakeClock(T0);
    const vb = sec(T0) + 300;
    const busy = ledger(clock);
    busy.markVerified(id(), 1n, vb);
    assert.throws(() => busy.restore([]), /empty ledger/);
    const r: PersistedAuthorization = { id: id(), txHash: TX, state: "settled", validBefore: vb };
    assert.throws(() => ledger(clock).restore([r, { ...r, id: { ...r.id, nonce: r.id.nonce.toUpperCase() } }]), /twice/);
  });
});
