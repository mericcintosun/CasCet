"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, ArrowRightLeft, CheckCircle2, Download, Loader2, Plus, TriangleAlert, X } from "lucide-react";
import {
  DEFAULT_FACILITATOR_URL,
  DEFAULT_GATEWAY_PORT,
  NETWORK_CASPER_TESTNET,
  cascetConfigSchema,
  usdPriceToTokenUnits,
} from "@cascet/core";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyButton } from "@/components/copy-button";
import { CONTRACTS } from "@/lib/economy";
import { accountHashFromPublicKey } from "@/lib/casper/account-hash";
import { CONTRACT_PAYEE_UNSUPPORTED, parseAssetInput, parsePayeeInput, payToValue } from "@/lib/casper/keys";
import { cliCommand, rawToTokens, shellQuote } from "@/lib/connect-config";
import { CliPinNote } from "@/components/cli-pin-note";
import { shortHex } from "@/lib/utils";

/**
 * Settlement setups that actually settle (M03 / M40). The hosted facilitator
 * sends the CEP-3009 `value` argument; CasCet's own x402 token expects
 * `amount`, so it only settles through the self-hosted facilitator.
 */
type Settlement = "self-hosted" | "hosted";

const SELF_HOSTED_FACILITATOR_URL = "http://127.0.0.1:4501";

/**
 * One line that starts CasCet's self-hosted facilitator for this seller. It
 * only settles to the accounts in CASCET_SELLER_ACCOUNT_HASH and in the tokens
 * in CASCET_ALLOWED_ASSETS (default: CasCet's testnet x402 token), and pnpm
 * runs the script from tools/e2e, so the key path must be absolute.
 */
function facilitatorHowto(payTo: string | null, assetHash: string | null): string {
  const env = [
    "CASCET_FACILITATOR_KEY=/absolute/path/to/fee-payer.pem",
    `CASCET_SELLER_ACCOUNT_HASH=${payTo ?? "00<your account hash>"}`,
    ...(assetHash && assetHash !== CONTRACTS.x402Token ? [`CASCET_ALLOWED_ASSETS=${assetHash}`] : []),
  ];
  return `${env.join(" ")} pnpm --filter @cascet/e2e facilitator`;
}

const CASCET_TOKEN = {
  assetPackageHash: `hash-${CONTRACTS.x402Token}`,
  assetName: "CasCet X402 Token",
  assetSymbol: "WCSPR",
  assetDecimals: "9",
};

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
  settlement: Settlement;
  assetPackageHash: string;
  assetName: string;
  assetSymbol: string;
  assetDecimals: string;
  tokensPerUsd: string;
  facilitatorUrl: string;
  facilitatorApiKey: string;
  defaultPrice: string;
  freeTools: string;
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
  settlement: "self-hosted",
  ...CASCET_TOKEN,
  tokensPerUsd: "50",
  facilitatorUrl: SELF_HOSTED_FACILITATOR_URL,
  facilitatorApiKey: "",
  defaultPrice: "",
  freeTools: "",
  tools: [{ name: "my_tool", price: "$0.01", description: "example priced tool" }],
};

const PRESETS: Record<Settlement, Partial<FormState>> = {
  "self-hosted": { ...CASCET_TOKEN, facilitatorUrl: SELF_HOSTED_FACILITATOR_URL },
  hosted: { assetPackageHash: "", assetName: "", assetSymbol: "", assetDecimals: "9", facilitatorUrl: DEFAULT_FACILITATOR_URL },
};

type Conversion = { publicKey: string; accountHash?: string; error?: string };

