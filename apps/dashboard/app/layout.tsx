import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://cascet.dev"),
  title: {
    default: "CasCet — payments that cascade",
    template: "%s · CasCet",
  },
  description:
    "The monetization layer for MCP on Casper. Turn any MCP server into a paid service with per-tool x402 micropayments — plus composable, budget-bounded cascading payments settled on-chain.",
  keywords: ["x402", "MCP", "Casper", "AI agents", "micropayments", "agentic payments", "DeFi", "RWA"],
  openGraph: {
    title: "CasCet — payments that cascade",
    description:
      "Stripe for MCP on Casper: per-tool x402 micropayments with composable, budget-bounded agent-to-agent payment chains.",
    url: "https://cascet.dev",
    siteName: "CasCet",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "CasCet — payments that cascade",
    description: "Stripe for MCP on Casper — per-tool x402 micropayments with cascading agent-to-agent chains.",
    images: ["/og.png"],
  },
  icons: { icon: "/logo.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="font-sans">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
