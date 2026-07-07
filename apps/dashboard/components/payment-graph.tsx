"use client";

import * as React from "react";
import type { PaymentGraph as GraphData } from "@cascet/core";
import { Bot, Server } from "lucide-react";
import { formatTokens } from "@/lib/utils";

interface Positioned {
  id: string;
  kind: "agent" | "server";
  label: string;
  depth: number;
  x: number;
  y: number;
}

/**
 * Layered left-to-right visualization of the cascade. Agents (roots) sit at
 * depth 0; each payment edge pushes its target one layer right, so a multi-hop
 * chain reads as a supply chain of machine-to-machine payments.
 */
export function PaymentGraph({ graph, highlightEdgeIds }: { graph: GraphData; highlightEdgeIds?: Set<string> }) {
  const layout = React.useMemo(() => computeLayout(graph), [graph]);

  if (graph.nodes.length === 0) {
    return (
      <div className="flex h-[320px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
        Waiting for the first paid tool call…
      </div>
    );
  }

  const width = Math.max(640, (layout.maxDepth + 1) * 220);
  const height = Math.max(320, layout.maxRow * 96 + 80);

  return (
    <div className="grid-bg overflow-x-auto rounded-lg border">
      <svg width={width} height={height} className="min-w-full">
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="hsl(var(--muted-foreground))" />
          </marker>
          <marker id="arrow-hot" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="hsl(var(--primary))" />
          </marker>
        </defs>

        {graph.edges.map(edge => {
          const from = layout.byId.get(edge.from);
          const to = layout.byId.get(edge.to);
          if (!from || !to) return null;
          const hot = highlightEdgeIds?.has(edge.receiptId);
          const midX = (from.x + to.x) / 2;
          const path = `M ${from.x + 70} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x - 70} ${to.y}`;
          return (
            <g key={edge.receiptId}>
              <path
                d={path}
                fill="none"
                stroke={hot ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))"}
                strokeWidth={hot ? 2.5 : 1.5}
                strokeOpacity={hot ? 1 : 0.55}
                markerEnd={hot ? "url(#arrow-hot)" : "url(#arrow)"}
              />
              <text
                x={midX}
                y={(from.y + to.y) / 2 - 6}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {edge.tool} · {formatTokens(edge.amountRaw, 9, edge.assetSymbol)}
              </text>
            </g>
          );
        })}

        {layout.nodes.map(node => (
          <foreignObject key={node.id} x={node.x - 70} y={node.y - 22} width={140} height={44}>
            <div
              className={`flex h-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs shadow-sm ${
                node.kind === "agent" ? "bg-primary/10 border-primary/30" : "bg-card"
              }`}
            >
              {node.kind === "agent" ? (
                <Bot className="h-3.5 w-3.5 shrink-0 text-primary" />
              ) : (
                <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate font-medium">{node.label}</span>
            </div>
          </foreignObject>
        ))}
      </svg>
    </div>
  );
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
  const positioned: Positioned[] = graph.nodes.map(n => {
    const d = depth.get(n.id) ?? 0;
    const row = rows.get(d) ?? 0;
    rows.set(d, row + 1);
    return { ...n, depth: d, x: 90 + d * 220, y: 50 + row * 96 };
  });

  const byId = new Map(positioned.map(p => [p.id, p]));
  const maxDepth = Math.max(0, ...positioned.map(p => p.depth));
  const maxRow = Math.max(1, ...[...rows.values()]);
  return { nodes: positioned, byId, maxDepth, maxRow };
}
