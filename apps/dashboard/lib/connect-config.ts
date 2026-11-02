/**
 * Buyer-side `cascet connect` configuration generator for the /connect page:
 * env vars, a copy-paste shell command, an MCP client config (Claude Desktop /
 * Claude Code `mcpServers` shape) and the safety warnings. Pure, unit-tested.
 *
 * Env var names follow the CLI (packages/cli): CASCET_KEY_PATH, CASCET_KEY_ALGO,
 * CASCET_NETWORK, CASCET_ALLOWED_PAYTO, CASCET_ALLOWED_ASSETS,
 * CASCET_MAX_PER_CALL, CASCET_MAX_SESSION, CASCET_TOOL_PINS and the explicit
 * opt-outs CASCET_ALLOW_ANY_SELLER / CASCET_ALLOW_UNLIMITED_BUDGET.
 */

import type { KeyConversion, PayeeInput } from "./casper/keys";

export const CLI_PACKAGE = "@cascet/cli";
/**
 * The exact @cascet/cli release every command on this site runs: the first
 * one that enforces CASCET_NETWORK, the payee and token allowlists, the
 * budgets and tool pins, and has `account-hash` (SECURITY.md: 0.1.0 is
 * unsupported). Never "latest" or an open range: npm's latest is 0.1.0, which
 * silently ignores those settings, and an MCP host runs this command with the
 * wallet key at every start, so it must not float to whatever is published
 * next. Until this version is on npm, npx stops with ETARGET instead of
 * running 0.1.0. Raise it on purpose, together with README.md and SECURITY.md.
 */
export const CLI_VERSION = "0.1.1";
export const CLI_SPEC = `${CLI_PACKAGE}@${CLI_VERSION}`;

/**
 * `npx <spec> <args>` as a copy-paste shell line. The spec is shell-quoted, so
 * a range ("^", ">") can never act as a shell operator. `args` must already be
 * shell-safe (quote user input with `shellQuote`).
 */
export function cliCommand(args: string, spec: string = CLI_SPEC): string {
  return `npx ${shellQuote(spec)} ${args}`;
}

export const CONNECT_NETWORKS = {
  /** `cascetToken`: CasCet's x402 payment token (Cep18X402) on that network, as a hint for the asset allowlist. */
  testnet: { id: "casper:casper-test", label: "Casper Testnet", cascetToken: "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3" },
  mainnet: { id: "casper:casper", label: "Casper Mainnet", cascetToken: "8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41" },
} as const;
export type ConnectNetwork = keyof typeof CONNECT_NETWORKS;

export interface ConnectSettings {
  /** Validated gateway MCP URL (https, or http on loopback). */
  gatewayUrl: string;
  network: ConnectNetwork;
  keyPath: string;
  keyAlgorithm: "ed25519" | "secp256k1";
  /**
   * Seller account hashes in the form `cascet connect` takes: "00" + 64 hex. The CLI refuses a
   * contract package (hash-…) and a raw "01…" (a public key) in CASCET_ALLOWED_PAYTO, so
   * `sellerRow` never produces either.
   */
  allowedPayTo: string[];
  /** Bare 64-hex CEP-18 package hashes. */
  allowedAssets: string[];
  /** Raw token units, positive integer strings. */
  maxPerCallRaw: string | null;
  maxSessionRaw: string | null;
  /** Explicit, visible opt-outs; only emitted when the matching safety field is empty. */
  allowAnySeller: boolean;
  allowUnlimitedBudget: boolean;
  toolPinsPath: string | null;
  /** Key under `mcpServers`. */
  serverName: string;
}

/** One line of the seller allowlist textarea, resolved. */
export interface SellerRow {
  input: string;
  /** "00" + account hash, the only form CASCET_ALLOWED_PAYTO takes; null when the line is not usable. */
  value: string | null;
  note: "account" | "converted from public key" | null;
  /** Why the line is not usable (blocks the output). */
  error: string | null;
  /** A public key whose conversion has not finished yet. */
  pending: boolean;
  /** The key converter could not load; a retry can fix it. */
  retryable: boolean;
}

export const CONTRACT_SELLER_ERROR =
  "contract packages cannot be paid: cascet connect only allowlists account hashes (casper-x402 1.0.0 settles to account hashes); enter the seller's account hash";

