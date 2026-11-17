import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UpstreamCache, formatAge } from "./cache.js";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("UpstreamCache (L24)", () => {
  it("reuses a live answer while it is fresh, then asks the upstream again", async () => {
    const c = clock();
    const cache = new UpstreamCache<number>({ ttlMs: 60_000, maxStaleMs: 900_000, now: c.now });
    let loads = 0;
    const load = async () => ++loads;
    assert.deepEqual(await cache.get("k", load), { value: 1, ageMs: 0, stale: false });
    c.advance(59_000);
    assert.deepEqual(await cache.get("k", load), { value: 1, ageMs: 59_000, stale: false });
    assert.equal(loads, 1);
    c.advance(1_000);
    assert.deepEqual(await cache.get("k", load), { value: 2, ageMs: 0, stale: false });
    assert.equal(loads, 2);
  });

  it("serves the last live answer, with its age, while the upstream fails, until it is too old", async () => {
    const c = clock();
    const cache = new UpstreamCache<string>({ ttlMs: 60_000, maxStaleMs: 900_000, now: c.now });
    await cache.get("k", async () => "live");
    c.advance(300_000);
    assert.deepEqual(await cache.get("k", async () => undefined), { value: "live", ageMs: 300_000, stale: true });
    c.advance(600_001);
    assert.equal(await cache.get("k", async () => undefined), undefined);
  });

  it("treats a throwing load as unavailable and does not cache it", async () => {
    const cache = new UpstreamCache<string>({ ttlMs: 60_000, maxStaleMs: 900_000 });
    assert.equal(
      await cache.get("k", async () => {
        throw new Error("boom");
      }),
      undefined,
    );
    assert.deepEqual(await cache.get("k", async () => "ok"), { value: "ok", ageMs: 0, stale: false });
  });

  it("shares one upstream request between concurrent misses of a key", async () => {
    const cache = new UpstreamCache<number>({ ttlMs: 60_000, maxStaleMs: 900_000 });
    let loads = 0;
    let release: (v: number) => void = () => {};
    const load = () => {
      loads++;
      return new Promise<number>(resolve => (release = resolve));
    };
    const all = Promise.all([cache.get("k", load), cache.get("k", load), cache.get("k", load)]);
    await new Promise(resolve => setImmediate(resolve));
    release(7);
    const hits = await all;
    assert.equal(loads, 1);
    assert.deepEqual(
      hits.map(h => h?.value),
      [7, 7, 7],
    );
    // Other keys load separately.
    assert.equal((await cache.get("other", async () => 8))?.value, 8);
  });

  it("starts a new request once a failed one has finished", async () => {
    const cache = new UpstreamCache<number>({ ttlMs: 60_000, maxStaleMs: 900_000 });
    let loads = 0;
    assert.equal(await cache.get("k", async () => (loads++, undefined)), undefined);
    assert.equal((await cache.get("k", async () => (loads++, 3)))?.value, 3);
    assert.equal(loads, 2);
  });
});

describe("formatAge", () => {
  it("formats seconds, minutes and hours", () => {
    assert.equal(formatAge(0), "0 s");
    assert.equal(formatAge(45_000), "45 s");
    assert.equal(formatAge(300_000), "5 min");
    assert.equal(formatAge(3 * 3_600_000), "3 h");
  });
});
