"use client";

import * as React from "react";
import { Coins, Receipt, GitBranch, Server } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatTokens, toBigIntSafe } from "@/lib/utils";
import type { DashboardState } from "@/lib/use-live-state";

const TILES = [
  { key: "revenue", label: "Total revenue", icon: Coins },
  { key: "calls", label: "Paid tool calls", icon: Receipt },
  { key: "cascades", label: "Cascaded payments", icon: GitBranch },
  { key: "servers", label: "Servers with sales", icon: Server },
] as const;

export function StatTiles({ state, loading = false }: { state: DashboardState; loading?: boolean }) {
  const settled = state.receipts.filter((r) => r.status === "settled");
  const revenueRaw = settled.reduce((sum, r) => sum + toBigIntSafe(r.amountRaw), 0n);
  const cascaded = settled.filter((r) => r.parentId).length;
  const symbol = settled[0]?.assetSymbol ?? "WCSPR";

  const values: Record<(typeof TILES)[number]["key"], string> = {
    revenue: formatTokens(revenueRaw, 9, symbol),
    calls: String(settled.length),
    cascades: String(cascaded),
    servers: String(state.servers.length),
  };

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4" aria-busy={loading}>
      {TILES.map(({ key, label, icon: Icon }) => (
        <Card key={key} className="min-w-0 animate-fade-in">
          <CardContent className="flex items-center gap-3 p-4 sm:gap-4 sm:p-5">
            <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary sm:flex">
              <Icon className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0">
              {/* wraps instead of truncating, so "22 WCSPR" never becomes "22 …" on a phone */}
              <div className="break-words text-xl font-semibold tabular-nums leading-tight sm:text-2xl">
                {loading ? "…" : values[key]}
              </div>
              <div className="text-xs text-muted-foreground">{label}</div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
