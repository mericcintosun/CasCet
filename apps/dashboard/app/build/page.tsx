import { SiteHeader } from "@/components/site-header";
import { BuildWizard } from "@/components/build-wizard";

export const metadata = {
  title: "Build · CasCet",
  description: "Generate a validated cascet.config.json to monetize any MCP server with x402 on Casper.",
};

export default function BuildPage() {
  return (
    <div className="min-h-screen">
      <SiteHeader />

      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Monetize your MCP server</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Fill in your server, payment account and per-tool prices. CasCet generates a validated{" "}
            <code className="text-xs">cascet.config.json</code> and the exact <code className="text-xs">npx @cascet/cli</code>{" "}
            commands — no code changes to your tools.
          </p>
        </div>

        <BuildWizard />
      </main>
    </div>
  );
}
