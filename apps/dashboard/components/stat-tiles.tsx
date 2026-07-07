"use client";

import * as React from "react";
import { Coins, Receipt, GitBranch, Server } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatTokens } from "@/lib/utils";
import type { DashboardState } from "@/lib/use-live-state";

const TILES = [
  { key: "revenue", label: "Total revenue", icon: Coins },
  { key: "calls", label: "Paid tool calls", icon: Receipt },
  { key: "cascades", label: "Cascaded payments", icon: GitBranch },
  { key: "servers", label: "Online servers", icon: Server },
] as const;

export function StatTiles({ state }: { state: DashboardState }) {
  const settled = state.receipts.filter(r => r.status === "settled");
  const revenueRaw = settled.reduce((sum, r) => sum + BigInt(r.amountRaw || "0"), 0n);
  const cascaded = settled.filter(r => r.parentId).length;
  const online = state.servers.filter(s => s.online).length;
  const symbol = settled[0]?.assetSymbol ?? "WCSPR";

  const values: Record<(typeof TILES)[number]["key"], string> = {
    revenue: formatTokens(revenueRaw, 9, symbol),
    calls: String(settled.length),
    cascades: String(cascaded),
    servers: String(online),
  };

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {TILES.map(({ key, label, icon: Icon }) => (
        <Card key={key} className="animate-fade-in">
          <CardContent className="flex items-center gap-4 p-5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-2xl font-semibold tabular-nums">{values[key]}</div>
              <div className="text-xs text-muted-foreground">{label}</div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
