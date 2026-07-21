"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/lib/wallet-context";
import { shortHex } from "@/lib/utils";

interface PayeeRow {
  label: string;
  accountHash: string;
  publicKeyHex: string;
  share: number;
  percent: number;
  csprLive: string;
}
interface RevenueData {
  token: { symbol: string; decimals: number; package: string };
  splitter: { package: string; totalShares: number; csprLive: string };
  payees: PayeeRow[];
}

type RowState =
  | { status: "idle" }
  | { status: "pending"; step: string }
  | { status: "done"; txUrl: string }
  | { status: "error"; message: string };

export function RevenueSplitPanel() {
  const wallet = useWallet();
  const [data, setData] = useState<RevenueData | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});

  useEffect(() => {
    fetch("/api/revenue")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null));
  }, []);

  async function withdraw(payee: PayeeRow) {
    if (!wallet.connected || !wallet.publicKeyHex) {
      await wallet.connect();
      return;
    }
    const pub = wallet.publicKeyHex;
    const set = (s: RowState) => setRows((r) => ({ ...r, [payee.accountHash]: s }));
    try {
      set({ status: "pending", step: "Preparing…" });
      const prep = await fetch("/api/revenue/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payee: payee.accountHash, publicKeyHex: pub }),
      }).then((r) => r.json());
      if (prep.error) throw new Error(prep.error);

      set({ status: "pending", step: "Sign in wallet…" });
      const signatureHex = await wallet.signTx(prep.txJson, pub);

      set({ status: "pending", step: "Submitting…" });
      const out = await fetch("/api/revenue/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txJson: prep.txJson, signatureHex, publicKeyHex: pub }),
      }).then((r) => r.json());
      if (out.error) throw new Error(out.error);

      set({ status: "done", txUrl: out.txUrl });
    } catch (e) {
      set({ status: "error", message: (e as Error).message });
    }
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading revenue split…
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>RevenueSplit</CardTitle>
            <CardDescription>
              On-chain {data.token.symbol} split, pull-based. Each payee withdraws their weighted share —
              settled by a real <code className="text-xs">release</code> tx on Casper.
            </CardDescription>
          </div>
          <a
            href={data.splitter.csprLive}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            splitter contract <ArrowUpRight className="h-3 w-3" />
          </a>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {wallet.error && (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <TriangleAlert className="h-3.5 w-3.5" /> {wallet.error}
          </p>
        )}
        {data.payees.map((p) => {
          const isYou = wallet.publicKeyHex?.toLowerCase() === p.publicKeyHex.toLowerCase();
          const state = rows[p.accountHash] ?? { status: "idle" as const };
          return (
            <div
              key={p.accountHash}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background/40 p-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{p.label}</span>
                  {isYou && <Badge variant="success">you</Badge>}
                  <Badge variant="secondary" className="tabular-nums">
                    {p.percent}%
                  </Badge>
                </div>
                <a
                  href={p.csprLive}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
                >
                  {shortHex(p.publicKeyHex, 10, 6)} <ArrowUpRight className="h-3 w-3" />
                </a>
              </div>

              <div className="flex items-center gap-2">
                {state.status === "done" ? (
                  <a href={state.txUrl} target="_blank" rel="noreferrer">
                    <Badge variant="success" className="gap-1">
                      <CheckCircle2 className="h-3.5 w-3.5" /> released — view tx
                    </Badge>
                  </a>
                ) : state.status === "error" ? (
                  <div className="flex items-center gap-2">
                    <span className="max-w-[16rem] truncate text-xs text-destructive" title={state.message}>
                      {state.message}
                    </span>
                    <Button size="sm" variant="outline" onClick={() => withdraw(p)}>
                      Retry
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => withdraw(p)}
                    disabled={state.status === "pending"}
                  >
                    {state.status === "pending" ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {state.step}
                      </>
                    ) : wallet.connected ? (
                      "Withdraw"
                    ) : (
                      "Connect to withdraw"
                    )}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        <p className="pt-1 text-xs text-muted-foreground">
          <code className="text-xs">release</code> is permissionless — the connected wallet only pays gas
          (~5 CSPR); funds always go to the payee. Exact amounts settle on-chain and are visible on the tx.
        </p>
      </CardContent>
    </Card>
  );
}
