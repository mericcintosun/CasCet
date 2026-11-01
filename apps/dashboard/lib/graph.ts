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

type FormatAmount = (raw: bigint, symbol: string) => string;

/** The two lines of an edge label: ["get_rwa_price" or "3 tools", "7 calls · 3.5 WCSPR"]. */
export function edgeLabelLines(e: AggregatedEdge, formatAmount: FormatAmount): [string, string] {
  const tools = e.tools.length === 1 ? e.tools[0]! : `${e.tools.length} tools`;
  const calls = `${e.calls} call${e.calls === 1 ? "" : "s"}`;
  const amount = e.totals.map((t) => formatAmount(t.raw, t.symbol)).join(" + ");
  return [tools, `${calls} · ${amount}`];
}

/** "get_rwa_price · 4 calls · 2 WCSPR" or "3 tools · 7 calls · 3.5 WCSPR". */
export function edgeLabel(e: AggregatedEdge, formatAmount: FormatAmount): string {
  return edgeLabelLines(e, formatAmount).join(" · ");
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

// ── layout ───────────────────────────────────────────────────────────────────

export const GRAPH_LAYOUT = {
  NODE_W: 140,
  NODE_H: 44,
  LAYER_GAP: 300,
  ROW_GAP: 96,
  /** y of the first row: leaves room above it for lanes and labels. */
  TOP: 96,
  LEFT: 90,
} as const;

export interface NodePosition {
  id: string;
  kind: "agent" | "server";
  label: string;
  depth: number;
  x: number;
  y: number;
}

/** Layered layout: roots (no incoming edge) at depth 0, every edge pushes its target one layer right. */
export function layoutNodes(graph: PaymentGraph): {
  nodes: NodePosition[];
  byId: Map<string, NodePosition>;
  maxDepth: number;
  maxRow: number;
} {
  const { LAYER_GAP, ROW_GAP, TOP, LEFT } = GRAPH_LAYOUT;
  const depth = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const n of graph.nodes) incoming.set(n.id, 0);
  for (const e of graph.edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  for (const n of graph.nodes) if ((incoming.get(n.id) ?? 0) === 0) depth.set(n.id, 0);
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 100) {
    changed = false;
    for (const e of graph.edges) {
      const d = (depth.get(e.from) ?? 0) + 1;
      if (d > (depth.get(e.to) ?? 0)) {
        depth.set(e.to, d);
        changed = true;
      }
    }
  }
  const rows = new Map<number, number>();
  const nodes: NodePosition[] = graph.nodes.map((n) => {
    const d = depth.get(n.id) ?? 0;
    const row = rows.get(d) ?? 0;
    rows.set(d, row + 1);
    return { ...n, depth: d, x: LEFT + d * LAYER_GAP, y: TOP + row * ROW_GAP };
  });
  return {
    nodes,
    byId: new Map(nodes.map((p) => [p.id, p])),
    maxDepth: Math.max(0, ...nodes.map((p) => p.depth)),
    maxRow: Math.max(1, ...rows.values()),
  };
}

export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface EdgeGeometry {
  edge: AggregatedEdge;
  /** SVG path (absolute M / C / L commands). */
  d: string;
  /** Label anchor: the middle of the edge (on a lane, the label may slide along it). The two label lines sit above it, shifted by `labelDy`. */
  lx: number;
  ly: number;
  labelDy: number;
  /** The label's approximate bounding box after placement. */
  box: Box;
  /** Smallest y the path reaches; with `box` it bounds the drawing (lanes can rise above the first row). */
  top: number;
}

const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** Approximate rendered width of a 10 px label line. */
const textWidth = (s: string): number => s.length * 5.6 + 8;

/** Clearance between the lowest lane and the node tops below it. */
const LANE_CLEARANCE = 16;
/** Distance between stacked lanes: room for a two-line label (30 px) between a lane and the next one up. */
const LANE_SPACING = 34;

/**
 * Paths and label positions (finding M30).
 *
 * An edge to the next layer is an S-curve. An edge that skips layers (an agent
 * buying straight from a data server while another path goes through an
 * analyst) would run straight through the nodes in between and hide behind
 * them, so it rises to a horizontal lane above every node of the skipped
 * layers, runs along it, and comes down into its target. The rise and the
 * descent happen in the free gap next to the source and target layers, so the
 * path never crosses a node. Lanes over overlapping spans are stacked, the
 * lowest lane going to the lowest source, so their rises do not cross.
 *
 * Labels are placed greedily, most important first (highlighted edges, then
 * the busiest), nudged up or down (and on a lane, along it) until they overlap
 * neither a node nor an earlier label. The result keeps the input order, which
 * is the paint order.
 */
