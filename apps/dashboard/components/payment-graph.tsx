"use client";

import * as React from "react";
import type { PaymentGraph as GraphData } from "@cascet/core";
import { Bot, Server } from "lucide-react";
import { aggregateEdges, type AggregatedEdge } from "@/lib/graph";
import { formatTokens } from "@/lib/utils";

interface Positioned {
  id: string;
  kind: "agent" | "server";
  label: string;
  depth: number;
  x: number;
  y: number;
}

const NODE_W = 140;
const NODE_H = 44;
const LAYER_GAP = 300;
const ROW_GAP = 96;

/**
 * Layered left-to-right visualization of the cascade. Agents (roots) sit at
 * depth 0; each payment edge pushes its target one layer right, so a multi-hop
 * chain reads as a supply chain of machine-to-machine payments.
 *
 * Receipts between the same two nodes are aggregated into ONE edge with one
 * label ("3 tools · 7 calls · 3.5 WCSPR"); per-receipt detail is in the edge's
 * tooltip. Paint order: lines, then highlighted lines, then labels (with a halo),
 * then nodes, so the highlight is never hidden under other edges (M30).
 */
export function PaymentGraph({
  graph,
  highlightEdgeIds,
  emptyText = "No settled payments yet.",
}: {
  graph: GraphData;
  highlightEdgeIds?: Set<string>;
  emptyText?: string;
}) {
  const uid = React.useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const layout = React.useMemo(() => computeLayout(graph), [graph]);
  const edges = React.useMemo(() => aggregateEdges(graph.edges, highlightEdgeIds), [graph.edges, highlightEdgeIds]);

  if (graph.nodes.length === 0) {
    return (
      <div className="flex h-[320px] items-center justify-center rounded-lg border border-dashed px-4 text-center text-sm text-muted-foreground">
        {emptyText}
      </div>
    );
  }

  const width = Math.max(640, (layout.maxDepth + 1) * LAYER_GAP);
  const height = Math.max(320, layout.maxRow * ROW_GAP + 80);
  const calls = graph.edges.length;
  const geometry = edges
    .map((edge) => {
      const from = layout.byId.get(edge.from);
      const to = layout.byId.get(edge.to);
      if (!from || !to) return null;
      const x0 = from.x + NODE_W / 2;
      const x1 = to.x - NODE_W / 2;
      const midX = (x0 + x1) / 2;
      const d = `M ${x0} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${x1} ${to.y}`;
      // The cubic's midpoint (t = 0.5) is exactly (midX, average y).
      return { edge, d, lx: midX, ly: (from.y + to.y) / 2, fromLabel: from.label, toLabel: to.label };
    })
    .filter((g): g is NonNullable<typeof g> => g !== null);

  return (
    <div className="grid-bg overflow-x-auto rounded-lg border">
      <svg
        width={width}
        height={height}
        className="min-w-full"
        role="img"
        aria-label={`Payment graph: ${graph.nodes.length} participants, ${edges.length} payment links, ${calls} settled calls`}
      >
        <defs>
          <marker id={`arrow-${uid}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="hsl(var(--muted-foreground))" />
          </marker>
          <marker id={`arrow-hot-${uid}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="hsl(var(--primary-text))" />
          </marker>
        </defs>

        {/* 1. lines (aggregateEdges orders highlighted edges last, so they paint on top) */}
        {geometry.map(({ edge, d, fromLabel, toLabel }) => (
          <path
            key={edge.key}
            d={d}
            fill="none"
            stroke={edge.hot ? "hsl(var(--primary-text))" : "hsl(var(--muted-foreground))"}
            strokeWidth={edge.hot ? 2.5 : 1.5}
            strokeOpacity={edge.hot ? 1 : 0.55}
            markerEnd={edge.hot ? `url(#arrow-hot-${uid})` : `url(#arrow-${uid})`}
          >
            <title>{tooltip(edge, fromLabel, toLabel)}</title>
          </path>
        ))}

        {/* 2. one label per edge, above every line */}
        {geometry.map(({ edge, lx, ly, fromLabel, toLabel }) => (
          <text
            key={`label-${edge.key}`}
            x={lx}
            y={ly - 18}
            textAnchor="middle"
            className={edge.hot ? "text-[10px] font-semibold" : "text-[10px]"}
            fill={edge.hot ? "hsl(var(--primary-text))" : "hsl(var(--muted-foreground))"}
            stroke="hsl(var(--card))"
            strokeWidth={3}
            strokeLinejoin="round"
            paintOrder="stroke"
          >
            <title>{tooltip(edge, fromLabel, toLabel)}</title>
            <tspan x={lx}>{edge.tools.length === 1 ? edge.tools[0] : `${edge.tools.length} tools`}</tspan>
            <tspan x={lx} dy="12">
              {edge.calls} call{edge.calls === 1 ? "" : "s"} · {totalsText(edge)}
            </tspan>
          </text>
        ))}

        {/* 3. nodes on top */}
        {layout.nodes.map((node) => (
          <foreignObject key={node.id} x={node.x - NODE_W / 2} y={node.y - NODE_H / 2} width={NODE_W} height={NODE_H}>
            <div
              className={`flex h-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs shadow-sm ${
                node.kind === "agent" ? "border-primary/30 bg-primary/10" : "bg-card"
              }`}
              title={node.label}
            >
              {node.kind === "agent" ? (
                <Bot className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
              ) : (
                <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <span className="truncate font-medium">{node.label}</span>
            </div>
          </foreignObject>
        ))}
      </svg>
    </div>
  );
}

function totalsText(edge: AggregatedEdge): string {
  return edge.totals.map((t) => formatTokens(t.raw, 9, t.symbol)).join(" + ");
}

function tooltip(edge: AggregatedEdge, from: string, to: string): string {
  return `${from} → ${to}\n${edge.calls} settled call${edge.calls === 1 ? "" : "s"}: ${edge.tools.join(", ")}\n${totalsText(edge)}`;
}

function computeLayout(graph: GraphData): {
  nodes: Positioned[];
  byId: Map<string, Positioned>;
  maxDepth: number;
  maxRow: number;
} {
  const depth = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const n of graph.nodes) incoming.set(n.id, 0);
  for (const e of graph.edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);

  // Roots (no incoming edge) start at depth 0; relax depths along edges.
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
  const positioned: Positioned[] = graph.nodes.map((n) => {
    const d = depth.get(n.id) ?? 0;
    const row = rows.get(d) ?? 0;
    rows.set(d, row + 1);
    return { ...n, depth: d, x: 90 + d * LAYER_GAP, y: 60 + row * ROW_GAP };
  });

  const byId = new Map(positioned.map((p) => [p.id, p]));
  const maxDepth = Math.max(0, ...positioned.map((p) => p.depth));
  const maxRow = Math.max(1, ...[...rows.values()]);
  return { nodes: positioned, byId, maxDepth, maxRow };
}
