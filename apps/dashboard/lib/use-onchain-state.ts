"use client";

import * as React from "react";
import { buildPaymentGraph, type PaymentReceipt } from "@cascet/core";
import { formatTokens, toBigIntSafe } from "@/lib/utils";
import type { DashboardState } from "@/lib/use-live-state";

/**
 * Seller dashboard state, reconstructed from the on-chain ReceiptRegistry via
 * /api/onchain — the same canonical source the explorer reads. This replaces the
 * in-memory event store on the live deployment, where no gateway process is
 * running to feed /api/stream, so the dashboard shows the real economy instead
 * of an empty one. Local dev can still POST to /api/ingest; the truth is chain.
 */
const EMPTY: DashboardState = { receipts: [], servers: [], graph: { nodes: [], edges: [] } };

/** Synthesize the seller-facing server + pricing list from settled receipts. */
function serversFromReceipts(receipts: PaymentReceipt[]): DashboardState["servers"] {
  const byServer = new Map<string, { symbol: string; tools: Map<string, bigint> }>();
  for (const r of receipts) {
    if (r.status !== "settled" || !r.server) continue;
    const entry = byServer.get(r.server) ?? { symbol: r.assetSymbol || "WCSPR", tools: new Map() };
    const amount = toBigIntSafe(r.amountRaw);
    // List price = the largest per-call amount observed for that tool.
    if (amount > (entry.tools.get(r.tool) ?? 0n)) entry.tools.set(r.tool, amount);
    byServer.set(r.server, entry);
  }
  return [...byServer.entries()].map(([name, { symbol, tools }]) => ({
    name,
    online: true,
    tools: [...tools.entries()].map(([tool, amount]) => ({
      name: tool,
      priceUsd: formatTokens(amount, 9, symbol),
    })),
  }));
}

/**
 * Mirrors the shape of {@link useLiveState} so the dashboard page is source-
 * agnostic, but polls the on-chain projection instead of subscribing to SSE.
 */
export function useOnchainState(): { state: DashboardState; latestReceiptId: string | null; connected: boolean } {
  const [receipts, setReceipts] = React.useState<PaymentReceipt[]>([]);
  const [connected, setConnected] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/onchain", { cache: "no-store" })
        .then(r => r.json())
        .then(d => {
          if (!alive) return;
          setReceipts((d.receipts ?? []) as PaymentReceipt[]);
          setConnected(true);
        })
        .catch(() => {
          if (alive) setConnected(false);
        });
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const state = React.useMemo<DashboardState>(
    () =>
      receipts.length === 0
        ? EMPTY
        : { receipts, servers: serversFromReceipts(receipts), graph: buildPaymentGraph(receipts) },
    [receipts],
  );

  // /api/onchain returns receipts newest-first, so the freshest is index 0.
  const latestReceiptId = receipts[0]?.id ?? null;

  return { state, latestReceiptId, connected };
}
