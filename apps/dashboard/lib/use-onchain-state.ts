"use client";

import * as React from "react";
import { buildPaymentGraph, type PaymentReceipt } from "@cascet/core";
import { formatTokens, toBigIntSafe } from "@/lib/utils";
import type { DashboardState } from "@/lib/use-live-state";
import type { OnchainState } from "@/lib/onchain";
import { useOnchainReceipts } from "@/lib/use-onchain-receipts";

/**
 * Seller dashboard state, reconstructed from the on-chain ReceiptRegistry via
 * /api/onchain — the same canonical source the explorer reads. This replaces the
 * in-memory event store on the live deployment, where no gateway process is
 * running to feed /api/stream. Local dev can still POST to /api/ingest; the
 * truth is chain.
 */
const EMPTY: DashboardState = { receipts: [], servers: [], graph: { nodes: [], edges: [] } };

/**
 * Synthesize the seller-facing server + pricing list from settled receipts. A
 * receipt proves a server sold a tool, not that it is up now, so `online` is
 * false: the dashboard labels these "seen on-chain" rather than "online".
 */
function serversFromReceipts(receipts: PaymentReceipt[]): DashboardState["servers"] {
  const byServer = new Map<string, { symbol: string; tools: Map<string, bigint> }>();
  for (const r of receipts) {
    if (r.status !== "settled" || !r.server) continue;
    const entry = byServer.get(r.server) ?? { symbol: r.assetSymbol || "WCSPR", tools: new Map() };
    const amount = toBigIntSafe(r.amountRaw);
    // Listed price = the largest per-call amount observed for that tool.
    if (amount > (entry.tools.get(r.tool) ?? 0n)) entry.tools.set(r.tool, amount);
    byServer.set(r.server, entry);
  }
  return [...byServer.entries()].map(([name, { symbol, tools }]) => ({
    name,
    online: false,
    tools: [...tools.entries()].map(([tool, amount]) => ({
      name: tool,
      priceUsd: formatTokens(amount, 9, symbol),
    })),
  }));
}

export interface OnchainDashboard extends Omit<OnchainState, "receipts"> {
  state: DashboardState;
  latestReceiptId: string | null;
  refresh: () => void;
}

/** Mirrors the shape of {@link useLiveState} so the dashboard page is source-agnostic. */
export function useOnchainState(): OnchainDashboard {
  const { receipts, refresh, ...meta } = useOnchainReceipts();

  const state = React.useMemo<DashboardState>(
    () =>
      receipts.length === 0
        ? EMPTY
        : { receipts, servers: serversFromReceipts(receipts), graph: buildPaymentGraph(receipts) },
    [receipts],
  );

  // /api/onchain returns receipts newest-first, so the freshest is index 0.
  const latestReceiptId = receipts[0]?.id ?? null;

  return { ...meta, state, latestReceiptId, refresh };
}
