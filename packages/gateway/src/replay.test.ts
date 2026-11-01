import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReplayGuard, replayKey } from "./replay.js";

describe("ReplayGuard", () => {
  it("refuses a second reservation of the same authorization", () => {
    const guard = new ReplayGuard();
    const key = replayKey("00AA", "0xBB");
    assert.equal(guard.reserve(key, Date.now() + 60_000), "reserved");
    assert.equal(guard.reserve(key, Date.now() + 60_000), "duplicate");
  });

  it("normalizes case and the 0x prefix in keys", () => {
    assert.equal(replayKey("00AA", "0xBB"), replayKey("00aa", "bb"));
  });

  it("releases an uncommitted reservation but keeps a committed one", () => {
    const guard = new ReplayGuard();
    guard.reserve("a", Date.now() + 60_000);
    guard.release("a");
    assert.equal(guard.reserve("a", Date.now() + 60_000), "reserved");
    guard.commit("a");
    guard.release("a");
    assert.equal(guard.reserve("a", Date.now() + 60_000), "duplicate");
  });

  it("forgets an authorization once it has expired", () => {
    let now = 1_000_000;
    const guard = new ReplayGuard({ now: () => now });
    guard.reserve("a", now + 10);
    guard.commit("a");
    now += 11;
    assert.equal(guard.reserve("a", now + 10), "reserved");
  });

  it("refuses new payments instead of evicting live entries when full", () => {
    let now = 0;
    const guard = new ReplayGuard({ maxEntries: 2, now: () => now });
    guard.reserve("a", 100);
    guard.reserve("b", 100);
    assert.equal(guard.reserve("c", 100), "full");
    assert.equal(guard.reserve("a", 100), "duplicate");
    now = 200;
    assert.equal(guard.reserve("c", 300), "reserved", "expired entries are pruned to make room");
  });

  it("markUsed records authorizations from before a restart and ignores expired ones", () => {
    const now = 5_000;
    const guard = new ReplayGuard({ now: () => now });
    guard.markUsed("old", now - 1);
    guard.markUsed("live", now + 1_000);
    assert.equal(guard.reserve("old", now + 10), "reserved");
    assert.equal(guard.reserve("live", now + 10), "duplicate");
  });
});