const splitList = (s: string): string[] => [...new Set(s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];

function Field({ id, label, hint, children }: { id: string; label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function BuildWizard() {
  const [s, setS] = React.useState<FormState>(INITIAL);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setS((p) => ({ ...p, [k]: v }));

  // ── payTo: account hash in, public key converted client-side (M01 / M41) ──
  const payee = React.useMemo(() => parsePayeeInput(s.payTo), [s.payTo]);
  const [conversion, setConversion] = React.useState<Conversion | null>(null);
  React.useEffect(() => {
    if (payee.kind !== "public-key") {
      setConversion(null);
      return;
    }
    let alive = true;
    const publicKey = payee.publicKey;
    setConversion({ publicKey });
    accountHashFromPublicKey(publicKey)
      .then((accountHash) => alive && setConversion({ publicKey, accountHash }))
      .catch(() => alive && setConversion({ publicKey, error: "this is not a valid Casper public key" }));
    return () => {
      alive = false;
    };
  }, [payee]);

  const payTarget =
    payee.kind === "account" || payee.kind === "package"
      ? payee
      : payee.kind === "public-key" && conversion?.publicKey === payee.publicKey && conversion.accountHash
        ? ({ kind: "account", hash: conversion.accountHash } as const)
        : null;
  const payToIssue =
    payee.kind === "empty"
      ? "enter the seller's account hash (00 + 64 hex), or paste a public key to convert it"
      : payee.kind === "invalid"
        ? payee.reason
        : payee.kind === "package"
          ? `${CONTRACT_PAYEE_UNSUPPORTED}. Enter the account hash that should receive the payments.`
          : payee.kind === "public-key" && !payTarget
            ? conversion?.error ?? "converting the public key…"
            : null;

  const asset = React.useMemo(() => parseAssetInput(s.assetPackageHash), [s.assetPackageHash]);
  const freeTools = React.useMemo(() => splitList(s.freeTools), [s.freeTools]);

  const config = React.useMemo(() => {
    const upstream =
      s.upstreamKind === "http"
        ? { type: "http", url: s.url.trim() }
        : { type: "stdio", command: s.command.trim(), args: s.args.trim() ? s.args.trim().split(/\s+/) : [] };
    const tools: Record<string, { price: string; description?: string }> = {};
    for (const t of s.tools) {
      if (!t.name.trim()) continue;
      tools[t.name.trim()] = { price: t.price.trim(), ...(t.description.trim() ? { description: t.description.trim() } : {}) };
    }
    return {
      name: s.name.trim(),
      upstream,
      network: NETWORK_CASPER_TESTNET,
      payTo: payTarget ? payToValue(payTarget) : s.payTo.trim(),
      asset: {
        packageHash: asset.ok ? `hash-${asset.hash}` : s.assetPackageHash.trim(),
        name: s.assetName.trim(),
        symbol: s.assetSymbol.trim(),
        decimals: Number(s.assetDecimals || "9"),
        version: "1",
        tokensPerUsd: Number(s.tokensPerUsd || "50"),
      },
      facilitator: {
        url: s.facilitatorUrl.trim(),
        ...(s.facilitatorApiKey.trim() ? { apiKey: s.facilitatorApiKey.trim() } : {}),
      },
      pricing: {
        ...(s.defaultPrice.trim() ? { default: { price: s.defaultPrice.trim() } } : {}),
        tools,
        ...(freeTools.length ? { freeTools } : {}),
      },
      port: Number(s.port || DEFAULT_GATEWAY_PORT),
    };
  }, [s, payTarget, asset, freeTools]);

  const json = React.useMemo(() => JSON.stringify(config, null, 2), [config]);

  // Our own checks first (they explain more than the schema can), then the schema's.
  const issues = React.useMemo(() => {
    const out: Array<{ path: string; message: string }> = [];
    if (payToIssue) out.push({ path: "payTo", message: payToIssue });
    if (!asset.ok) out.push({ path: "asset.packageHash", message: asset.empty ? "enter the CEP-18 token's package hash" : asset.reason });
    if (!/^\d+$/.test(s.port) || Number(s.port) < 1 || Number(s.port) > 65535) out.push({ path: "port", message: "a port between 1 and 65535" });
    if (!/^\d+$/.test(s.assetDecimals) || Number(s.assetDecimals) > 18) out.push({ path: "asset.decimals", message: "an integer from 0 to 18" });
    const names = s.tools.map((t) => t.name.trim()).filter(Boolean);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) out.push({ path: `pricing.tools.${dup}`, message: "this tool is listed twice" });
    const both = freeTools.find((f) => names.includes(f));
    if (both) out.push({ path: "pricing.freeTools", message: `"${both}" is both priced and free` });
    const parsed = cascetConfigSchema.safeParse(config);
    if (!parsed.success) {
      for (const iss of parsed.error.issues) {
        const path = iss.path.join(".") || "(root)";
        if (!out.some((o) => o.path === path)) out.push({ path, message: iss.message });
      }
    }
    return out;
  }, [payToIssue, asset, s.port, s.assetDecimals, s.tools, freeTools, config]);

  /** Per-call price in token units for each tool, when the price and asset are valid. */
  const priceOf = React.useCallback(
    (price: string): bigint | null => {
      try {
        return usdPriceToTokenUnits(price.trim(), {
          packageHash: "",
          name: "",
          symbol: "",
          decimals: Number(s.assetDecimals),
          version: "1",
          tokensPerUsd: Number(s.tokensPerUsd),
        });
      } catch {
        return null;
      }
    },
    [s.assetDecimals, s.tokensPerUsd],
  );
  const decimals = /^\d+$/.test(s.assetDecimals) ? Number(s.assetDecimals) : 9;
  const symbol = s.assetSymbol.trim() || "tokens";

  const setTool = (i: number, patch: Partial<ToolRow>) =>
    setS((p) => ({ ...p, tools: p.tools.map((t, idx) => (idx === i ? { ...t, ...patch } : t)) }));
  const addTool = () => setS((p) => ({ ...p, tools: [...p.tools, { name: "", price: "$0.01", description: "" }] }));
  const removeTool = (i: number) => setS((p) => ({ ...p, tools: p.tools.filter((_, idx) => idx !== i) }));
  const choose = (value: string) => {
    const v = value as Settlement;
    setS((p) => ({ ...p, settlement: v, ...PRESETS[v] }));
  };

  // Hand the buyer side to /connect: gateway URL, seller, asset and the highest per-call price.
  const maxPrice = s.tools.reduce<bigint | null>((m, t) => {
    const raw = priceOf(t.price);
    return raw !== null && (m === null || raw > m) ? raw : m;
  }, null);
  const connectHref = (() => {
    const q = new URLSearchParams({ gateway: `http://localhost:${s.port || DEFAULT_GATEWAY_PORT}/mcp`, network: "testnet" });
    // /connect only allowlists account hashes; a contract package would be refused there.
    if (payTarget?.kind === "account") q.set("seller", payToValue(payTarget));
    if (asset.ok) q.set("asset", asset.hash);
    if (maxPrice !== null) {
      q.set("perCall", rawToTokens(maxPrice, decimals));
      q.set("decimals", String(decimals));
    }
    return `/connect?${q.toString()}`;
  })();

  const howto = facilitatorHowto(
    payTarget?.kind === "account" ? payToValue(payTarget) : null,
    asset.ok ? asset.hash : null,
  );

  // The server name is user input: shell-quoted like everything else that is copied into a terminal.
  const sellerCommands = [
    cliCommand(`init ${shellQuote(s.name.trim() || "my-paid-mcp")}`),
    `# replace the generated cascet.config.json with the one on this page (or download it)`,
    `${cliCommand("wrap")}   # your MCP server is now paid`,
  ].join("\n");

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      {/* form */}
      <div className="min-w-0 space-y-5">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Server</CardTitle>
            <CardDescription>The MCP server you want to monetize. Its code stays unchanged.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field id="srv-name" label="Name">
              <Input id="srv-name" value={s.name} onChange={(e) => set("name", e.target.value)} placeholder="my-paid-mcp" />
            </Field>
            <Tabs value={s.upstreamKind} onValueChange={(v) => set("upstreamKind", v as FormState["upstreamKind"])}>
              <TabsList aria-label="How the gateway reaches your MCP server">
                <TabsTrigger value="stdio">stdio (local process)</TabsTrigger>
                <TabsTrigger value="http">http (remote)</TabsTrigger>
              </TabsList>
              <TabsContent value="stdio">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field id="srv-cmd" label="Command">
                    <Input id="srv-cmd" value={s.command} onChange={(e) => set("command", e.target.value)} placeholder="node" />
                  </Field>
                  <Field id="srv-args" label="Args" hint="space-separated">
                    <Input id="srv-args" value={s.args} onChange={(e) => set("args", e.target.value)} placeholder="./server.js" />
                  </Field>
                </div>
              </TabsContent>
              <TabsContent value="http">
                <Field id="srv-url" label="Upstream URL">
                  <Input id="srv-url" value={s.url} onChange={(e) => set("url", e.target.value)} placeholder="http://localhost:8000/mcp" />
                </Field>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payment</CardTitle>
            <CardDescription>Where earnings go, on Casper Testnet.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field
              id="pay-to"
              label="Seller account hash (payTo)"
              hint={
                <>
                  x402 pays an <span className="text-foreground">account hash</span>, not a public key: <code>00</code> + 64 hex or{" "}
                  <code>account-hash-…</code>. Paste a public key (<code>01…</code> / <code>02…</code>) and it is converted here, or run{" "}
                  <code>{cliCommand("account-hash <public-key>")}</code>. A contract package (<code>hash-…</code>) cannot
                  receive x402 payments yet.
                </>
              }
            >
              <Input
                id="pay-to"
                value={s.payTo}
                onChange={(e) => set("payTo", e.target.value)}
                placeholder="00… account hash, or a 01… / 02… public key"
                aria-invalid={payee.kind === "invalid" || Boolean(conversion?.error)}
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-xs"
              />
            </Field>
            {payee.kind === "public-key" && (
              <Alert variant={conversion?.error ? "destructive" : "default"} role="status">
                {conversion?.accountHash ? <ArrowRightLeft /> : conversion?.error ? <TriangleAlert /> : <Loader2 className="animate-spin" />}
                <AlertTitle>
                  {conversion?.accountHash
                    ? "Public key converted to its account hash"
                    : conversion?.error
                      ? "Could not convert this public key"
                      : "Converting the public key…"}
                </AlertTitle>
                <AlertDescription className="space-y-1 break-all font-mono text-[11px]">
                  <div>
                    <span className="text-muted-foreground">public key ({payee.algorithm}): </span>
                    {payee.publicKey}
                  </div>
                  {conversion?.accountHash && (
                    <div>
                      <span className="text-muted-foreground">payTo (account hash): </span>00{conversion.accountHash}
                    </div>
                  )}
                  {conversion?.error && <div>{conversion.error}</div>}
                </AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="port" label="Gateway port">
                <Input id="port" value={s.port} onChange={(e) => set("port", e.target.value)} inputMode="numeric" />
              </Field>
              <Field id="rate" label="tokensPerUsd" hint="token units per USD (a fixed testnet rate)">
                <Input id="rate" value={s.tokensPerUsd} onChange={(e) => set("tokensPerUsd", e.target.value)} inputMode="decimal" />
              </Field>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Token &amp; facilitator</CardTitle>
            <CardDescription>A facilitator verifies and settles each payment. Pick a setup that can actually settle.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Tabs value={s.settlement} onValueChange={choose}>
              <TabsList aria-label="Settlement setup" className="flex h-auto flex-wrap">
                <TabsTrigger value="self-hosted">Self-hosted · CasCet token</TabsTrigger>
                <TabsTrigger value="hosted">Hosted · CEP-3009 token</TabsTrigger>
              </TabsList>
              <TabsContent value="self-hosted" className="space-y-2 text-xs leading-relaxed text-muted-foreground">
                <p>
                  CasCet&apos;s x402 token (Cep18X402, on-chain symbol WCSPR) takes an <code>amount</code> argument in{" "}
                  <code>transfer_with_authorization</code>, so it settles only through CasCet&apos;s self-hosted facilitator. Run it next
                  to your gateway, from a CasCet checkout:
                </p>
                <pre className="overflow-x-auto rounded-md border bg-background/50 p-2 font-mono text-[11px] text-foreground">
                  {howto}
                </pre>
                <p>
                  It listens on {SELF_HOSTED_FACILITATOR_URL}, pays each settle&apos;s gas from that funded key and only settles to
                  the account in <code>CASCET_SELLER_ACCOUNT_HASH</code> (see docs/onchain.md).
                </p>
              </TabsContent>
              <TabsContent value="hosted" className="space-y-2 text-xs leading-relaxed text-muted-foreground">
                <p>
                  The hosted facilitator (<code>x402-facilitator.cspr.cloud</code>) only settles CEP-3009 tokens whose{" "}
                  <code>transfer_with_authorization</code> takes <code>value</code>, such as the official Wrapped CSPR. Enter such a
                  token below. CasCet&apos;s own x402 token cannot settle there: every settle would revert.
                </p>
              </TabsContent>
            </Tabs>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="asset-hash" label="Token package hash" hint="CEP-18 token with transfer_with_authorization">
                <Input
                  id="asset-hash"
                  value={s.assetPackageHash}
                  onChange={(e) => set("assetPackageHash", e.target.value)}
                  placeholder="hash-…"
                  aria-invalid={!asset.ok && !asset.empty}
                  spellCheck={false}
                  className="font-mono text-xs"
                />
              </Field>
              <Field id="asset-name" label="Token name" hint="must match the token's on-chain name (signed in the authorization)">
                <Input id="asset-name" value={s.assetName} onChange={(e) => set("assetName", e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field id="asset-symbol" label="Symbol">
                <Input id="asset-symbol" value={s.assetSymbol} onChange={(e) => set("assetSymbol", e.target.value)} />
              </Field>
              <Field id="asset-decimals" label="Decimals">
                <Input id="asset-decimals" value={s.assetDecimals} onChange={(e) => set("assetDecimals", e.target.value)} inputMode="numeric" />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="fac-url" label="Facilitator URL">
                <Input id="fac-url" value={s.facilitatorUrl} onChange={(e) => set("facilitatorUrl", e.target.value)} spellCheck={false} />
              </Field>
              <Field
                id="fac-key"
                label="Facilitator access token"
                hint={s.settlement === "hosted" ? "your CSPR.cloud access token" : "only if your facilitator requires one"}
              >
                <Input
                  id="fac-key"
                  value={s.facilitatorApiKey}
                  onChange={(e) => set("facilitatorApiKey", e.target.value)}
                  placeholder="optional"
                  autoComplete="off"
                />
              </Field>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">Tools &amp; prices</CardTitle>
                <CardDescription>
                  Price each tool per call. A tool that is neither priced nor listed as free is hidden from buyers, unless you set a
                  default price.
                </CardDescription>
              </div>
              <Button size="sm" variant="outline" onClick={addTool} className="shrink-0">
                <Plus className="h-3.5 w-3.5" /> Tool
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {s.tools.map((t, i) => {
              const raw = priceOf(t.price);
              const label = t.name.trim() || `tool ${i + 1}`;
              return (
                <div key={i} className="grid grid-cols-[minmax(0,1fr)_6rem_auto] gap-2">
                  <Input value={t.name} onChange={(e) => setTool(i, { name: e.target.value })} placeholder="tool_name" aria-label={`Tool ${i + 1} name`} />
                  <Input value={t.price} onChange={(e) => setTool(i, { price: e.target.value })} placeholder="$0.01" aria-label={`${label} price in USD`} />
                  <Button size="icon" variant="ghost" onClick={() => removeTool(i)} aria-label={`Remove ${label}`}>
                    <X className="h-4 w-4" />
                  </Button>
                  <Input
                    value={t.description}
                    onChange={(e) => setTool(i, { description: e.target.value })}
                    placeholder="description (optional)"
                    aria-label={`${label} description`}
                    className="col-span-3"
                  />
                  {raw !== null && (
                    <p className="col-span-3 -mt-1 text-[11px] text-muted-foreground">
                      = {rawToTokens(raw, decimals)} {symbol} per call ({raw.toString()} raw units)
                    </p>
                  )}
                </div>
              );
            })}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="free-tools" label="Free tools" hint="comma-separated; visible and callable without payment">
                <Input id="free-tools" value={s.freeTools} onChange={(e) => set("freeTools", e.target.value)} placeholder="e.g. ping, list_assets" />
              </Field>
              <Field id="default-price" label="Default price" hint="charged for every other tool; blank keeps them hidden">
                <Input id="default-price" value={s.defaultPrice} onChange={(e) => set("defaultPrice", e.target.value)} placeholder="e.g. $0.005" />
              </Field>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* live output */}
      <div className="min-w-0 space-y-4 lg:sticky lg:top-20 lg:self-start">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">cascet.config.json</CardTitle>
              {issues.length === 0 ? (
                <Badge variant="success" className="gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> valid
                </Badge>
              ) : (
                <Badge variant="destructive" className="gap-1">
                  <TriangleAlert className="h-3.5 w-3.5" aria-hidden /> {issues.length} issue{issues.length === 1 ? "" : "s"}
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
                  aria-label="Download cascet.config.json"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/40 text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                >
                  <Download className="h-4 w-4" />
                </a>
              </div>
              <pre className="max-h-[22rem] overflow-auto rounded-lg border bg-background/50 p-3 pr-20 font-mono text-[11.5px] leading-relaxed tabular-nums">
                {json}
              </pre>
            </div>
            {issues.length > 0 && (
              <ul className="space-y-1 text-[11px] text-destructive" aria-live="polite">
                {issues.slice(0, 6).map((iss, i) => (
                  <li key={i}>
                    <span className="font-mono">{iss.path}</span>: {iss.message}
                  </li>
                ))}
              </ul>
            )}
            {payTarget && (
              <p className="text-[11px] text-muted-foreground">
                Payments go to <span className="font-mono text-foreground">{shortHex(payToValue(payTarget), 10, 6)}</span>.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Run it</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {s.settlement === "self-hosted" && (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">1. Start the self-hosted facilitator (CasCet checkout):</p>
                <div className="relative">
                  <div className="absolute right-2 top-2">
                    <CopyButton text={howto} />
                  </div>
                  <pre className="overflow-x-auto rounded-lg border bg-background/50 p-3 pr-12 font-mono text-[11.5px] leading-relaxed">
                    {howto}
                  </pre>
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">{s.settlement === "self-hosted" ? "2. " : ""}Start the paid gateway:</p>
              <div className="relative">
                <div className="absolute right-2 top-2">
                  <CopyButton text={sellerCommands} />
                </div>
                <pre className="overflow-x-auto rounded-lg border bg-background/50 p-3 pr-12 font-mono text-[11.5px] leading-relaxed">
                  {sellerCommands}
                </pre>
              </div>
            </div>
            <CliPinNote />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Buyer bridges only talk to a remote gateway over https, so publish yours behind an HTTPS reverse proxy. A hosted control
              plane is on the roadmap; today you run the open-source CLI yourself.
            </p>
            <Button asChild variant="outline" size="sm" className="w-full gap-1.5">
              <Link href={connectHref}>
                Set up a buyer: allowlists + spending caps <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
