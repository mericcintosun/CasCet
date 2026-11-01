import type { Metadata } from "next";

/** Metadata for the client-rendered /withdraw page (a "use client" page cannot export it). */
export const metadata: Metadata = {
  title: "Withdraw",
  description:
    "Release your share of a RevenueSplit on Casper Testnet with Casper Wallet.",
  alternates: { canonical: "/withdraw" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
