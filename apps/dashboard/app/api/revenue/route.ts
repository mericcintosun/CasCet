import {
  CSPR_LIVE_ACCOUNT,
  CSPR_LIVE_CONTRACT,
  DEMO_TOKEN_PACKAGE,
  PAYEES,
  REVENUE_SPLIT_PACKAGE,
  TOKEN_DECIMALS,
  TOKEN_SYMBOL,
  TOTAL_SHARES,
} from "@/lib/casper/constants";

export const dynamic = "force-dynamic";

/**
 * RevenueSplit config for the withdraw UI. Shares are immutable deploy constants;
 * the exact releasable amount is confirmed by the on-chain `release` tx itself
 * (Odra stores CEP-18 balances internally, so a precise live read isn't practical
 * without an indexer — the splitter's held balance is verifiable on cspr.live).
 */
export async function GET(): Promise<Response> {
  return Response.json({
    token: { symbol: TOKEN_SYMBOL, decimals: TOKEN_DECIMALS, package: DEMO_TOKEN_PACKAGE },
    splitter: {
      package: REVENUE_SPLIT_PACKAGE,
      totalShares: TOTAL_SHARES,
      csprLive: CSPR_LIVE_CONTRACT + REVENUE_SPLIT_PACKAGE,
    },
    payees: PAYEES.map((p) => ({
      label: p.label,
      accountHash: p.accountHash,
      publicKeyHex: p.publicKeyHex,
      share: p.share,
      percent: Math.round((p.share / TOTAL_SHARES) * 100),
      csprLive: CSPR_LIVE_ACCOUNT + p.publicKeyHex,
    })),
  });
}
