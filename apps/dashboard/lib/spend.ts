import type { PaymentReceipt } from "@cascet/core";
import { toBigIntSafe } from "./utils";

export interface AssetSpend {
  /** Bare lower-case package hash. */
  asset: string;
  symbol: string;
  raw: bigint;
  calls: number;
}

/**
 * Total settled spend per asset for the receipts whose payer matches. Payer
 * identity is matched by the caller (account hash, after converting public
 * keys), so this stays pure.
 */
export function spendByAsset(receipts: readonly PaymentReceipt[], isPayer: (payer: string) => boolean): AssetSpend[] {
  const byAsset = new Map<string, AssetSpend>();
  for (const r of receipts) {
    if (r.status !== "settled" || !isPayer(r.payer)) continue;
    const asset = r.asset.trim().toLowerCase().replace(/^hash-/, "");
    const entry = byAsset.get(asset) ?? { asset, symbol: r.assetSymbol || "?", raw: 0n, calls: 0 };
    entry.raw += toBigIntSafe(r.amountRaw);
    entry.calls += 1;
    byAsset.set(asset, entry);
  }
  return [...byAsset.values()].sort((a, b) => (a.raw === b.raw ? 0 : b.raw > a.raw ? 1 : -1));
}
