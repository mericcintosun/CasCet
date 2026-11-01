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

export const CLI_PACKAGE = "@cascet/cli";
/**
 * Version the generated commands run. "latest" until the release that carries
 * the buyer-side allowlist and budget enforcement is published; the release
 * step pins it to that exact version (0.1.0 on npm predates those checks).
 */
export const CLI_VERSION = "latest";
export const CLI_SPEC = `${CLI_PACKAGE}@${CLI_VERSION}`;

export const CONNECT_NETWORKS = {
  testnet: { id: "casper:casper-test", label: "Casper Testnet" },
  mainnet: { id: "casper:casper", label: "Casper Mainnet" },
} as const;
export type ConnectNetwork = keyof typeof CONNECT_NETWORKS;

export interface ConnectSettings {
  /** Validated gateway MCP URL (https, or http on loopback). */
  gatewayUrl: string;
  network: ConnectNetwork;
  keyPath: string;
  keyAlgorithm: "ed25519" | "secp256k1";
  /** Serialized payee keys as the 402 challenge carries them: "00"+hash (account) or "01"+hash (contract package). */
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
  lines.push(`npx ${CLI_SPEC} connect ${shellQuote(s.gatewayUrl)}`);
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
        // -y: an MCP host cannot answer npx's install prompt.
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
  if (s.toolPinsPath && !isAbsolutePath(s.toolPinsPath)) {
    out.push({
      level: "info",
      field: "key",
      message: "The tool pin file path is not absolute; in the JSON config ~ is not expanded. Use an absolute path, or leave it empty for the CLI default.",
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
