import type { PaymentGraph, PaymentReceipt } from "@cascet/core";
import { toBigIntSafe } from "./utils";

/**
 * Payment-graph helpers (finding M30). `buildPaymentGraph` emits one edge per
 * receipt, and every edge between the same two nodes is drawn on the same
 * curve, so real data overprinted 7-8 identical labels. These helpers collapse
 * them into one edge per (payer node, payee node) with a call count and totals.
 */

export interface AggregatedEdge {
  /** `${from}→${to}` */
  key: string;
  from: string;
  to: string;
  calls: number;
  /** Distinct tools bought over this edge, in first-seen order. */
  tools: string[];
  receiptIds: string[];
  /** Total paid per asset symbol, in first-seen order. */
  totals: Array<{ symbol: string; raw: bigint }>;
  /** True when any receipt on this edge is highlighted. */
  hot: boolean;
}

type Edge = PaymentGraph["edges"][number];

/**
 * One aggregated edge per (from, to). Ordered for painting: normal edges first,
 * highlighted ("hot") edges last so they are drawn on top.
 */
export function aggregateEdges(edges: readonly Edge[], hot?: ReadonlySet<string>): AggregatedEdge[] {
  const byKey = new Map<string, AggregatedEdge & { totalsBy: Map<string, bigint> }>();
  for (const e of edges) {
    const key = `${e.from}→${e.to}`;
    let agg = byKey.get(key);
    if (!agg) {
      agg = { key, from: e.from, to: e.to, calls: 0, tools: [], receiptIds: [], totals: [], hot: false, totalsBy: new Map() };
      byKey.set(key, agg);
    }
    agg.calls += 1;
    if (!agg.tools.includes(e.tool)) agg.tools.push(e.tool);
    agg.receiptIds.push(e.receiptId);
    const symbol = e.assetSymbol || "?";
    agg.totalsBy.set(symbol, (agg.totalsBy.get(symbol) ?? 0n) + toBigIntSafe(e.amountRaw));
    if (hot?.has(e.receiptId)) agg.hot = true;
  }
  const out = [...byKey.values()].map(({ totalsBy, ...a }) => ({
    ...a,
    totals: [...totalsBy.entries()].map(([symbol, raw]) => ({ symbol, raw })),
  }));
  // Stable: Array.prototype.sort keeps insertion order for equal keys.
  return out.sort((a, b) => Number(a.hot) - Number(b.hot));
}

/** "get_rwa_price · 4 calls · 2 WCSPR" or "3 tools · 7 calls · 3.5 WCSPR". */
export function edgeLabel(e: AggregatedEdge, formatAmount: (raw: bigint, symbol: string) => string): string {
  const tools = e.tools.length === 1 ? e.tools[0]! : `${e.tools.length} tools`;
  const calls = `${e.calls} call${e.calls === 1 ? "" : "s"}`;
  const amount = e.totals.map((t) => formatAmount(t.raw, t.symbol)).join(" + ");
  return `${tools} · ${calls} · ${amount}`;
}

/**
 * Ids of every receipt in the same cascade tree as `latestId`: walk up the
 * parent links to the root (any depth, cycle-safe), then take every receipt
 * whose own root is that root. Replaces a one-level walk that highlighted the
 * wrong subtree for N-hop cascades (L102).
 */
export function cascadeReceiptIds(receipts: readonly PaymentReceipt[], latestId: string | null): Set<string> {
  const ids = new Set<string>();
  if (!latestId) return ids;
  const byId = new Map(receipts.map((r) => [r.id, r]));
  if (!byId.has(latestId)) return ids;

  const rootCache = new Map<string, string>();
  const rootOf = (id: string): string => {
    const cached = rootCache.get(id);
    if (cached) return cached;
    const path: string[] = [];
    const seen = new Set<string>();
    let cur = id;
    for (;;) {
      if (rootCache.has(cur)) {
        cur = rootCache.get(cur)!;
        break;
      }
      path.push(cur);
      seen.add(cur);
      const parent = byId.get(cur)?.parentId;
      // Stop at a missing parent (its receipt is not in view) or a cycle.
      if (!parent || !byId.has(parent) || seen.has(parent)) break;
      cur = parent;
    }
    for (const p of path) rootCache.set(p, cur);
    return cur;
  };

  const root = rootOf(latestId);
  for (const r of receipts) if (rootOf(r.id) === root) ids.add(r.id);
  return ids;
}
