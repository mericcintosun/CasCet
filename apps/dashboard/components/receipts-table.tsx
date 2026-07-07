"use client";

import * as React from "react";
import { ExternalLink, CornerDownRight } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatTokens, shortHex, timeAgo } from "@/lib/utils";
import type { PaymentReceipt } from "@cascet/core";

const TESTNET_DEPLOY = "https://testnet.cspr.live/deploy/";

export function ReceiptsTable({
  receipts,
  latestReceiptId,
}: {
  receipts: PaymentReceipt[];
  latestReceiptId: string | null;
}) {
  if (receipts.length === 0) {
    return <div className="p-8 text-center text-sm text-muted-foreground">No payments yet.</div>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Tool</TableHead>
          <TableHead>Server</TableHead>
          <TableHead>Amount</TableHead>
          <TableHead>Payer</TableHead>
          <TableHead>Settlement</TableHead>
          <TableHead className="text-right">When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {receipts.map(r => (
          <TableRow key={r.id} className={r.id === latestReceiptId ? "animate-fade-in bg-primary/5" : undefined}>
            <TableCell className="font-medium">
              <div className="flex items-center gap-1.5">
                {r.parentId && <CornerDownRight className="h-3.5 w-3.5 text-primary" />}
                <span>{r.tool}</span>
              </div>
            </TableCell>
            <TableCell className="text-muted-foreground">{r.server}</TableCell>
            <TableCell className="tabular-nums">{formatTokens(r.amountRaw, 9, r.assetSymbol)}</TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">{shortHex(r.payer)}</TableCell>
            <TableCell>
              {r.status === "settled" ? (
                r.txHash ? (
                  <a
                    href={`${TESTNET_DEPLOY}${r.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    {shortHex(r.txHash)} <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <Badge variant="success">settled</Badge>
                )
              ) : (
                <Badge variant="destructive">failed</Badge>
              )}
            </TableCell>
            <TableCell className="text-right text-xs text-muted-foreground">{timeAgo(r.createdAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
