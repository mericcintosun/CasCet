"use client";

import * as React from "react";
import type { PaymentGraph, PaymentReceipt } from "@cascet/core";

export interface DashboardState {
  receipts: PaymentReceipt[];
  servers: Array<{ name: string; tools: Array<{ name: string; priceUsd?: string }>; online: boolean }>;
  graph: PaymentGraph;
}

const EMPTY: DashboardState = { receipts: [], servers: [], graph: { nodes: [], edges: [] } };

/**
 * Loads dashboard state once, then live-updates on every SSE event by refetching
 * the projected state (cheap, and keeps graph/receipt derivations server-side).
 * Also flags the id of the most recent receipt so the UI can animate it.
 */
export function useLiveState(): { state: DashboardState; latestReceiptId: string | null; connected: boolean } {
  const [state, setState] = React.useState<DashboardState>(EMPTY);
  const [latestReceiptId, setLatestReceiptId] = React.useState<string | null>(null);
  const [connected, setConnected] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (res.ok) setState((await res.json()) as DashboardState);
    } catch {
      /* transient */
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const source = new EventSource("/api/stream");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = event => {
      try {
        const parsed = JSON.parse(event.data) as { type?: string; receipt?: PaymentReceipt };
        if (parsed.type === "receipt" && parsed.receipt) setLatestReceiptId(parsed.receipt.id);
        if (parsed.type !== "hello") void refresh();
      } catch {
        /* ignore */
      }
    };
    return () => source.close();
  }, [refresh]);

  return { state, latestReceiptId, connected };
}