/**
 * Resolve one seller line: an account hash is used as is ("00" + hash), a
 * public key once converted (`conversion`), and anything else is an error. A
 * contract package (hash-…, package-hash-…, contract-package-…) is an error
 * too: `cascet connect` refuses it in CASCET_ALLOWED_PAYTO, and no facilitator
 * can settle a payment to one.
 */
export function sellerRow(input: string, parsed: PayeeInput, conversion?: KeyConversion): SellerRow {
  const row = (r: Partial<SellerRow>): SellerRow => ({ input, value: null, note: null, error: null, pending: false, retryable: false, ...r });
  switch (parsed.kind) {
    case "account":
      return row({ value: `00${parsed.hash}`, note: "account" });
    case "package":
      return row({ error: CONTRACT_SELLER_ERROR });
    case "public-key":
      if (!conversion || "pending" in conversion) return row({ pending: true });
      if ("hash" in conversion) return row({ value: `00${conversion.hash}`, note: "converted from public key" });
      return row({ error: conversion.error, retryable: conversion.retryable });
    case "invalid":
      return row({ error: parsed.reason });
    case "empty":
      return row({ error: "empty" });
  }
}

/** The de-duplicated CASCET_ALLOWED_PAYTO list of the usable rows. */
export const allowedPayToOf = (rows: readonly SellerRow[]): string[] => [...new Set(rows.flatMap((r) => (r.value ? [r.value] : [])))];

export const needsSellerOverride = (s: Pick<ConnectSettings, "allowedPayTo" | "allowedAssets">): boolean =>
  s.allowedPayTo.length === 0 || s.allowedAssets.length === 0;

export const needsBudgetOverride = (s: Pick<ConnectSettings, "maxPerCallRaw" | "maxSessionRaw">): boolean =>
  !s.maxPerCallRaw || !s.maxSessionRaw;

/** Ordered env pairs for `cascet connect`. */
export function connectEnv(s: ConnectSettings): Array<[string, string]> {
  const env: Array<[string, string]> = [["CASCET_KEY_PATH", s.keyPath]];
  if (s.keyAlgorithm === "secp256k1") env.push(["CASCET_KEY_ALGO", "secp256k1"]);
  env.push(["CASCET_NETWORK", CONNECT_NETWORKS[s.network].id]);
  if (s.allowedPayTo.length) env.push(["CASCET_ALLOWED_PAYTO", s.allowedPayTo.join(",")]);
  if (s.allowedAssets.length) env.push(["CASCET_ALLOWED_ASSETS", s.allowedAssets.join(",")]);
  if (s.maxPerCallRaw) env.push(["CASCET_MAX_PER_CALL", s.maxPerCallRaw]);
  if (s.maxSessionRaw) env.push(["CASCET_MAX_SESSION", s.maxSessionRaw]);
  if (s.toolPinsPath) env.push(["CASCET_TOOL_PINS", s.toolPinsPath]);
  if (s.allowAnySeller && needsSellerOverride(s)) env.push(["CASCET_ALLOW_ANY_SELLER", "1"]);
  if (s.allowUnlimitedBudget && needsBudgetOverride(s)) env.push(["CASCET_ALLOW_UNLIMITED_BUDGET", "1"]);
  return env;
}

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX-shell quoting for copy-paste: safe words stay bare (a leading ~/ keeps its expansion), the rest is single-quoted. */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (SHELL_SAFE.test(value)) return value;
  if (value.startsWith("~/") && SHELL_SAFE.test(value.slice(2))) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildShellCommand(s: ConnectSettings): string {
  const lines = connectEnv(s).map(([k, v]) => `${k}=${shellQuote(v)} \\`);
  lines.push(cliCommand(`connect ${shellQuote(s.gatewayUrl)}`));
  return lines.join("\n");
}

export interface McpClientConfig {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}

