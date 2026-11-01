import type { Metadata } from "next";

/** Metadata for the client-rendered /explorer page (a "use client" page cannot export it). */
export const metadata: Metadata = {
  title: "Explorer",
  description:
    "The machine-to-machine x402 economy running through CasCet on Casper Testnet, reconstructed from the on-chain ReceiptRegistry.",
  alternates: { canonical: "/explorer" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
