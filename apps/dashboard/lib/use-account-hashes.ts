"use client";

import * as React from "react";
import { accountHashFromPublicKey, conversionError } from "@/lib/casper/account-hash";
import type { KeyConversion } from "@/lib/casper/keys";

type Finished = Exclude<KeyConversion, { pending: true }>;

export interface AccountHashLookups {
  /** By lower-case public key; an entry is pending until its conversion finishes. */
  conversions: Map<string, KeyConversion>;
  /** Convert again every key whose converter failed to load (`retryable`). */
  retry: () => void;
}

/**
 * Convert a set of public keys to account hashes (casper-js-sdk, loaded on
 * first use). An invalid key is a final error; a converter that failed to load
 * is a retryable one, cleared by `retry`.
 */
export function useAccountHashes(publicKeys: readonly string[]): AccountHashLookups {
  const [done, setDone] = React.useState<Map<string, Finished>>(() => new Map());
  const [attempt, setAttempt] = React.useState(0);
  const key = [...new Set(publicKeys.map((k) => k.toLowerCase()))].sort().join(",");

  React.useEffect(() => {
    const wanted = key ? key.split(",") : [];
    const todo = wanted.filter((k) => !done.has(k));
    if (todo.length === 0) return;
    let alive = true;
    void Promise.all(
      todo.map(async (k): Promise<readonly [string, Finished]> => {
        try {
          return [k, { hash: await accountHashFromPublicKey(k) }];
        } catch (e) {
          return [k, conversionError(e)];
        }
      }),
    ).then((results) => {
      if (!alive) return;
      setDone((prev) => {
        const next = new Map(prev);
        for (const [k, v] of results) next.set(k, v);
        return next;
      });
    });
    return () => {
      alive = false;
    };
    // `done` is read only to skip finished keys, so it is deliberately not a dependency.
  }, [key, attempt]);

  const retry = React.useCallback(() => {
    setDone((prev) => new Map([...prev].filter(([, v]) => !("retryable" in v && v.retryable))));
    setAttempt((a) => a + 1);
  }, []);

  const conversions = React.useMemo(() => {
    const out = new Map<string, KeyConversion>();
    for (const k of key ? key.split(",") : []) out.set(k, done.get(k) ?? { pending: true });
    return out;
  }, [key, done]);

  return { conversions, retry };
}
