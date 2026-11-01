"use client";

import * as React from "react";
import Link from "next/link";
import { FlaskConical, Radio } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SiteHeader } from "@/components/site-header";
import { StatTiles } from "@/components/stat-tiles";
import { PaymentGraph } from "@/components/payment-graph";
import { ReceiptsTable } from "@/components/receipts-table";
import { OnchainProblem } from "@/components/onchain-status";
import { useOnchainState } from "@/lib/use-onchain-state";
import { cascadeReceiptIds } from "@/lib/graph";
import { CONTRACTS, CSPR_LIVE_CONTRACT, ONCHAIN_NETWORK_LABEL } from "@/lib/economy";

export default function DashboardPage() {
  const { state, latestReceiptId, status, error, updatedAt, truncated, refresh } = useOnchainState();

  // Highlight the freshest cascade: every receipt in the latest receipt's tree, at any depth.
  const highlightEdgeIds = React.useMemo(
    () => cascadeReceiptIds(state.receipts, latestReceiptId),
    [latestReceiptId, state.receipts],
  );

  const hasData = status === "live" || status === "degraded";
  const loading = status === "loading";

  return (
    <div className="min-h-screen">
      <SiteHeader status={status} />

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Seller dashboard</h1>
            <Badge variant="warning" className="gap-1">
              <FlaskConical className="h-3 w-3" aria-hidden /> {ONCHAIN_NETWORK_LABEL} data
            </Badge>
            <Badge variant="outline" className="gap-1" title="Data source: the on-chain ReceiptRegistry (the header badge shows whether the last read succeeded)">
              <Radio className="h-3 w-3" aria-hidden /> on-chain
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Every tool call your MCP servers sell, paid per request over x402 and settled on Casper, including cascades
            where a paid tool buys from other paid tools. Reconstructed from the payments anchored in the{" "}
            <a
              href={`${CSPR_LIVE_CONTRACT}${CONTRACTS.receiptRegistry}`}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              testnet ReceiptRegistry
            </a>
            . These are {ONCHAIN_NETWORK_LABEL} receipts; the mainnet contracts and transactions are listed on the{" "}
            <Link href="/#contracts" className="text-primary underline-offset-4 hover:underline">
              home page
            </Link>
            .
          </p>
        </div>

        <OnchainProblem status={status} error={error} updatedAt={updatedAt} onRetry={refresh} />

        {(hasData || loading) && (
          <>
            <StatTiles state={state} loading={loading} />

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">Cascading payment graph</CardTitle>
                <CardDescription>
                  Agents (left) pay servers; servers pay downstream servers. One line per payer → payee pair, labelled
                  with its calls and total; the newest cascade is highlighted. Hover a line for details.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <PaymentGraph
                  graph={state.graph}
                  highlightEdgeIds={highlightEdgeIds}
                  emptyText={loading ? "Reading the ReceiptRegistry…" : "No settled payments in the registry yet."}
                />
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
              <Card className="min-w-0">
                <CardHeader>
                  <CardTitle className="text-base">Recent payments</CardTitle>
                  <CardDescription>
                    Settled receipts, newest first. Settlement and anchor links open on testnet.cspr.live.
                    {truncated && " Only the newest part of the registry was read."}
                  </CardDescription>
                </CardHeader>
                <CardContent className="px-0">
                  <ReceiptsTable
                    receipts={state.receipts}
                    latestReceiptId={latestReceiptId}
                    emptyText={loading ? "Reading the ReceiptRegistry…" : "No payments yet."}
                  />
                </CardContent>
              </Card>

              <Card className="h-fit min-w-0">
                <CardHeader>
                  <CardTitle className="text-base">Servers &amp; pricing</CardTitle>
                  <CardDescription>
                    MCP servers that sold at least one call, with the highest per-call price seen on-chain.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {state.servers.length === 0 && (
                    <div className="text-sm text-muted-foreground">{loading ? "Reading…" : "No servers have sold a call yet."}</div>
                  )}
                  {state.servers.map((server) => (
                    <div key={server.name} className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-sm font-medium">{server.name}</span>
                        <Badge variant="secondary" title="Seen in on-chain receipts; this page cannot tell whether it is up right now">
                          seen on-chain
                        </Badge>
                      </div>
                      <div className="space-y-1">
                        {server.tools.map((tool) => (
                          <div key={tool.name} className="flex items-center justify-between gap-2 text-xs">
                            <span className="min-w-0 truncate font-mono text-muted-foreground">{tool.name}</span>
                            <span className="shrink-0 tabular-nums">{tool.priceUsd ?? "free"}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
