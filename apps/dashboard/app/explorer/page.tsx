"use client";

import * as React from "react";
import Link from "next/link";
import { Anchor, Coins, GitBranch, Users, ExternalLink, Boxes, FlaskConical, Radio } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { SiteHeader } from "@/components/site-header";
import { OnchainProblem } from "@/components/onchain-status";
import { computeEconomy, CONTRACTS, CSPR_LIVE_CONTRACT, ONCHAIN_NETWORK_LABEL } from "@/lib/economy";
import { CSPR_LIVE_TX } from "@/lib/casper/constants";
import { useOnchainReceipts } from "@/lib/use-onchain-receipts";
import { formatTokens, shortHex } from "@/lib/utils";

const CONTRACT_ROWS = [
  { key: "receiptRegistry", label: "ReceiptRegistry", hash: CONTRACTS.receiptRegistry, note: "anchors every paid call + cascade link" },
  { key: "x402Token", label: "Cep18X402 token", hash: CONTRACTS.x402Token, note: "CasCet's x402 payment token (on-chain symbol WCSPR)" },
  { key: "revenueSplit", label: "RevenueSplit", hash: CONTRACTS.revenueSplit, note: "on-chain weighted revenue split" },
  { key: "demoToken", label: "DemoToken (CEP-18)", hash: CONTRACTS.demoToken, note: "plain CEP-18 demo token (no x402 support)" },
];

const SHOWN = 15;

