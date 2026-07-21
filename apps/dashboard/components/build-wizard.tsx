"use client";

import * as React from "react";
import { CheckCircle2, Download, Plus, TriangleAlert, X } from "lucide-react";
import {
  NETWORK_CASPER_TESTNET,
  DEFAULT_FACILITATOR_URL,
  DEFAULT_GATEWAY_PORT,
  cascetConfigSchema,
} from "@cascet/core";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";

interface ToolRow {
  name: string;
  price: string;
  description: string;
}
interface FormState {
  name: string;
  upstreamKind: "stdio" | "http";
  command: string;
  args: string;
  url: string;
  payTo: string;
  port: string;
  assetPackageHash: string;
  assetName: string;
  assetSymbol: string;
  assetDecimals: string;
  tokensPerUsd: string;
  facilitatorUrl: string;
  facilitatorApiKey: string;
  defaultPrice: string;
  tools: ToolRow[];
}

const INITIAL: FormState = {
  name: "my-paid-mcp",
  upstreamKind: "stdio",
  command: "node",
  args: "./my-mcp-server.js",
  url: "http://localhost:8000/mcp",
  payTo: "",
  port: String(DEFAULT_GATEWAY_PORT),
  // Prefilled with CasCet's own testnet WCSPR demo token as a working example.
  assetPackageHash: "b3e9908b6cdbf5c565b686938994e3ac8e6749f41bcbe83615604321a0965d49",
  assetName: "Wrapped CSPR",
  assetSymbol: "WCSPR",
  assetDecimals: "9",
  tokensPerUsd: "50",
  facilitatorUrl: DEFAULT_FACILITATOR_URL,
  facilitatorApiKey: "",
  defaultPrice: "",
  tools: [{ name: "my_tool", price: "$0.01", description: "example priced tool" }],
};

function buildConfig(s: FormState): Record<string, unknown> {
  const upstream =
    s.upstreamKind === "http"
      ? { type: "http", url: s.url }
      : { type: "stdio", command: s.command, args: s.args.trim() ? s.args.trim().split(/\s+/) : [] };

  const tools: Record<string, { price: string; description?: string }> = {};
  for (const t of s.tools) {
    if (!t.name.trim()) continue;
    tools[t.name.trim()] = { price: t.price.trim(), ...(t.description.trim() ? { description: t.description.trim() } : {}) };
  }

  return {
    name: s.name,
    upstream,
    network: NETWORK_CASPER_TESTNET,
    payTo: s.payTo || "<your Casper public key>",
    asset: {
      packageHash: s.assetPackageHash,
      name: s.assetName,
      symbol: s.assetSymbol,
      decimals: Number(s.assetDecimals || "9"),
      version: "1",
      tokensPerUsd: Number(s.tokensPerUsd || "50"),
    },
    facilitator: {
      url: s.facilitatorUrl,
      ...(s.facilitatorApiKey.trim() ? { apiKey: s.facilitatorApiKey.trim() } : {}),
    },
    pricing: {
      ...(s.defaultPrice.trim() ? { default: { price: s.defaultPrice.trim() } } : {}),
      tools,
    },
    port: Number(s.port || "4402"),
  };
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-muted-foreground/70">{hint}</span>}
    </label>
  );
}

