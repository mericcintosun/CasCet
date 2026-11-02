/**
 * Short-lived cache of upstream answers (L24).
 *
 * Without it every paid call hit CoinGecko and cspr.cloud, so their rate
 * limits turned paid calls into sales of months-old snapshot constants. A live
 * answer is reused for `ttlMs`; when the upstream then fails, the last live
 * answer is still used while it is at most `maxStaleMs` old (labeled with its
 * age by the caller) before the snapshot is. Concurrent misses for one key
 * share a single upstream request. Keys come from a small fixed set (coin ids,
 * the cspr.cloud base URL), so entries are never evicted.
 */
export class UpstreamCache<T> {
  private readonly entries = new Map<string, { value: T; fetchedAt: number }>();
  private readonly inflight = new Map<string, Promise<T | undefined>>();
  private readonly now: () => number;

  constructor(private readonly opts: { ttlMs: number; maxStaleMs: number; now?: () => number }) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * The cached or freshly loaded value of `key`. `load` resolves to the live
   * value, or undefined when the upstream is unavailable; it is not called
   * while a fresh entry exists or another load of `key` is running.
   */
  async get(key: string, load: () => Promise<T | undefined>): Promise<CacheHit<T> | undefined> {
    const cached = this.entries.get(key);
    if (cached && this.now() - cached.fetchedAt < this.opts.ttlMs) {
      return { value: cached.value, ageMs: this.now() - cached.fetchedAt, stale: false };
    }
    const fresh = await this.loadOnce(key, load);
    if (fresh !== undefined) return { value: fresh, ageMs: 0, stale: false };
    const last = this.entries.get(key);
    if (last && this.now() - last.fetchedAt <= this.opts.maxStaleMs) {
      return { value: last.value, ageMs: this.now() - last.fetchedAt, stale: true };
    }
    return undefined;
  }

  private loadOnce(key: string, load: () => Promise<T | undefined>): Promise<T | undefined> {
    const running = this.inflight.get(key);
    if (running) return running;
    const promise: Promise<T | undefined> = Promise.resolve()
      .then(load)
      .then(
        value => {
          if (value !== undefined) this.entries.set(key, { value, fetchedAt: this.now() });
          return value;
        },
        () => undefined,
      )
      .finally(() => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }
}

export interface CacheHit<T> {
  value: T;
  /** How long ago the value was fetched from the upstream. */
  ageMs: number;
  /** True when the upstream failed and this is an older live answer. */
  stale: boolean;
}

/** "45 s" / "12 min" / "3 h", for provenance labels. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  return min < 120 ? `${min} min` : `${Math.round(min / 60)} h`;
}
