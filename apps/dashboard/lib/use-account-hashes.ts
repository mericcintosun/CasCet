"use client";

import * as React from "react";
import { accountHashFromPublicKey } from "@/lib/casper/account-hash";
import type { KeyConversion } from "@/lib/casper/keys";

/**
 * Convert a set of public keys to account hashes (casper-js-sdk, loaded on
 * first use). Returns a map keyed by the lower-case public key; entries are
 * pending until their conversion finishes.
 */
export function useAccountHashes(publicKeys: readonly string[]): Map<string, KeyConversion> {
  const [done, setDone] = React.useState<Map<string, Exclude<KeyConversion, { pending: true }>>>(() => new Map());
  const key = [...new Set(publicKeys.map((k) => k.toLowerCase()))].sort().join(",");

  React.useEffect(() => {
    const wanted = key ? key.split(",") : [];
    const todo = wanted.filter((k) => !done.has(k));
    if (todo.length === 0) return;
    let alive = true;
    void Promise.all(
      todo.map(async (k) => {
        try {
          return [k, { hash: await accountHashFromPublicKey(k) }] as const;
        } catch {
          return [k, { error: "not a valid Casper public key", retryable: false }] as const;
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
  }, [key]);

  return React.useMemo(() => {
    const out = new Map<string, KeyConversion>();
    for (const k of key ? key.split(",") : []) out.set(k, done.get(k) ?? { pending: true });
    return out;
  }, [key, done]);
}
