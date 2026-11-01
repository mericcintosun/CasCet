"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Coins, Eye, Wallet } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyButton } from "@/components/copy-button";
import { cliCommand } from "@/lib/connect-config";

type Flow = {
  key: string;
  label: string;
  icon: typeof Coins;
  blurb: React.ReactNode;
  code: string;
  cta?: { label: string; href: string };
};

const FLOWS: Flow[] = [
  {
    key: "sell",
    label: "Sell",
    icon: Coins,
    blurb: (
      <>
        You have an MCP server. Put a paywall in front of it and price each tool. Agents pay per call in CEP-18 over x402; your
        tool code stays untouched.
      </>
    ),
    // Every command runs the one pinned @cascet/cli release (M13): never latest, which is the unsupported 0.1.0.
    code: [
      `${cliCommand("init")}          # writes cascet.config.json`,
      "# payTo = your ACCOUNT HASH (00…), not your public key:",
      `${cliCommand("account-hash 01ab…")}   # prints it for a public key`,
      "# then set per-tool prices and a facilitator that can settle your token",
      `${cliCommand("wrap")}          # your server is now paid`,
    ].join("\n"),
    cta: { label: "Generate your config", href: "/build" },
  },
  {
    key: "buy",
    label: "Buy",
    icon: Wallet,
    blurb: (
      <>
        You have an agent (or an MCP host like Claude or Cursor). Point it at a paid server; CasCet answers every 402 challenge
        automatically, signing payments from a key, but only to the sellers and tokens you allow and within your caps.
      </>
    ),
    code: `CASCET_KEY_PATH=./agent.pem \\
CASCET_NETWORK=casper:casper-test \\
CASCET_ALLOWED_PAYTO=00881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36 \\
CASCET_ALLOWED_ASSETS=cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3 \\
CASCET_MAX_PER_CALL=1000000000 \\
CASCET_MAX_SESSION=5000000000 \\
${cliCommand("connect http://localhost:4402/mcp")}   # the local testnet demo gateway`,
    cta: { label: "Generate yours: allowlists + spending caps", href: "/connect" },
  },
  {
    key: "explore",
    label: "Explore",
    icon: Eye,
    blurb: (
      <>
        Just want to see it run? Everything settles for real on Casper Testnet — the whole cascade and the autonomous agent — no mock in the path.
      </>
    ),
    code: `pnpm install && pnpm build
pnpm --filter @cascet/e2e connect-demo  # real Claude (Max plan) buys tools, settles on-chain — free
pnpm --filter @cascet/e2e demo          # cascade: agent pays a tool that pays 3 more, every hop on-chain`,
    cta: { label: "Open the live economy explorer", href: "/explorer" },
  },
];

export function GetStarted() {
  return (
    <Tabs defaultValue="sell" className="w-full">
      <TabsList>
        {FLOWS.map(f => (
          <TabsTrigger key={f.key} value={f.key}>
            <f.icon className="h-4 w-4" />
            {f.label}
          </TabsTrigger>
        ))}
      </TabsList>

      {FLOWS.map(f => (
        <TabsContent key={f.key} value={f.key}>
          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div className="min-w-0">
              <p className="text-pretty leading-relaxed text-muted-foreground">{f.blurb}</p>
              {f.cta && (
                <Link
                  href={f.cta.href}
                  className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-primary transition-opacity hover:opacity-80"
                >
                  {f.cta.label} <ArrowRight className="h-4 w-4" />
                </Link>
              )}
            </div>
            <CodeBlock code={f.code} />
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="group relative min-w-0 overflow-hidden rounded-xl border border-white/10 bg-[hsl(228_16%_7%)]">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" />
          <span className="h-2.5 w-2.5 rounded-full bg-warning/60" />
          <span className="h-2.5 w-2.5 rounded-full bg-success/60" />
          <span className="ml-2 font-mono text-[11px] text-white/60">terminal</span>
        </span>
        {/* always-dark block: fixed colours, not theme tokens (which flip in light mode, L96) */}
        <CopyButton
          text={code}
          className="border-white/15 bg-white/5 text-white/70 hover:border-white/30 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed">
        <code>
          {code.split("\n").map((line, i) => {
            const hash = line.indexOf("#");
            const hasComment = hash >= 0 && !line.slice(0, hash).includes('"');
            return (
              <span key={i} className="block">
                {hasComment ? (
                  <>
                    <span className="text-white/85">{line.slice(0, hash)}</span>
                    <span className="text-white/60">{line.slice(hash)}</span>
                  </>
                ) : (
                  <span className="text-[#C6F94E]">{line}</span>
                )}
              </span>
            );
          })}
        </code>
      </pre>
    </div>
  );
}