export function BuildWizard() {
  const [s, setS] = React.useState<FormState>(INITIAL);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setS((p) => ({ ...p, [k]: v }));

  const config = React.useMemo(() => buildConfig(s), [s]);
  const json = React.useMemo(() => JSON.stringify(config, null, 2), [config]);
  const parsed = React.useMemo(() => cascetConfigSchema.safeParse(config), [config]);

  const setTool = (i: number, patch: Partial<ToolRow>) =>
    setS((p) => ({ ...p, tools: p.tools.map((t, idx) => (idx === i ? { ...t, ...patch } : t)) }));
  const addTool = () => setS((p) => ({ ...p, tools: [...p.tools, { name: "", price: "$0.01", description: "" }] }));
  const removeTool = (i: number) => setS((p) => ({ ...p, tools: p.tools.filter((_, idx) => idx !== i) }));

  const commands = [
    `npx @cascet/cli init ${s.name}`,
    `# replace the generated cascet.config.json with the one on the right (or download it)`,
    `npx @cascet/cli wrap                       # your MCP server is now paid`,
  ].join("\n");
  const connectCmd = `CASCET_KEY_PATH=./agent.pem npx @cascet/cli connect http://localhost:${s.port || "4402"}/mcp`;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_minmax(0,26rem)]">
      {/* form */}
      <div className="space-y-5">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Server</CardTitle>
            <CardDescription>The MCP server you want to monetize. Its code stays unchanged.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Name">
              <Input value={s.name} onChange={(e) => set("name", e.target.value)} placeholder="my-paid-mcp" />
            </Field>
            <div className="flex gap-1 rounded-md border bg-background/40 p-1 text-sm">
              {(["stdio", "http"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => set("upstreamKind", k)}
                  className={cn(
                    "flex-1 rounded px-3 py-1.5 font-medium transition-colors",
                    s.upstreamKind === k ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {k === "stdio" ? "stdio (local process)" : "http (remote)"}
                </button>
              ))}
            </div>
            {s.upstreamKind === "stdio" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Command">
                  <Input value={s.command} onChange={(e) => set("command", e.target.value)} placeholder="node" />
                </Field>
                <Field label="Args" hint="space-separated">
                  <Input value={s.args} onChange={(e) => set("args", e.target.value)} placeholder="./server.js" />
                </Field>
              </div>
            ) : (
              <Field label="Upstream URL">
                <Input value={s.url} onChange={(e) => set("url", e.target.value)} placeholder="http://localhost:8000/mcp" />
              </Field>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payment</CardTitle>
            <CardDescription>Where earnings go, on Casper Testnet.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="payTo" hint="your Casper public key, or a RevenueSplit contract account">
              <Input value={s.payTo} onChange={(e) => set("payTo", e.target.value)} placeholder="01ab… / account-hash-…" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Gateway port">
                <Input value={s.port} onChange={(e) => set("port", e.target.value)} inputMode="numeric" />
              </Field>
              <Field label="tokensPerUsd" hint="CEP-18 units per USD (testnet demo rate)">
                <Input value={s.tokensPerUsd} onChange={(e) => set("tokensPerUsd", e.target.value)} inputMode="numeric" />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Asset package hash" hint="CEP-18 payment token">
                <Input value={s.assetPackageHash} onChange={(e) => set("assetPackageHash", e.target.value)} />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Symbol">
                  <Input value={s.assetSymbol} onChange={(e) => set("assetSymbol", e.target.value)} />
                </Field>
                <Field label="Decimals">
                  <Input value={s.assetDecimals} onChange={(e) => set("assetDecimals", e.target.value)} inputMode="numeric" />
                </Field>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Facilitator URL">
                <Input value={s.facilitatorUrl} onChange={(e) => set("facilitatorUrl", e.target.value)} />
              </Field>
              <Field label="Facilitator API key" hint="CSPR.cloud access token (optional)">
                <Input value={s.facilitatorApiKey} onChange={(e) => set("facilitatorApiKey", e.target.value)} placeholder="optional" />
              </Field>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Tools &amp; prices</CardTitle>
                <CardDescription>Price each tool per call. Unlisted tools stay free (or use a default).</CardDescription>
              </div>
              <Button size="sm" variant="outline" onClick={addTool}>
                <Plus className="h-3.5 w-3.5" /> Tool
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {s.tools.map((t, i) => (
              <div key={i} className="grid grid-cols-[1fr_5.5rem_auto] gap-2">
                <Input value={t.name} onChange={(e) => setTool(i, { name: e.target.value })} placeholder="tool_name" />
                <Input value={t.price} onChange={(e) => setTool(i, { price: e.target.value })} placeholder="$0.01" />
                <Button size="icon" variant="ghost" onClick={() => removeTool(i)} aria-label="remove">
                  <X className="h-4 w-4" />
                </Button>
                <Input
                  value={t.description}
                  onChange={(e) => setTool(i, { description: e.target.value })}
                  placeholder="description (optional)"
                  className="col-span-3"
                />
              </div>
            ))}
            <Field label="Default price" hint="fallback for unlisted tools — leave blank to keep them free">
              <Input value={s.defaultPrice} onChange={(e) => set("defaultPrice", e.target.value)} placeholder="e.g. $0.005" />
            </Field>
          </CardContent>
        </Card>
      </div>

      {/* live output */}
      <div className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">cascet.config.json</CardTitle>
              {parsed.success ? (
                <Badge variant="success" className="gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" /> valid
                </Badge>
              ) : (
                <Badge variant="destructive" className="gap-1">
                  <TriangleAlert className="h-3.5 w-3.5" /> {parsed.error.issues.length} issue
                  {parsed.error.issues.length === 1 ? "" : "s"}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="relative">
              <div className="absolute right-2 top-2 flex gap-1.5">
                <CopyButton text={json} />
                <a
                  href={`data:application/json;charset=utf-8,${encodeURIComponent(json + "\n")}`}
                  download="cascet.config.json"
                  aria-label="Download"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/40 text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                >
                  <Download className="h-4 w-4" />
                </a>
              </div>
              <pre className="max-h-[22rem] overflow-auto rounded-lg border bg-background/50 p-3 pr-20 font-mono text-[11.5px] leading-relaxed tabular-nums">
                {json}
              </pre>
            </div>
            {!parsed.success && (
              <ul className="space-y-1 text-[11px] text-destructive">
                {parsed.error.issues.slice(0, 4).map((iss, i) => (
                  <li key={i}>
                    <span className="font-mono">{iss.path.join(".") || "(root)"}</span>: {iss.message}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Run it</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="relative">
              <div className="absolute right-2 top-2">
                <CopyButton text={commands} />
              </div>
              <pre className="overflow-auto rounded-lg border bg-background/50 p-3 pr-12 font-mono text-[11.5px] leading-relaxed">
                {commands}
              </pre>
            </div>
            <div className="relative">
              <div className="absolute right-2 top-2">
                <CopyButton text={connectCmd} />
              </div>
              <pre className="overflow-auto rounded-lg border bg-background/50 p-3 pr-12 font-mono text-[11.5px] leading-relaxed">
                {connectCmd}
              </pre>
            </div>
            <p className="text-[11px] text-muted-foreground">
              This generates a config for the open-source CLI you run yourself. A hosted control plane — a paid
              endpoint + dashboard in one click — is on the roadmap.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