export default function ExplorerPage() {
  const { receipts, status, error, updatedAt, truncated, refresh } = useOnchainReceipts();
  const economy = React.useMemo(() => computeEconomy(receipts), [receipts]);
  const hasData = status === "live" || status === "degraded";
  const loading = status === "loading";
  const emptyText = (none: string) => (loading ? "Reading the ReceiptRegistry…" : none);

  const tiles = [
    { label: "Total revenue", icon: Coins, value: formatTokens(economy.totalRevenueRaw, 9, economy.assetSymbol) },
    { label: "Anchored on-chain", icon: Anchor, value: String(economy.anchoredCount) },
    { label: "Cascaded payments", icon: GitBranch, value: `${economy.cascaded} (depth ${economy.maxDepth})` },
    { label: "Unique paying agents", icon: Users, value: String(economy.uniquePayers) },
  ];

  return (
    <div className="min-h-screen">
      <SiteHeader status={status} />
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">x402 economy explorer</h1>
            <Badge variant="warning" className="gap-1">
              <FlaskConical className="h-3 w-3" aria-hidden /> {ONCHAIN_NETWORK_LABEL} data
            </Badge>
            <Badge variant="success" className="gap-1">
              <Radio className="h-3 w-3" aria-hidden /> on-chain
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            The machine-to-machine economy running through CasCet on {ONCHAIN_NETWORK_LABEL}, reconstructed from the
            payments anchored in the testnet ReceiptRegistry — not an off-chain cache. Mainnet contracts and the mainnet
            settlement transactions are listed on the{" "}
            <Link href="/#contracts" className="text-primary underline-offset-4 hover:underline">
              home page
            </Link>
            .
          </p>
        </div>

        <OnchainProblem status={status} error={error} updatedAt={updatedAt} onRetry={refresh} />

        {(hasData || loading) && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4" aria-busy={loading}>
              {tiles.map(({ label, icon: Icon, value }) => (
                <Card key={label} className="min-w-0">
                  <CardContent className="flex items-center gap-3 p-4 sm:gap-4 sm:p-5">
                    <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary sm:flex">
                      <Icon className="h-5 w-5" aria-hidden />
                    </div>
                    <div className="min-w-0">
                      <div className="break-words text-xl font-semibold tabular-nums leading-tight sm:text-2xl">
                        {loading ? "…" : value}
                      </div>
                      <div className="text-xs text-muted-foreground">{label}</div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className="h-4 w-4" aria-hidden /> On-chain contracts ({ONCHAIN_NETWORK_LABEL})
            </CardTitle>
            <CardDescription>
              The testnet state behind this explorer. The mainnet deployment is a separate set of packages.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {CONTRACT_ROWS.map((c) => (
              <div key={c.key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2">
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
                  {c.hash.slice(0, 8)}…{c.hash.slice(-6)} <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              </div>
            ))}
          </CardContent>
        </Card>

        {(hasData || loading) && (
          <>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <Card className="min-w-0">
                <CardHeader>
                  <CardTitle className="text-base">Server leaderboard</CardTitle>
                  <CardDescription>Ranked by revenue earned from agents.</CardDescription>
                </CardHeader>
                <CardContent className="px-0">
                  {economy.servers.length === 0 ? (
                    <div className="p-6 text-center text-sm text-muted-foreground">{emptyText("No anchored receipts yet.")}</div>
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
                        {economy.servers.map((s) => (
                          <TableRow key={s.server}>
                            <TableCell className="font-medium">{s.server}</TableCell>
                            <TableCell className="whitespace-nowrap tabular-nums">
                              {formatTokens(s.revenueRaw, 9, economy.assetSymbol)}
                            </TableCell>
                            <TableCell className="tabular-nums">{s.calls}</TableCell>
                            <TableCell className="tabular-nums">{s.uniquePayers}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>

              <Card className="min-w-0">
                <CardHeader>
                  <CardTitle className="text-base">Top tools</CardTitle>
                  <CardDescription>Most-bought paid tools across all servers.</CardDescription>
                </CardHeader>
                <CardContent className="px-0">
                  {economy.tools.length === 0 ? (
                    <div className="p-6 text-center text-sm text-muted-foreground">{emptyText("No tool sales yet.")}</div>
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
                        {economy.tools.map((t) => (
                          <TableRow key={t.key}>
                            <TableCell className="font-medium">{t.tool}</TableCell>
                            <TableCell className="text-muted-foreground">{t.server}</TableCell>
                            <TableCell className="whitespace-nowrap tabular-nums">
                              {formatTokens(t.revenueRaw, 9, economy.assetSymbol)}
                            </TableCell>
                            <TableCell className="tabular-nums">{t.calls}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card className="min-w-0">
              <CardHeader>
                <CardTitle className="text-base">Anchored receipts</CardTitle>
                <CardDescription>
                  Each row is a settled tool call recorded on-chain; a child row is a cascaded call made on behalf of a
                  parent payment.
                  {receipts.length > SHOWN && ` Showing the newest ${SHOWN} of ${receipts.length}.`}
                  {truncated && " Only the newest part of the registry was read."}
                </CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                {receipts.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">{emptyText("No receipts anchored yet.")}</div>
                ) : (
                  <Table className="min-w-[600px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tool</TableHead>
                        <TableHead>Server</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead>Payer</TableHead>
                        <TableHead>Cascade</TableHead>
                        <TableHead>Anchor tx</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {receipts.slice(0, SHOWN).map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="font-medium">{r.tool}</TableCell>
                          <TableCell className="text-muted-foreground">{r.server}</TableCell>
                          <TableCell className="whitespace-nowrap tabular-nums">{formatTokens(r.amountRaw, 9, r.assetSymbol)}</TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground" title={r.payer}>
                            {shortHex(r.payer, 8, 4)}
                          </TableCell>
                          <TableCell>
                            {r.parentId ? <Badge variant="secondary">child</Badge> : <Badge variant="outline">root</Badge>}
                          </TableCell>
                          <TableCell>
                            {r.anchoredTxHash ? (
                              <a
                                href={`${CSPR_LIVE_TX}${r.anchoredTxHash}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
                              >
                                {r.anchoredTxHash.slice(0, 8)}… <ExternalLink className="h-3 w-3" aria-hidden />
                              </a>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </>
        )}

        <p className="text-center text-xs text-muted-foreground">
          Reconstructed from the{" "}
          <a
            href={`${CSPR_LIVE_CONTRACT}${CONTRACTS.receiptRegistry}`}
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            testnet ReceiptRegistry
          </a>
          &apos;s <code className="text-xs">record</code> transactions — the payment graph is verifiable purely from chain data.
        </p>
      </main>
    </div>
  );
}