/** `mcpServers` entry for Claude Desktop (claude_desktop_config.json) or Claude Code (.mcp.json). */
export function buildMcpConfig(s: ConnectSettings): McpClientConfig {
  return {
    mcpServers: {
      [sanitizeServerName(s.serverName)]: {
        command: "npx",
        // -y: an MCP host cannot answer npx's install prompt. CLI_SPEC is an exact version: the host
        // runs this with the wallet key at every start, so it never floats to a new release.
        args: ["-y", CLI_SPEC, "connect", s.gatewayUrl],
        env: Object.fromEntries(connectEnv(s)),
      },
    },
  };
}

export function sanitizeServerName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned || "cascet";
}

/**
 * What a /connect link may prefill (/build hands its seller, token and highest
 * price over this way). A link is untrusted input: the page shows which fields
 * it filled in until the user has looked at them. The network is never taken
 * from a link: the page always starts on testnet, and mainnet takes a click.
 */
export interface ConnectPrefill {
  gatewayUrl: string;
  sellers: string[];
  assets: string[];
  /** Only a valid 0-18 value; otherwise null and the page keeps its default. */
  decimals: string | null;
  perCall: string;
  session: string;
  /** The link asked for mainnet (ignored; the notice says so). */
  requestedMainnet: boolean;
  /** Names of the fields the link filled in, for the "verify before copying" notice. */
  applied: string[];
  /** The same fields as form keys, so the page knows when the user has touched one of them. */
  appliedFields: PrefillField[];
}

export type PrefillField = "gatewayUrl" | "sellers" | "assets" | "decimals" | "perCall" | "session";

