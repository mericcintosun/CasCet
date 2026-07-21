"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useCasperWallet } from "@/lib/use-casper-wallet";

type WalletValue = ReturnType<typeof useCasperWallet>;

const WalletContext = createContext<WalletValue | null>(null);

/** One shared Casper Wallet instance for the header button + the withdraw panel. */
export function WalletProvider({ children }: { children: ReactNode }) {
  const wallet = useCasperWallet();
  return <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
