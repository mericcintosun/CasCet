import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const SITE = "https://cascet.vercel.app";
const TITLE = "CasCet · Payments that cascade";
const DESCRIPTION =
  "The monetization layer for MCP on Casper. Turn any MCP server into a paid service with per-tool x402 micropayments, plus composable, budget-bounded cascading payments settled on-chain.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  applicationName: "CasCet",
  title: { default: TITLE, template: "%s · CasCet" },
  description: DESCRIPTION,
  keywords: [
    "x402",
    "MCP",
    "Model Context Protocol",
    "Casper",
    "Casper Network",
    "AI agents",
    "agentic payments",
    "micropayments",
    "machine-to-machine",
    "CEP-18",
    "DeFi",
    "RWA",
    "on-chain payments",
  ],
  authors: [{ name: "Meriç Cintosun", url: "https://github.com/mericcintosun" }],
  creator: "Meriç Cintosun",
  publisher: "CasCet",
  category: "technology",
  formatDetection: { email: false, telephone: false, address: false },
  alternates: { canonical: "/" },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  openGraph: {
    type: "website",
    url: SITE,
    siteName: "CasCet",
    title: TITLE,
    description:
      "Stripe for MCP on Casper: per-tool x402 micropayments with composable, budget-bounded agent-to-agent payment chains.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "CasCet · Payments that cascade" }],
  },
  twitter: {
    card: "summary_large_image",
    site: "@cascet_xyz",
    creator: "@cascet_xyz",
    title: TITLE,
    description:
      "Stripe for MCP on Casper: per-tool x402 micropayments with cascading agent-to-agent chains.",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0d12" },
    { media: "(prefers-color-scheme: light)", color: "#faf9f2" },
  ],
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
