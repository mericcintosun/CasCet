"use client";

import * as React from "react";
import type { PaymentGraph as GraphData } from "@cascet/core";
import { Bot, Server } from "lucide-react";
import { aggregateEdges, edgeLabelLines, GRAPH_LAYOUT, layoutEdges, layoutNodes, type AggregatedEdge } from "@/lib/graph";
import { formatTokens } from "@/lib/utils";

const { NODE_W, NODE_H, LAYER_GAP, ROW_GAP, TOP } = GRAPH_LAYOUT;

const formatAmount = (raw: bigint, symbol: string): string => formatTokens(raw, 9, symbol);
const labelLines = (edge: AggregatedEdge): [string, string] => edgeLabelLines(edge, formatAmount);

function tooltip(edge: AggregatedEdge, from: string, to: string): string {
  const totals = edge.totals.map((t) => formatAmount(t.raw, t.symbol)).join(" + ");
  return `${from} → ${to}\n${edge.calls} settled call${edge.calls === 1 ? "" : "s"}: ${edge.tools.join(", ")}\n${totals}`;
}

/**
 * Layered left-to-right visualization of the cascade. Agents (roots) sit at
 * depth 0; each payment edge pushes its target one layer right, so a multi-hop
 * chain reads as a supply chain of machine-to-machine payments.
 *
 * Receipts between the same two nodes are aggregated into ONE edge with one
 * label ("3 tools" / "7 calls · 3.5 WCSPR"); per-receipt detail is in the edge's
 * tooltip. An edge that skips a layer runs on a lane above the nodes it passes,
 * and labels are placed so they overlap neither nodes nor each other. Paint
 * order: lines (the highlighted cascade last), then labels with a halo, then
 * nodes (M30).
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
  const layout = React.useMemo(() => layoutNodes(graph), [graph]);
  const geometry = React.useMemo(
    () => layoutEdges(aggregateEdges(graph.edges, highlightEdgeIds), layout.byId, labelLines),
    [graph.edges, highlightEdgeIds, layout.byId],
  );

  if (graph.nodes.length === 0) {
    return (
      <div className="flex h-[320px] items-center justify-center rounded-lg border border-dashed px-4 text-center text-sm text-muted-foreground">
        {emptyText}
      </div>
    );
  }

  // Lanes and labels may rise above the first row; the viewBox grows upward to keep them in view.
  const contentTop = Math.min(0, ...geometry.map((g) => Math.min(g.top, g.box.y0) - 8));
  const contentBottom = Math.max(TOP + layout.maxRow * ROW_GAP, ...geometry.map((g) => g.box.y1 + 24));
  const width = Math.max(640, (layout.maxDepth + 1) * LAYER_GAP);
  const height = Math.max(320, contentBottom - contentTop);
  const labelOf = (id: string) => layout.byId.get(id)?.label ?? id;

  return (
    <div className="grid-bg overflow-x-auto rounded-lg border">
      <svg
        width={width}
        height={height}
        viewBox={`0 ${contentTop} ${width} ${height}`}
        className="min-w-full"
        role="img"
        aria-label={`Payment graph: ${graph.nodes.length} participants, ${geometry.length} payment links, ${graph.edges.length} settled calls`}
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
        {geometry.map(({ edge, d }) => (
          <path
            key={edge.key}
            d={d}
            fill="none"
            stroke={edge.hot ? "hsl(var(--primary-text))" : "hsl(var(--muted-foreground))"}
            strokeWidth={edge.hot ? 2.5 : 1.5}
            strokeOpacity={edge.hot ? 1 : 0.55}
            markerEnd={edge.hot ? `url(#arrow-hot-${uid})` : `url(#arrow-${uid})`}
          >
            <title>{tooltip(edge, labelOf(edge.from), labelOf(edge.to))}</title>
          </path>
        ))}

        {/* 2. one label per edge, above every line, with a halo for legibility */}
        {geometry.map(({ edge, lx, ly, labelDy }) => {
          const [l1, l2] = labelLines(edge);
          return (
            <text
              key={`label-${edge.key}`}
              x={lx}
              y={ly + labelDy - 18}
              textAnchor="middle"
              className={edge.hot ? "text-[10px] font-semibold" : "text-[10px]"}
              fill={edge.hot ? "hsl(var(--primary-text))" : "hsl(var(--muted-foreground))"}
              stroke="hsl(var(--card))"
              strokeWidth={3}
              strokeLinejoin="round"
              paintOrder="stroke"
            >
              <title>{tooltip(edge, labelOf(edge.from), labelOf(edge.to))}</title>
              <tspan x={lx}>{l1}</tspan>
              <tspan x={lx} dy="12">
                {l2}
              </tspan>
            </text>
          );
        })}

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