const splitEntries = (v: string): string[] => [...new Set(v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];

export function readConnectPrefill(params: { get(name: string): string | null } | null): ConnectPrefill {
  const get = (k: string): string => params?.get(k)?.trim() ?? "";
  const gatewayUrl = get("gateway");
  const sellers = splitEntries(get("seller"));
  const assets = splitEntries(get("asset"));
  const decimals = /^\d{1,2}$/.test(get("decimals")) && Number(get("decimals")) <= 18 ? get("decimals") : null;
  const perCall = get("perCall");
  const session = get("session");
  const filled: Array<[PrefillField, string] | false> = [
    Boolean(gatewayUrl) && ["gatewayUrl", "gateway URL"],
    sellers.length > 0 && ["sellers", sellers.length > 1 ? "sellers" : "seller"],
    assets.length > 0 && ["assets", assets.length > 1 ? "tokens" : "token"],
    decimals !== null && ["decimals", "token decimals"],
    Boolean(perCall) && ["perCall", "per-call cap"],
    Boolean(session) && ["session", "session cap"],
  ];
  const applied = filled.filter((x): x is [PrefillField, string] => Boolean(x));
  return {
    gatewayUrl,
    sellers,
    assets,
    decimals,
    perCall,
    session,
    requestedMainnet: get("network") === "mainnet",
    applied: applied.map(([, label]) => label),
    appliedFields: applied.map(([field]) => field),
  };
}

export interface ConnectWarning {
  level: "danger" | "warning" | "info";
  field: "sellers" | "assets" | "budget" | "network" | "gateway" | "key";
  message: string;
}

export function connectWarnings(s: ConnectSettings, gatewayIsLocal = false): ConnectWarning[] {
  const out: ConnectWarning[] = [];
  if (s.allowedPayTo.length === 0) {
    out.push({
      level: "danger",
      field: "sellers",
      message: s.allowAnySeller
        ? "No seller allowlist: with CASCET_ALLOW_ANY_SELLER=1 the bridge signs a payment to whatever payTo a gateway (or a man-in-the-middle) puts in its 402 challenge."
        : "No seller allowlist: cascet connect refuses to start without CASCET_ALLOWED_PAYTO. Add the seller's account hash, or explicitly allow any seller.",
    });
  }
  if (s.allowedAssets.length === 0) {
    out.push({
      level: "danger",
      field: "assets",
      message: s.allowAnySeller
        ? "No asset allowlist: a hostile 402 can switch the payment to a more valuable token that also supports transfer_with_authorization."
        : "No asset allowlist: cascet connect refuses to start without CASCET_ALLOWED_ASSETS. Add the token's package hash, or explicitly allow any seller.",
    });
  }
  if (!s.maxPerCallRaw || !s.maxSessionRaw) {
    const missing = [!s.maxPerCallRaw && "per-call", !s.maxSessionRaw && "session"].filter(Boolean).join(" and ");
    out.push({
      level: "danger",
      field: "budget",
      message: s.allowUnlimitedBudget
        ? `No ${missing} cap: with CASCET_ALLOW_UNLIMITED_BUDGET=1 the bridge keeps paying until the key's balance is gone.`
        : `No ${missing} cap: cascet connect refuses to start without CASCET_MAX_PER_CALL and CASCET_MAX_SESSION. Set both, or explicitly allow an unlimited budget.`,
    });
  }
  if (s.maxPerCallRaw && s.maxSessionRaw && BigInt(s.maxPerCallRaw) > BigInt(s.maxSessionRaw)) {
    out.push({
      level: "warning",
      field: "budget",
      message: "The per-call cap is larger than the session cap; the session cap binds first.",
    });
  }
  // The CLI keeps one session budget per token, and once a token's budget is spent it pays in the next
  // token the gateway offers: the cap bounds the total only when a single token is allowlisted.
  if (s.maxSessionRaw && s.allowedAssets.length > 1) {
    const n = s.allowedAssets.length;
    out.push({
      level: "warning",
      field: "budget",
      message:
        `The session cap applies to each token on its own, as ${s.maxSessionRaw} raw units: with ${n} tokens allowlisted, one running ` +
        "bridge can pay up to that in every one of them in a session, and for a token with fewer decimals it is more whole tokens. " +
        "Allowlist one token to keep the total within the cap.",
    });
  } else if (s.maxSessionRaw && s.allowedAssets.length === 0 && s.allowAnySeller) {
    out.push({
      level: "warning",
      field: "budget",
      message: "The session cap applies to each token on its own, and without a token allowlist the bridge pays in any token: the cap bounds no total.",
    });
  }
  if (s.network === "mainnet") {
    out.push({
      level: "warning",
      field: "network",
      message: "Mainnet: every call spends real tokens from this key. Start with small caps and a key that holds only what you are willing to spend.",
    });
  }
  if (gatewayIsLocal) {
    out.push({
      level: "info",
      field: "gateway",
      message: "Local gateway: plain http is accepted on this machine only. A remote gateway must use https.",
    });
  }
  if (!isAbsolutePath(s.keyPath)) {
    out.push({
      level: "info",
      field: "key",
      message: "MCP clients start the bridge in their own working directory and do not expand ~, so use an absolute key path in the JSON config.",
    });
  }
  if (s.toolPinsPath && !isAbsolutePath(s.toolPinsPath) && !s.toolPinsPath.startsWith("~/")) {
    out.push({
      level: "info",
      field: "key",
      message:
        "The tool pin file path is relative, so it depends on the directory the MCP client starts the bridge in. Use an absolute path or ~/…, or leave it empty for the CLI default (~/.cascet/tool-pins.json).",
    });
  }
  return out;
}

const isAbsolutePath = (p: string): boolean => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);

export type AmountResult = { ok: true; raw: string } | { ok: false; error: string };

/** Whole tokens with decimals ("0.25") → raw integer units, exactly (BigInt, no floats). */
export function tokensToRaw(input: string, decimals: number): AmountResult {
  const s = input.trim();
  if (!s) return { ok: false, error: "required" };
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return { ok: false, error: "token decimals must be 0-18" };
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, error: "enter a positive number such as 0.5" };
  const [int = "0", frac = ""] = s.split(".");
  if (frac.length > decimals) return { ok: false, error: `this token has ${decimals} decimals; use at most ${decimals} digits after the point` };
  const raw = BigInt(int + frac.padEnd(decimals, "0"));
  if (raw <= 0n) return { ok: false, error: "must be greater than zero" };
  const str = raw.toString();
  if (str.length > 40) return { ok: false, error: "too large" };
  return { ok: true, raw: str };
}

/** Raw integer units → exact decimal token string ("250000000", 9 → "0.25"). */
export function rawToTokens(raw: bigint | string, decimals: number): string {
  const v = typeof raw === "bigint" ? raw : /^\d+$/.test(raw) ? BigInt(raw) : 0n;
  if (decimals <= 0) return v.toString();
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${v / base}.${frac}` : (v / base).toString();
}