export function layoutEdges(
  edges: readonly AggregatedEdge[],
  byId: ReadonlyMap<string, NodePosition>,
  labelLines: (e: AggregatedEdge) => [string, string],
): EdgeGeometry[] {
  const { NODE_W, NODE_H, LAYER_GAP } = GRAPH_LAYOUT;
  const nodes = [...byId.values()];
  // Horizontal run of a lane's rise / descent: inside the gap between two layers.
  const RISE = Math.round((LAYER_GAP - NODE_W) * 0.75);
  const ends = (edge: AggregatedEdge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    return from && to ? { from, to, x0: from.x + NODE_W / 2, x1: to.x - NODE_W / 2 } : null;
  };

  // Lanes, lowest first, handed out from the lowest source row up, so the rises of
  // lanes over the same span never cross each other.
  const laneY = new Map<string, number>();
  const laneSlots: Array<{ x0: number; x1: number; y: number }> = [];
  const skipping = edges
    .flatMap((edge) => {
      const e = ends(edge);
      return e && e.to.depth - e.from.depth > 1 ? [{ edge, ...e }] : [];
    })
    .sort((a, b) => b.from.y - a.from.y || b.to.y - a.to.y);
  for (const { edge, from, to, x0, x1 } of skipping) {
    const skipped = nodes.filter((n) => n.depth > from.depth && n.depth < to.depth);
    let y = Math.min(from.y, to.y, ...skipped.map((n) => n.y)) - NODE_H / 2 - LANE_CLEARANCE;
    // The lowest lane position that no lane over an overlapping span already uses.
    while (laneSlots.some((l) => l.x0 < x1 && x0 < l.x1 && Math.abs(l.y - y) < LANE_SPACING - 4)) y -= LANE_SPACING;
    laneSlots.push({ x0, x1, y });
    laneY.set(edge.key, y);
  }

  const paths = edges.flatMap((edge) => {
    const e = ends(edge);
    if (!e) return [];
    const { from, to, x0, x1 } = e;
    const y = laneY.get(edge.key);
    if (y !== undefined) {
      const h = RISE / 2;
      const d =
        `M ${x0} ${from.y} C ${x0 + h} ${from.y}, ${x0 + h} ${y}, ${x0 + RISE} ${y} ` +
        `L ${x1 - RISE} ${y} C ${x1 - h} ${y}, ${x1 - h} ${to.y}, ${x1} ${to.y}`;
      return [{ edge, d, lx: (x0 + x1) / 2, ly: y, top: y, slide: (x1 - x0) / 2 - RISE }];
    }
    const midX = (x0 + x1) / 2;
    const d = `M ${x0} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${x1} ${to.y}`;
    // The cubic's midpoint (t = 0.5) is exactly (midX, average y).
    return [{ edge, d, lx: midX, ly: (from.y + to.y) / 2, top: Math.min(from.y, to.y), slide: 0 }];
  });

  const taken: Box[] = nodes.map((n) => ({
    x0: n.x - NODE_W / 2 - 4,
    x1: n.x + NODE_W / 2 + 4,
    y0: n.y - NODE_H / 2 - 4,
    y1: n.y + NODE_H / 2 + 4,
  }));
  const placed = new Map<string, { lx: number; labelDy: number; box: Box }>();
  const byPriority = [...paths].sort((a, b) => Number(b.edge.hot) - Number(a.edge.hot) || b.edge.calls - a.edge.calls);
  for (const p of byPriority) {
    const [l1, l2] = labelLines(p.edge);
    const w = Math.max(textWidth(l1), textWidth(l2));
    // A lane's label may slide along the lane's straight run while it stays fully above it.
    const slide = Math.max(0, p.slide - w / 2);
    const dxs = slide > 0 ? [0, -slide, slide] : [0];
    const boxAt = (dx: number, dy: number): Box => ({
      x0: p.lx + dx - w / 2,
      x1: p.lx + dx + w / 2,
      y0: p.ly + dy - 30,
      y1: p.ly + dy - 1,
    });
    let spot = { dx: 0, dy: 0 };
    search: for (const dy of [0, -28, 28, -56, 56, -84, 84, -112, 112]) {
      for (const dx of dxs) {
        if (!taken.some((t) => overlaps(t, boxAt(dx, dy)))) {
          spot = { dx, dy };
          break search;
        }
      }
    }
    const box = boxAt(spot.dx, spot.dy);
    taken.push(box);
    placed.set(p.edge.key, { lx: p.lx + spot.dx, labelDy: spot.dy, box });
  }

  return paths.map(({ slide: _slide, ...p }) => ({ ...p, ...placed.get(p.edge.key)! }));
}
