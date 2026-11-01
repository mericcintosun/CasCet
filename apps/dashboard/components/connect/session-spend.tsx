"use client";

import * as React from "react";
import { Wallet } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { OnchainProblem, OnchainStatusBadge } from "@/components/onchain-status";
import { accountHashOf, parsePayeeInput } from "@/lib/casper/keys";
import { rawToTokens, type ConnectNetwork } from "@/lib/connect-config";
import { CONTRACTS, ONCHAIN_NETWORK_LABEL } from "@/lib/economy";
import { spendByAsset } from "@/lib/spend";
import { useAccountHashes } from "@/lib/use-account-hashes";
import { useOnchainReceipts } from "@/lib/use-onchain-receipts";
import { cn, shortHex } from "@/lib/utils";

/** Decimals of the tokens the on-chain feed can contain (receipts don't carry decimals). */
const KNOWN_DECIMALS: Record<string, number> = { [CONTRACTS.x402Token]: 9 };

const WINDOWS = [
  { key: "1h", label: "1 h", ms: 3_600_000 },
  { key: "24h", label: "24 h", ms: 86_400_000 },
  { key: "7d", label: "7 d", ms: 7 * 86_400_000 },
  { key: "all", label: "All", ms: null },
] as const;
type WindowKey = (typeof WINDOWS)[number]["key"];

/**
 * "Session spend": what a payer has actually spent, per asset, from the same
 * on-chain receipts /explorer reads (the testnet ReceiptRegistry), compared
 * with the session cap entered above.
 */
export function SessionSpend({
  network,
  decimals,
  sessionCapRaw,
  allowedAssets,
}: {
  network: ConnectNetwork;
  decimals: number;
  sessionCapRaw: string | null;
  allowedAssets: string[];
}) {
  const feed = useOnchainReceipts(60_000);
  const [payerInput, setPayerInput] = React.useState("");
  const [windowKey, setWindowKey] = React.useState<WindowKey>("24h");

  // The payer: an account hash, or a public key converted to one.
  const payer = React.useMemo(() => parsePayeeInput(payerInput), [payerInput]);
  const receiptKeys = React.useMemo(
    () => [...new Set(feed.receipts.map((r) => r.payer.toLowerCase()).filter((p) => parsePayeeInput(p).kind === "public-key"))],
    [feed.receipts],
  );
  const lookups = useAccountHashes(payer.kind === "public-key" ? [...receiptKeys, payer.publicKey] : receiptKeys);

  let target: string | null = null;
  let payerError: string | null = null;
  if (payer.kind === "account") target = payer.hash;
  else if (payer.kind === "public-key") {
    const c = lookups.get(payer.publicKey);
    if (c && "hash" in c) target = c.hash;
    else if (c && "error" in c) payerError = c.error;
  } else if (payer.kind === "package") payerError = "a contract package cannot be a payer; enter the agent's account hash or public key";
  else if (payer.kind === "invalid") payerError = payer.reason;

  const windowMs = WINDOWS.find((w) => w.key === windowKey)?.ms ?? null;
  const rows = React.useMemo(() => {
    if (!target) return [];
    const since = windowMs === null ? null : Date.now() - windowMs;
    const inWindow = since === null ? feed.receipts : feed.receipts.filter((r) => Date.parse(r.createdAt) >= since);
    return spendByAsset(inWindow, (p) => {
      const direct = accountHashOf(p);
      if (direct) return direct === target;
      const c = lookups.get(p.toLowerCase());
      return Boolean(c && "hash" in c && c.hash === target);
    });
  }, [feed.receipts, target, windowMs, lookups]);

  const cap = sessionCapRaw ? BigInt(sessionCapRaw) : null;
  const hasData = feed.status === "live" || feed.status === "degraded";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-4 w-4" aria-hidden /> Session spend
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="warning">{ONCHAIN_NETWORK_LABEL}</Badge>
            <OnchainStatusBadge status={feed.status} />
          </div>
        </div>
        <CardDescription>
          Settled payments by one agent, per token, from the on-chain receipts /explorer reads (the testnet ReceiptRegistry).
          {network === "mainnet" && " Mainnet spend is not indexed on this site yet."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="payer">Agent (payer)</Label>
          <Input
            id="payer"
            value={payerInput}
            onChange={(e) => setPayerInput(e.target.value)}
            placeholder="00… account hash or 01… / 02… public key"
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-xs"
            aria-invalid={Boolean(payerError)}
          />
          {payerError ? (
            <p className="text-xs text-destructive">{payerError}</p>
          ) : payer.kind === "public-key" && target ? (
            <p className="break-all font-mono text-[11px] text-muted-foreground">account hash 00{target}</p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Time window">
          {WINDOWS.map((w) => (
            <Button
              key={w.key}
              type="button"
              size="sm"
              variant={windowKey === w.key ? "secondary" : "ghost"}
              aria-pressed={windowKey === w.key}
              onClick={() => setWindowKey(w.key)}
              className="h-7 px-2.5"
            >
              {w.label}
            </Button>
          ))}
        </div>

        <OnchainProblem status={feed.status} error={feed.error} updatedAt={feed.updatedAt} onRetry={feed.refresh} />

        {!target ? (
          <p className="text-sm text-muted-foreground">Enter the agent&apos;s account hash or public key to see what it spent.</p>
        ) : !hasData ? (
          feed.status === "loading" ? <p className="text-sm text-muted-foreground">Reading the ReceiptRegistry…</p> : null
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No settled payments from this agent in this window.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Token</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">Spent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const d = KNOWN_DECIMALS[r.asset];
                const amount = d === undefined ? `${r.raw.toString()} raw units` : `${rawToTokens(r.raw, d)} ${r.symbol}`;
                const allowlisted = allowedAssets.includes(r.asset);
                const comparable = cap !== null && (allowlisted || allowedAssets.length === 0) && (d === undefined || d === decimals);
                const pct = comparable && cap ? Math.min(100, Number((r.raw * 10_000n) / cap) / 100) : null;
                return (
                  <TableRow key={r.asset}>
                    <TableCell>
                      <div className="font-medium">{r.symbol}</div>
                      <div className="font-mono text-[11px] text-muted-foreground" title={r.asset}>
                        {shortHex(r.asset, 8, 6)}
                        {allowlisted && <span className="ml-1.5 text-success">allowlisted</span>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.calls}</TableCell>
                    <TableCell className="text-right">
                      <div className="whitespace-nowrap tabular-nums">{amount}</div>
                      {pct !== null && (
                        <div className="mt-1.5 space-y-1">
                          <div
                            className="ml-auto h-1.5 w-24 overflow-hidden rounded-full bg-secondary"
                            role="meter"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round(pct)}
                            aria-label="Share of the session cap"
                          >
                            <div className={cn("h-full rounded-full", pct >= 100 ? "bg-destructive" : "bg-primary")} style={{ width: `${pct}%` }} />
                          </div>
                          <div className="text-[11px] text-muted-foreground">{pct.toFixed(pct < 10 ? 1 : 0)}% of the session cap</div>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {feed.truncated && hasData && (
          <p className="text-xs text-muted-foreground">Only the newest part of the registry was read; older payments are not counted.</p>
        )}
      </CardContent>
    </Card>
  );
}
