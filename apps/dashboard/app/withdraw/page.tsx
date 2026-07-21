"use client";

import { SiteHeader } from "@/components/site-header";
import { RevenueSplitPanel } from "@/components/revenue-split-panel";
import { WalletProvider } from "@/lib/wallet-context";

export default function WithdrawPage() {
  return (
    <WalletProvider>
      <div className="min-h-screen">
        <SiteHeader showWallet />

        <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Withdraw revenue</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              A server&apos;s earnings can route to an on-chain <span className="text-foreground">RevenueSplit</span>{" "}
              that pays co-authors by fixed weights, enforced at the contract level. Connect Casper Wallet and
              pull your share — a real <code className="text-xs">release</code> settled on Casper Testnet, with a
              cspr.live link.
            </p>
          </div>

          <RevenueSplitPanel />
        </main>
      </div>
    </WalletProvider>
  );
}
