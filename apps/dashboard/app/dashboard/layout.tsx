import type { Metadata } from "next";

/** Metadata for the client-rendered /dashboard page (a "use client" page cannot export it). */
export const metadata: Metadata = {
  title: "Dashboard",
  description:
    "Seller dashboard: revenue, receipts and the cascading payment graph, rebuilt from the x402 payments anchored in the ReceiptRegistry on Casper Testnet.",
  alternates: { canonical: "/dashboard" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
