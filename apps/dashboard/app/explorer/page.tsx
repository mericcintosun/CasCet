"use client";

import * as React from "react";
import { Anchor, Coins, GitBranch, Users, ExternalLink, Boxes } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { SiteHeader } from "@/components/site-header";
import { useLiveState } from "@/lib/use-live-state";
import { computeEconomy, CONTRACTS, CSPR_LIVE_CONTRACT } from "@/lib/economy";
import { formatTokens } from "@/lib/utils";

const CONTRACT_ROWS = [
  { key: "receiptRegistry", label: "ReceiptRegistry", hash: CONTRACTS.receiptRegistry, note: "anchors every paid call + cascade link" },
  { key: "revenueSplit", label: "RevenueSplit", hash: CONTRACTS.revenueSplit, note: "on-chain weighted revenue split" },
  { key: "demoToken", label: "DemoToken (CEP-18)", hash: CONTRACTS.demoToken, note: "WCSPR demo payment token" },
];

export default function ExplorerPage() {
  const { state, connected } = useLiveState();
  const economy = React.useMemo(() => computeEconomy(state.receipts), [state.receipts]);

  const tiles = [
    { label: "Total revenue", icon: Coins, value: formatTokens(economy.totalRevenueRaw, 9, economy.assetSymbol) },
    { label: "Anchored on-chain", icon: Anchor, value: String(economy.anchoredCount) },
    { label: "Cascaded payments", icon: GitBranch, value: `${economy.cascaded} (depth ${economy.maxDepth})` },
    { label: "Unique paying agents", icon: Users, value: String(economy.uniquePayers) },
  ];

  return (
    <div className="min-h-screen">
      <SiteHeader connected={connected} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">x402 economy explorer</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The machine-to-machine economy running through CasCet on Casper, every payment settled over
            x402 and anchored on-chain in the ReceiptRegistry.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {tiles.map(({ label, icon: Icon, value }) => (
            <Card key={label}>
              <CardContent className="flex items-center gap-4 p-5">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-2xl font-semibold tabular-nums">{value}</div>
                  <div className="text-xs text-muted-foreground">{label}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className="h-4 w-4" /> On-chain contracts
            </CardTitle>
            <CardDescription>Live on Casper Testnet. The canonical state behind this explorer.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {CONTRACT_ROWS.map(c => (
              <div key={c.key} className="flex items-center justify-between rounded-lg border px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{c.label}</div>
                  <div className="text-xs text-muted-foreground">{c.note}</div>
                </div>
                <a
                  href={`${CSPR_LIVE_CONTRACT}${c.hash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
                >
                  {c.hash.slice(0, 8)}…{c.hash.slice(-6)} <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Server leaderboard</CardTitle>
              <CardDescription>Ranked by revenue earned from agents.</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {economy.servers.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">No revenue yet.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Server</TableHead>
                      <TableHead>Revenue</TableHead>
                      <TableHead>Calls</TableHead>
                      <TableHead>Payers</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {economy.servers.map(s => (
                      <TableRow key={s.server}>
                        <TableCell className="font-medium">{s.server}</TableCell>
                        <TableCell className="tabular-nums">{formatTokens(s.revenueRaw, 9, economy.assetSymbol)}</TableCell>
                        <TableCell className="tabular-nums">{s.calls}</TableCell>
                        <TableCell className="tabular-nums">{s.uniquePayers}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Top tools</CardTitle>
              <CardDescription>Most-bought paid tools across all servers.</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {economy.tools.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">No tool sales yet.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tool</TableHead>
                      <TableHead>Server</TableHead>
                      <TableHead>Revenue</TableHead>
                      <TableHead>Calls</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {economy.tools.map(t => (
                      <TableRow key={t.key}>
                        <TableCell className="font-medium">{t.tool}</TableCell>
                        <TableCell className="text-muted-foreground">{t.server}</TableCell>
                        <TableCell className="tabular-nums">{formatTokens(t.revenueRaw, 9, economy.assetSymbol)}</TableCell>
                        <TableCell className="tabular-nums">{t.calls}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <p className="text-center text-xs text-muted-foreground">
          Canonical counts live on-chain in the{" "}
          <a
            href={`${CSPR_LIVE_CONTRACT}${CONTRACTS.receiptRegistry}`}
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            ReceiptRegistry
          </a>
          . This view aggregates receipts anchored there.
        </p>
      </main>
    </div>
  );
}
