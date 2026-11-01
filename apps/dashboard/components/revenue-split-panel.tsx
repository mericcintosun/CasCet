"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, CheckCircle2, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/lib/wallet-context";
import { CSPR_LIVE_TX } from "@/lib/casper/constants";
import { rawToTokens } from "@/lib/connect-config";
import { isTimeoutError, timeoutSignal } from "@/lib/timeout";
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
  /** `txUrl`: the transaction may have reached the node; look it up before retrying. */
  | { status: "error"; message: string; txUrl?: string };

/** Each API call gets a deadline, so a hung node or route never leaves a row on "Submitting…" (L27). */
const REQUEST_TIMEOUT_MS = 30_000;

/** POST JSON and read the JSON answer. A non-JSON body (a proxy error page) reads as {}. */
async function postJson(url: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: timeoutSignal(REQUEST_TIMEOUT_MS),
  });
  let data: Record<string, unknown> = {};
  try {
    data = ((await res.json()) ?? {}) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return { status: res.status, data };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** What each payee can release now, read from the contract's state (L124); keyed by bare account hash. */
type Releasable =
  | { status: "loading" }
  | { status: "ok"; byPayee: Map<string, bigint> }
  | { status: "error"; message: string };

const bareAccount = (h: string): string => h.toLowerCase().replace(/^account-hash-/, "");

export function RevenueSplitPanel() {
  const wallet = useWallet();
  const [data, setData] = useState<RevenueData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [releasable, setReleasable] = useState<Releasable>({ status: "loading" });

  const loadReleasable = useCallback(async () => {
    setReleasable({ status: "loading" });
    try {
      const r = await fetch("/api/revenue/releasable", { signal: timeoutSignal(20_000), cache: "no-store" });
      const body = ((await r.json().catch(() => ({}))) ?? {}) as {
        ok?: unknown;
        error?: unknown;
        payees?: Array<{ accountHash?: unknown; releasableRaw?: unknown }>;
      };
      if (!r.ok || body.ok !== true || !Array.isArray(body.payees)) throw new Error(str(body.error) ?? `HTTP ${r.status}`);
      const byPayee = new Map(body.payees.map((p) => [bareAccount(String(p.accountHash)), BigInt(String(p.releasableRaw))]));
      setReleasable({ status: "ok", byPayee });
    } catch (e) {
      setReleasable({
        status: "error",
        message: isTimeoutError(e) ? "no answer within 20 s" : e instanceof Error ? e.message : "request failed",
      });
    }
  }, []);

  useEffect(() => {
    void loadReleasable();
  }, [loadReleasable]);

  useEffect(() => {
    fetch("/api/revenue", { signal: timeoutSignal(15_000) })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setData((await r.json()) as RevenueData);
      })
      .catch((e: unknown) =>
        setLoadError(isTimeoutError(e) ? "no answer within 15 s" : e instanceof Error ? e.message : "request failed"),
      );
  }, []);

  async function withdraw(payee: PayeeRow) {
    if (!wallet.connected || !wallet.publicKeyHex) {
      await wallet.connect();
      return;
    }
    // Nothing to release: the release would revert with NothingToRelease and still cost the wallet gas.
    if (releasable.status === "ok" && releasable.byPayee.get(bareAccount(payee.accountHash)) === 0n) return;
    const pub = wallet.publicKeyHex;
    const set = (s: RowState) => setRows((r) => ({ ...r, [payee.accountHash]: s }));
    // The prepared transaction's hash, known before it is signed: lets a timed-out submit point at cspr.live.
    let preparedTxUrl: string | undefined;
    let submitting = false;
    try {
      set({ status: "pending", step: "Preparing…" });
      const prep = await postJson("/api/revenue/prepare", { payee: payee.accountHash, publicKeyHex: pub });
      const txJson = prep.data.txJson as { hash?: unknown } | undefined;
      if (!txJson) throw new Error(str(prep.data.error) ?? `could not prepare the transaction (HTTP ${prep.status})`);
      const hash = str(txJson.hash);
      preparedTxUrl = hash ? CSPR_LIVE_TX + hash : undefined;

      set({ status: "pending", step: "Sign in wallet…" });
      const signatureHex = await wallet.signTx(txJson, pub);

      set({ status: "pending", step: "Submitting…" });
      submitting = true;
      const out = await postJson("/api/revenue/submit", { txJson, signatureHex, publicKeyHex: pub });
      const txUrl = str(out.data.txUrl);
      if (out.status !== 200 || !txUrl) {
        // A 504 carries the hash: the node may have taken the transaction anyway.
        const message = str(out.data.error) ?? `the transaction was not submitted (HTTP ${out.status})`;
        set({ status: "error", message, ...(out.status === 504 ? { txUrl: txUrl ?? preparedTxUrl } : {}) });
        return;
      }
      set({ status: "done", txUrl });
    } catch (e) {
      const reason = isTimeoutError(e) ? `no answer within ${REQUEST_TIMEOUT_MS / 1000} s` : e instanceof Error ? e.message : String(e);
      // Once the submit request is out, a timeout or a dropped connection says nothing about the node: the
      // transaction may have been taken, and a retry would pay gas again.
      set(
        submitting
          ? {
              status: "error",
              message: `${reason}. The transaction may still have been submitted: open it on cspr.live before you try again.`,
              txUrl: preparedTxUrl,
            }
          : { status: "error", message: reason },
      );
    }
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          {loadError ? (
            <span className="flex items-center gap-1.5 text-destructive">
              <TriangleAlert className="h-4 w-4" /> Could not load the revenue split ({loadError}). Reload to retry.
            </span>
          ) : (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Loading revenue split…
            </>
          )}
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
        {releasable.status === "error" && (
          <p className="flex flex-wrap items-center gap-2 text-xs text-warning">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            Could not read the releasable amounts ({releasable.message}). Withdraw still works, but a release with nothing to
            pay out reverts and still costs gas.
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => void loadReleasable()}>
              Retry
            </Button>
          </p>
        )}
        {data.payees.map((p) => {
          const isYou = wallet.publicKeyHex?.toLowerCase() === p.publicKeyHex.toLowerCase();
          const state = rows[p.accountHash] ?? { status: "idle" as const };
          const amount = releasable.status === "ok" ? releasable.byPayee.get(bareAccount(p.accountHash)) : undefined;
          const nothingToRelease = amount === 0n;
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
                <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                  {releasable.status === "loading" ? (
                    "Reading the releasable amount…"
                  ) : amount === undefined ? (
                    "Releasable amount unknown"
                  ) : amount > 0n ? (
                    <>
                      Releasable now:{" "}
                      <span className="font-medium text-foreground">
                        {rawToTokens(amount, data.token.decimals)} {data.token.symbol}
                      </span>
                    </>
                  ) : (
                    "Nothing to release right now"
                  )}
                </p>
              </div>

              <div className="flex items-center gap-2">
                {state.status === "done" ? (
                  <a href={state.txUrl} target="_blank" rel="noreferrer">
                    <Badge variant="success" className="gap-1">
                      <CheckCircle2 className="h-3.5 w-3.5" /> submitted — view tx
                    </Badge>
                  </a>
                ) : state.status === "error" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="max-w-[20rem] break-words text-xs text-destructive">
                      {state.message}
                    </span>
                    {state.txUrl && (
                      <a
                        href={state.txUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                      >
                        check the tx <ArrowUpRight className="h-3 w-3" />
                      </a>
                    )}
                    <Button size="sm" variant="outline" onClick={() => withdraw(p)} disabled={nothingToRelease}>
                      Retry
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => withdraw(p)}
                    disabled={state.status === "pending" || (wallet.connected && nothingToRelease)}
                  >
                    {state.status === "pending" ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {state.step}
                      </>
                    ) : !wallet.connected ? (
                      "Connect to withdraw"
                    ) : nothingToRelease ? (
                      "Nothing to release"
                    ) : (
                      "Withdraw"
                    )}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        <div className="flex flex-wrap items-start justify-between gap-2 pt-1">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            <code className="text-xs">release</code> is permissionless — the connected wallet only pays gas
            (~5 CSPR); funds always go to the payee. The releasable amounts are read from the contract&apos;s on-chain state;
            Withdraw is off at zero, because such a release reverts and still costs gas. &ldquo;Submitted&rdquo; means the
            node accepted the transaction; open it on cspr.live to see whether it executed and the exact amount released.
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => void loadReleasable()}
            disabled={releasable.status === "loading"}
          >
            <RefreshCw className={releasable.status === "loading" ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            Refresh amounts
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
