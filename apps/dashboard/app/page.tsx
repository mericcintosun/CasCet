"use client";

import * as React from "react";
import { Activity, Boxes } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ModeToggle } from "@/components/mode-toggle";
import { StatTiles } from "@/components/stat-tiles";
import { PaymentGraph } from "@/components/payment-graph";
import { ReceiptsTable } from "@/components/receipts-table";
import { useLiveState } from "@/lib/use-live-state";

export default function DashboardPage() {
  const { state, latestReceiptId, connected } = useLiveState();

  // Highlight the freshest cascade: edges sharing the latest receipt's root.
  const highlightEdgeIds = React.useMemo(() => {
    if (!latestReceiptId) return new Set<string>();
    const latest = state.receipts.find(r => r.id === latestReceiptId);
    const rootId = latest?.parentId ?? latest?.id;
    const ids = new Set<string>();
    for (const r of state.receipts) {
      if (r.id === rootId || r.parentId === rootId) ids.add(r.id);
    }
    return ids;
  }, [latestReceiptId, state.receipts]);

  return (
    <div className="min-h-screen">
      <header className="glass sticky top-0 z-10 border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Boxes className="h-5 w-5" />
            </div>
            <div>
              <div className="font-semibold leading-tight">CasCet</div>
              <div className="text-[11px] leading-tight text-muted-foreground">Paid MCP · Casper Testnet</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant={connected ? "success" : "secondary"} className="gap-1.5">
              <Activity className="h-3 w-3" />
              {connected ? "live" : "connecting…"}
            </Badge>
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Seller dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every tool call your MCP servers sell, paid per request over x402 and settled on Casper —
            including cascades where a paid tool buys from other paid tools.
          </p>
        </div>

        <StatTiles state={state} />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">Cascading payment graph</CardTitle>
            <CardDescription>
              Agents (left) pay servers; servers pay downstream servers. The newest chain is highlighted.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PaymentGraph graph={state.graph} highlightEdgeIds={highlightEdgeIds} />
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent payments</CardTitle>
              <CardDescription>Live receipts, newest first. Settlement links resolve on cspr.live.</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <ReceiptsTable receipts={state.receipts} latestReceiptId={latestReceiptId} />
            </CardContent>
          </Card>

          <Card className="h-fit">
            <CardHeader>
              <CardTitle className="text-base">Servers &amp; pricing</CardTitle>
              <CardDescription>MCP servers wrapped by CasCet.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {state.servers.length === 0 && (
                <div className="text-sm text-muted-foreground">No servers connected yet.</div>
              )}
              {state.servers.map(server => (
                <div key={server.name} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{server.name}</span>
                    <Badge variant={server.online ? "success" : "secondary"}>
                      {server.online ? "online" : "offline"}
                    </Badge>
                  </div>
                  <div className="space-y-1">
                    {server.tools.map(tool => (
                      <div key={tool.name} className="flex items-center justify-between text-xs">
                        <span className="font-mono text-muted-foreground">{tool.name}</span>
                        <span className="tabular-nums">{tool.priceUsd ?? "free"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
