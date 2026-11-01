"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { CircleAlert, Info, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { CopyButton } from "@/components/copy-button";
import { SessionSpend } from "@/components/connect/session-spend";
import { checkGatewayUrl, parseAssetInput, parsePayeeInput, payToValue } from "@/lib/casper/keys";
import {
  buildMcpConfig,
  buildShellCommand,
  CONNECT_NETWORKS,
  connectWarnings,
  needsBudgetOverride,
  needsSellerOverride,
  tokensToRaw,
  type ConnectNetwork,
  type ConnectSettings,
  type ConnectWarning,
} from "@/lib/connect-config";
import { useAccountHashes } from "@/lib/use-account-hashes";
import { cn, shortHex } from "@/lib/utils";

interface FormState {
  gatewayUrl: string;
  network: ConnectNetwork;
  keyPath: string;
  keyAlgorithm: "ed25519" | "secp256k1";
  sellers: string;
  assets: string;
  decimals: string;
  perCall: string;
  session: string;
  toolPins: string;
  serverName: string;
  allowAnySeller: boolean;
  allowUnlimitedBudget: boolean;
}

const splitList = (s: string): string[] => [...new Set(s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];

function initialState(params: URLSearchParams | null): FormState {
  const get = (k: string) => params?.get(k)?.trim() ?? "";
  const network = get("network") === "mainnet" ? "mainnet" : "testnet";
  const decimals = /^\d{1,2}$/.test(get("decimals")) ? get("decimals") : "9";
  return {
    gatewayUrl: get("gateway"),
    network,
    keyPath: "",
    keyAlgorithm: "ed25519",
    sellers: splitList(get("seller")).join("\n"),
    assets: splitList(get("asset")).join("\n"),
    decimals,
    perCall: get("perCall"),
    session: get("session"),
    toolPins: "",
    serverName: "cascet",
    allowAnySeller: false,
    allowUnlimitedBudget: false,
  };
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs leading-snug text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

const WARNING_STYLE: Record<ConnectWarning["level"], { variant: "destructive" | "warning" | "default"; Icon: typeof CircleAlert }> = {
  danger: { variant: "destructive", Icon: ShieldAlert },
  warning: { variant: "warning", Icon: TriangleAlert },
  info: { variant: "default", Icon: Info },
};

/**
 * /connect: build a `cascet connect` setup with seller + asset allowlists and
 * spending caps, as a shell command and as an MCP client config. Everything
 * runs in the browser; nothing is sent anywhere.
 */
export function ConnectBuilder() {
  const params = useSearchParams();
  const [s, setS] = React.useState<FormState>(() => initialState(params));
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setS((p) => ({ ...p, [k]: v }));

  // ── gateway ──
  const gateway = s.gatewayUrl.trim() ? checkGatewayUrl(s.gatewayUrl) : null;
  const gatewayError = !s.gatewayUrl.trim() ? "required" : gateway && !gateway.ok ? gateway.error : null;

  // ── sellers (public keys are converted to account hashes in the browser) ──
  const sellerEntries = React.useMemo(() => splitList(s.sellers).map((input) => ({ input, parsed: parsePayeeInput(input) })), [s.sellers]);
  const sellerKeys = React.useMemo(
    () => sellerEntries.flatMap((e) => (e.parsed.kind === "public-key" ? [e.parsed.publicKey] : [])),
    [sellerEntries],
  );
  const converted = useAccountHashes(sellerKeys);
  const sellerRows = sellerEntries.map(({ input, parsed }) => {
    if (parsed.kind === "account" || parsed.kind === "package") {
      return { input, value: payToValue(parsed), note: parsed.kind === "package" ? "contract package (cannot settle yet)" : "account", error: null };
    }
    if (parsed.kind === "public-key") {
      const c = converted.get(parsed.publicKey);
      if (c && "hash" in c) return { input, value: `00${c.hash}`, note: "converted from public key", error: null };
      return { input, value: null, note: null, error: c && "error" in c ? c.error : "converting…" };
    }
    return { input, value: null, note: null, error: parsed.kind === "invalid" ? parsed.reason : "empty" };
  });
  const sellersError = sellerRows.find((r) => r.error && r.error !== "converting…")?.error ?? null;
  const sellersPending = sellerRows.some((r) => r.error === "converting…");
  const allowedPayTo = [...new Set(sellerRows.flatMap((r) => (r.value ? [r.value] : [])))];

  // ── assets ──
  const assetRows = splitList(s.assets).map((input) => ({ input, parsed: parseAssetInput(input) }));
  const assetsError = assetRows.find((r) => !r.parsed.ok)?.parsed;
  const allowedAssets = [...new Set(assetRows.flatMap((r) => (r.parsed.ok ? [r.parsed.hash] : [])))];

  // ── budget ──
  const decimalsOk = /^\d{1,2}$/.test(s.decimals) && Number(s.decimals) <= 18;
  const decimals = decimalsOk ? Number(s.decimals) : 9;
  const perCall = s.perCall.trim() ? tokensToRaw(s.perCall, decimals) : null;
  const session = s.session.trim() ? tokensToRaw(s.session, decimals) : null;

  const keyError = !s.keyPath.trim() ? "required" : /[\r\n]/.test(s.keyPath) ? "one line only" : null;
  const blocking = [
    gatewayError && "gateway URL",
    keyError && "key path",
    sellersError && "sellers",
    sellersPending && "sellers (converting)",
    assetsError && "assets",
    !decimalsOk && "decimals",
    perCall && !perCall.ok && "per-call cap",
    session && !session.ok && "session cap",
  ].filter(Boolean) as string[];

  const settings: ConnectSettings | null =
    blocking.length === 0 && gateway?.ok
      ? {
          gatewayUrl: gateway.url,
          network: s.network,
          keyPath: s.keyPath.trim(),
          keyAlgorithm: s.keyAlgorithm,
          allowedPayTo,
          allowedAssets,
          maxPerCallRaw: perCall?.ok ? perCall.raw : null,
          maxSessionRaw: session?.ok ? session.raw : null,
          allowAnySeller: s.allowAnySeller,
          allowUnlimitedBudget: s.allowUnlimitedBudget,
          toolPinsPath: s.toolPins.trim() || null,
          serverName: s.serverName,
        }
      : null;
  const shell = settings ? buildShellCommand(settings) : "";
  const mcpJson = settings ? JSON.stringify(buildMcpConfig(settings), null, 2) : "";
  const warnings = settings ? connectWarnings(settings, gateway?.ok ? gateway.local : false) : [];

  const sellerOverrideNeeded = needsSellerOverride({ allowedPayTo, allowedAssets });
  const budgetOverrideNeeded = needsBudgetOverride({
    maxPerCallRaw: perCall?.ok ? perCall.raw : null,
    maxSessionRaw: session?.ok ? session.raw : null,
  });

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
      {/* ── inputs ── */}
      <div className="min-w-0 space-y-5">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Gateway</CardTitle>
            <CardDescription>The paid MCP endpoint your agent will call, and the network it settles on.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field
              id="gateway"
              label="Gateway MCP URL"
              hint="https://… for a remote gateway; plain http is only accepted for localhost."
              error={s.gatewayUrl.trim() ? gatewayError : null}
            >
              <Input
                id="gateway"
                value={s.gatewayUrl}
                onChange={(e) => set("gatewayUrl", e.target.value)}
                placeholder="https://gateway.example.com/mcp"
                inputMode="url"
                spellCheck={false}
                aria-invalid={Boolean(s.gatewayUrl.trim() && gatewayError)}
                aria-describedby={s.gatewayUrl.trim() && gatewayError ? "gateway-error" : undefined}
              />
            </Field>
            <div className="space-y-1.5">
              <Label id="network-label">Network</Label>
              <Tabs value={s.network} onValueChange={(v) => set("network", v as ConnectNetwork)}>
                <TabsList aria-labelledby="network-label">
                  <TabsTrigger value="testnet">{CONNECT_NETWORKS.testnet.label}</TabsTrigger>
                  <TabsTrigger value="mainnet">{CONNECT_NETWORKS.mainnet.label}</TabsTrigger>
                </TabsList>
                <TabsContent value="testnet" className="text-xs text-muted-foreground">
                  CASCET_NETWORK=<code>{CONNECT_NETWORKS.testnet.id}</code>. The bridge refuses a 402 challenge for any other network.
                </TabsContent>
                <TabsContent value="mainnet" className="text-xs text-muted-foreground">
                  CASCET_NETWORK=<code>{CONNECT_NETWORKS.mainnet.id}</code>. Real funds: the key pays with real tokens.
                </TabsContent>
              </Tabs>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Agent key</CardTitle>
            <CardDescription>The PEM key that signs payments. It never leaves your machine; this page only writes its path.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field
              id="key-path"
              label="Key file path"
              hint="Use an absolute path: MCP clients do not expand ~."
              error={s.keyPath && keyError ? keyError : null}
            >
              <Input
                id="key-path"
                value={s.keyPath}
                onChange={(e) => set("keyPath", e.target.value)}
                placeholder="/home/you/.cascet/agent.pem"
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-xs"
                aria-invalid={Boolean(s.keyPath && keyError)}
              />
            </Field>
            <div className="space-y-1.5">
              <Label id="algo-label">Key algorithm</Label>
              <Tabs value={s.keyAlgorithm} onValueChange={(v) => set("keyAlgorithm", v as FormState["keyAlgorithm"])}>
                <TabsList aria-labelledby="algo-label">
                  <TabsTrigger value="ed25519">ed25519</TabsTrigger>
                  <TabsTrigger value="secp256k1">secp256k1</TabsTrigger>
                </TabsList>
                <TabsContent value="ed25519" className="text-xs text-muted-foreground">
                  Public keys starting with 01. The CLI default.
                </TabsContent>
                <TabsContent value="secp256k1" className="text-xs text-muted-foreground">
                  Public keys starting with 02; adds CASCET_KEY_ALGO=secp256k1.
                </TabsContent>
              </Tabs>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Who you pay</CardTitle>
            <CardDescription>
              The bridge refuses to sign a payment to any other seller or in any other token, even if a gateway asks for it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field
              id="sellers"
              label="Allowed sellers (payTo)"
              hint={
                <>
                  One per line: an account hash (<code>00…</code> or <code>account-hash-…</code>) or a seller&apos;s public key (
                  <code>01…</code>/<code>02…</code>, converted here). Get a seller&apos;s value with{" "}
                  <code>npx @cascet/cli account-hash &lt;public-key&gt;</code>.
                </>
              }
              error={sellersError}
            >
              <Textarea
                id="sellers"
                value={s.sellers}
                onChange={(e) => set("sellers", e.target.value)}
                placeholder="00881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36"
                spellCheck={false}
                className="font-mono text-xs"
                aria-invalid={Boolean(sellersError)}
              />
            </Field>
            {sellerRows.length > 0 && (
              <ul className="space-y-1.5" aria-label="Allowlist entries">
                {sellerRows.map((r) => (
                  <li key={r.input} className="flex flex-wrap items-center gap-2 text-xs">
                    {r.value ? (
                      <>
                        <Badge variant="success" className="font-mono" title={r.value}>
                          {shortHex(r.value, 10, 6)}
                        </Badge>
                        <span className="text-muted-foreground">{r.note}</span>
                        {r.note === "converted from public key" && (
                          <span className="font-mono text-muted-foreground" title={r.input}>
                            from {shortHex(r.input, 8, 4)}
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        <Badge variant={r.error === "converting…" ? "secondary" : "destructive"} className="font-mono" title={r.input}>
                          {shortHex(r.input, 10, 6)}
                        </Badge>
                        <span className={r.error === "converting…" ? "text-muted-foreground" : "text-destructive"}>{r.error}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Field
              id="assets"
              label="Allowed tokens (asset package hashes)"
              hint={
                <>
                  One per line, <code>hash-…</code> or 64 hex. On testnet, CasCet&apos;s x402 token is{" "}
                  <code className="break-all">cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3</code>.
                </>
              }
              error={assetsError && !assetsError.ok ? `${assetRows.find((r) => !r.parsed.ok)?.input}: ${assetsError.reason}` : null}
            >
              <Textarea
                id="assets"
                value={s.assets}
                onChange={(e) => set("assets", e.target.value)}
                placeholder="hash-…"
                spellCheck={false}
                className="min-h-[60px] font-mono text-xs"
                aria-invalid={Boolean(assetsError)}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Spending caps</CardTitle>
            <CardDescription>
              Enter whole tokens; the CLI takes raw units, converted here exactly. The per-call cap rejects any single price above
              it; the session cap bounds everything one running bridge pays.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field id="decimals" label="Token decimals" hint="9 for CasCet's x402 token" error={decimalsOk ? null : "0 to 18"}>
              <Input id="decimals" value={s.decimals} onChange={(e) => set("decimals", e.target.value)} inputMode="numeric" aria-invalid={!decimalsOk} />
            </Field>
            <Field
              id="per-call"
              label="Per-call cap (tokens)"
              hint={perCall?.ok ? `= ${perCall.raw} raw units` : "e.g. 0.5"}
              error={perCall && !perCall.ok ? perCall.error : null}
            >
              <Input id="per-call" value={s.perCall} onChange={(e) => set("perCall", e.target.value)} inputMode="decimal" placeholder="0.5" aria-invalid={Boolean(perCall && !perCall.ok)} />
            </Field>
            <Field
              id="session"
              label="Session cap (tokens)"
              hint={session?.ok ? `= ${session.raw} raw units` : "e.g. 5"}
              error={session && !session.ok ? session.error : null}
            >
              <Input id="session" value={s.session} onChange={(e) => set("session", e.target.value)} inputMode="decimal" placeholder="5" aria-invalid={Boolean(session && !session.ok)} />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Advanced</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="server-name" label="Name in your MCP client" hint="the key under mcpServers">
                <Input id="server-name" value={s.serverName} onChange={(e) => set("serverName", e.target.value)} />
              </Field>
              <Field
                id="tool-pins"
                label="Tool pin file (optional)"
                hint="CASCET_TOOL_PINS; default ~/.cascet/tool-pins.json. A tool whose definition changes is refused until you accept it (--accept-tool-changes)."
              >
                <Input id="tool-pins" value={s.toolPins} onChange={(e) => set("toolPins", e.target.value)} placeholder="~/.cascet/tool-pins.json" spellCheck={false} />
              </Field>
            </div>
            <Separator />
            <div className="space-y-3">
              <p className="text-sm font-medium">Explicit opt-outs</p>
              <p className="text-xs text-muted-foreground">
                cascet connect refuses to start without allowlists and caps. Only if you really mean it, opt out here; the opt-out is
                written into the command so it stays visible.
              </p>
              <OptOut
                pressed={s.allowAnySeller}
                needed={sellerOverrideNeeded}
                onToggle={() => set("allowAnySeller", !s.allowAnySeller)}
                label="Allow any seller and token"
                envVar="CASCET_ALLOW_ANY_SELLER=1"
              />
              <OptOut
                pressed={s.allowUnlimitedBudget}
                needed={budgetOverrideNeeded}
                onToggle={() => set("allowUnlimitedBudget", !s.allowUnlimitedBudget)}
                label="Allow an unlimited budget"
                envVar="CASCET_ALLOW_UNLIMITED_BUDGET=1"
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── outputs ── */}
      <div className="min-w-0 space-y-4 lg:sticky lg:top-20 lg:self-start">
        {!settings ? (
          <Alert role="status">
            <Info />
            <AlertTitle>Fill in the form to generate your setup</AlertTitle>
            <AlertDescription>
              {blocking.length > 0 ? `Still needed: ${blocking.join(", ")}.` : "Enter the gateway URL."}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {warnings.length === 0 ? (
              <Alert variant="success" role="status">
                <ShieldCheck />
                <AlertTitle>Allowlists and caps are set</AlertTitle>
                <AlertDescription>The bridge only pays these sellers, in these tokens, within these caps.</AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-2" aria-live="polite">
                {warnings.map((w, i) => {
                  const { variant, Icon } = WARNING_STYLE[w.level];
                  return (
                    <Alert key={i} variant={variant} role="status">
                      <Icon />
                      <AlertDescription>{w.message}</AlertDescription>
                    </Alert>
                  );
                })}
              </div>
            )}

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Your setup</CardTitle>
                <CardDescription>Copy one of the two forms. Generated in your browser; nothing is sent anywhere.</CardDescription>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue="shell">
                  <TabsList aria-label="Output format">
                    <TabsTrigger value="shell">Shell</TabsTrigger>
                    <TabsTrigger value="mcp">MCP client JSON</TabsTrigger>
                  </TabsList>
                  <TabsContent value="shell" className="space-y-2">
                    <CodeOutput text={shell} label="shell command" />
                    <p className="text-xs text-muted-foreground">Runs the stdio bridge in a terminal, for testing or for any MCP host.</p>
                  </TabsContent>
                  <TabsContent value="mcp" className="space-y-2">
                    <CodeOutput text={mcpJson} label="MCP client config" />
                    <p className="text-xs text-muted-foreground">
                      Claude Desktop: merge into <code>claude_desktop_config.json</code>. Claude Code: save as <code>.mcp.json</code> in
                      your project. Other MCP hosts use the same <code>mcpServers</code> shape.
                    </p>
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </>
        )}

        <SessionSpend
          network={s.network}
          decimals={decimals}
          sessionCapRaw={session?.ok ? session.raw : null}
          allowedAssets={allowedAssets}
        />
      </div>
    </div>
  );
}

function OptOut({
  pressed,
  needed,
  onToggle,
  label,
  envVar,
}: {
  pressed: boolean;
  needed: boolean;
  onToggle: () => void;
  label: string;
  envVar: string;
}) {
  const active = pressed && needed;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
      <div className="min-w-0 text-xs">
        <div className="font-medium">{label}</div>
        <code className="text-muted-foreground">{envVar}</code>
        {!needed && <span className="ml-2 text-muted-foreground">not needed, the fields are filled in</span>}
      </div>
      <Button
        type="button"
        size="sm"
        variant={active ? "default" : "outline"}
        aria-pressed={active}
        disabled={!needed}
        onClick={onToggle}
        className={cn(active && "bg-destructive text-destructive-foreground hover:bg-destructive/90")}
      >
        {active ? "Opted out" : "Opt out"}
      </Button>
    </div>
  );
}

function CodeOutput({ text, label }: { text: string; label: string }) {
  return (
    <div className="relative">
      <div className="absolute right-2 top-2">
        <CopyButton text={text} />
      </div>
      <pre aria-label={label} className="max-h-[24rem] overflow-auto rounded-lg border bg-background/50 p-3 pr-12 font-mono text-[11.5px] leading-relaxed">
        {text}
      </pre>
    </div>
  );
}

