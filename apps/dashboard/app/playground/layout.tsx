import type { Metadata } from "next";

/** Metadata for the client-rendered /playground page (a "use client" page cannot export it). */
export const metadata: Metadata = {
  title: "Playground",
  description:
    "Simulate a budget-bounded payment cascade: tool prices, attribution up the tree, and what settles when a hop would overspend.",
  alternates: { canonical: "/playground" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
