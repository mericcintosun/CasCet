import { Suspense } from "react";
import { SiteHeader } from "@/components/site-header";
import { ConnectBuilder } from "@/components/connect/connect-builder";

export const metadata = {
  title: "Connect",
  description:
    "Set a buyer's budget and policy for paid MCP tools: seller and token allowlists, per-call and session caps, as a cascet connect command or an MCP client config.",
};

export default function ConnectPage() {
  return (
    <div className="min-h-screen">
      <SiteHeader />

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Connect an agent, with a budget</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            <code className="text-xs">cascet connect</code> lets Claude, Cursor or any MCP host call paid tools: it answers each
            x402 challenge by signing a payment from your agent&apos;s key. Decide here who it may pay, in which token, and how much
            per call and per session, then copy the command or the MCP client config.
          </p>
        </div>

        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
          <ConnectBuilder />
        </Suspense>
      </main>
    </div>
  );
}
