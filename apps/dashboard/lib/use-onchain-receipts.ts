"use client";

import * as React from "react";
import { INITIAL_ONCHAIN_STATE, parseOnchainPayload, reduceOnchain, type OnchainResult, type OnchainState } from "@/lib/onchain";

/**
 * Polls /api/onchain (the testnet ReceiptRegistry, reconstructed server-side)
 * and keeps the last good read when a refresh fails. Shared by /dashboard,
 * /explorer and the /connect spend panel.
 */
export function useOnchainReceipts(pollMs = 30_000): OnchainState & { refresh: () => void } {
  const [state, setState] = React.useState<OnchainState>(INITIAL_ONCHAIN_STATE);
  const inFlight = React.useRef(false);
  const alive = React.useRef(true);

  const load = React.useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    let result: OnchainResult;
    try {
      const res = await fetch("/api/onchain", { cache: "no-store" });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      result = parseOnchainPayload(res.ok, res.status, body);
    } catch {
      result = { ok: false, error: "could not reach the receipt feed (network error)" };
    } finally {
      inFlight.current = false;
    }
    if (alive.current) setState((prev) => reduceOnchain(prev, result, Date.now()));
  }, []);

  React.useEffect(() => {
    alive.current = true;
    void load();
    const id = setInterval(() => {
      // Don't poll a background tab; the next visible tick refreshes.
      if (typeof document !== "undefined" && document.hidden) return;
      void load();
    }, pollMs);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [load, pollMs]);

  const refresh = React.useCallback(() => void load(), [load]);
  return { ...state, refresh };
}
