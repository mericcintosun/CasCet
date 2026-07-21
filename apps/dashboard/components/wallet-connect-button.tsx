"use client";

import { Wallet, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/lib/wallet-context";
import { shortHex } from "@/lib/utils";

/** Casper Wallet connect / disconnect control (shared wallet context). */
export function WalletConnectButton() {
  const { connected, connecting, publicKeyHex, connect, disconnect } = useWallet();

  if (connected && publicKeyHex) {
    return (
      <Button variant="outline" size="sm" onClick={disconnect} title={publicKeyHex}>
        <span className="font-mono text-xs tabular-nums">{shortHex(publicKeyHex, 6, 4)}</span>
        <LogOut className="h-3.5 w-3.5" />
      </Button>
    );
  }

  return (
    <Button variant="default" size="sm" onClick={connect} disabled={connecting}>
      <Wallet className="h-3.5 w-3.5" />
      {connecting ? "Connecting…" : "Connect wallet"}
    </Button>
  );
}
