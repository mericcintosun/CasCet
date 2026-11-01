import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { NETWORK_CASPER_MAINNET, NETWORK_CASPER_TESTNET } from "@cascet/core";
import {
  DEFAULT_TIMEOUT_MS,
  normalizeAllowedPayTo,
  normalizeAssetHash,
  normalizeNetworks,
  parseRawAmount,
  type BridgeOptions,
  type PayingFetchOptions,
} from "@cascet/client";
import { CliError } from "./args.js";

/** Everything `cascet connect` needs, resolved and validated from env vars and flags. */
export interface ConnectConfig {
  url: string;
  paying: Omit<PayingFetchOptions, "onPayment" | "logger">;
  bridge: BridgeOptions & { timeoutMs: number; toolPins: { path: string; acceptChanges: boolean } };
  /** Warnings and notices to print before the bridge starts. */
  notices: string[];
  /** One-line startup summary. */
  summary: string;
}

export interface ConnectInputs {
  url: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
  flags: ReadonlySet<string>;
  cwd: string;
  home: string;
  /** File existence check, for tests. */
  exists?: (path: string) => boolean;
}

export const CONNECT_USAGE =
  "usage: cascet connect <gateway-mcp-url> [--allow-any-seller] [--allow-unlimited-budget] [--accept-tool-changes]";

/**
 * Resolve `cascet connect` settings. Spending controls are mandatory: the payee
 * and token allowlists unless --allow-any-seller (CASCET_ALLOW_ANY_SELLER=1),
 * and the per-call and session budgets unless --allow-unlimited-budget
 * (CASCET_ALLOW_UNLIMITED_BUDGET=1). Every value is validated here, so a typo
 * fails at startup instead of being ignored.
 */
export function resolveConnectConfig(input: ConnectInputs): ConnectConfig {
  const { env, flags } = input;
  const exists = input.exists ?? existsSync;
  if (!input.url) throw new CliError(CONNECT_USAGE);
  const url = checkGatewayUrl(input.url);

  const rawKeyPath = value(env.CASCET_KEY_PATH);
  if (!rawKeyPath) throw new CliError("CASCET_KEY_PATH (path to the buyer wallet's PEM private key) is required");
  // MCP hosts start the bridge from an unpredictable working directory, so show the resolved path.
  const keyPath = isAbsolute(rawKeyPath) ? rawKeyPath : resolve(input.cwd, rawKeyPath);
  if (!exists(keyPath)) throw new CliError(`CASCET_KEY_PATH: no file at ${keyPath} (use an absolute path in MCP host configs)`);

  const keyAlgorithm = value(env.CASCET_KEY_ALGO) ?? "ed25519";
  if (keyAlgorithm !== "ed25519" && keyAlgorithm !== "secp256k1") {
    throw new CliError(`CASCET_KEY_ALGO must be "ed25519" or "secp256k1"; got "${keyAlgorithm}"`);
  }

  const networks = attribute("CASCET_NETWORK", () => normalizeNetworks(list(env.CASCET_NETWORK) ?? [NETWORK_CASPER_TESTNET]));

  const allowAnySeller = flags.has("--allow-any-seller") || isSet(env.CASCET_ALLOW_ANY_SELLER);
  const allowedPayTo = list(env.CASCET_ALLOWED_PAYTO);
  const allowedAssets = list(env.CASCET_ALLOWED_ASSETS);
  const missingAllowlists = [
    allowedPayTo ? undefined : "CASCET_ALLOWED_PAYTO",
    allowedAssets ? undefined : "CASCET_ALLOWED_ASSETS",
  ].filter((name): name is string => name !== undefined);
  if (missingAllowlists.length > 0 && !allowAnySeller) {
    throw new CliError(
      `${missingAllowlists.join(" and ")} ${missingAllowlists.length > 1 ? "are" : "is"} required: list the payTo account ` +
        "hash(es) and the token package hash(es) you intend to pay, comma-separated (get a seller's payTo with " +
        '"npx @cascet/cli account-hash <public-key>"). To pay any seller anyway, pass --allow-any-seller or set CASCET_ALLOW_ANY_SELLER=1.',
    );
  }
  // A contract-package payee is refused too: no facilitator can settle one today (CONTRACT_PAYEE_REASON).
  for (const payTo of allowedPayTo ?? []) attribute("CASCET_ALLOWED_PAYTO", () => normalizeAllowedPayTo(payTo));
  for (const asset of allowedAssets ?? []) attribute("CASCET_ALLOWED_ASSETS", () => normalizeAssetHash(asset));

  const allowUnlimited = flags.has("--allow-unlimited-budget") || isSet(env.CASCET_ALLOW_UNLIMITED_BUDGET);
  const maxPerCallRaw = value(env.CASCET_MAX_PER_CALL);
  const maxSessionRaw = value(env.CASCET_MAX_SESSION);
  const missingBudgets = [
    maxPerCallRaw ? undefined : "CASCET_MAX_PER_CALL",
    maxSessionRaw ? undefined : "CASCET_MAX_SESSION",
  ].filter((name): name is string => name !== undefined);
  if (missingBudgets.length > 0 && !allowUnlimited) {
    throw new CliError(
      `${missingBudgets.join(" and ")} ${missingBudgets.length > 1 ? "are" : "is"} required: set the largest single payment ` +
        "and the session total per token, in raw token units (e.g. 1000000000 = 1 token with 9 decimals). " +
        "To run without limits anyway, pass --allow-unlimited-budget or set CASCET_ALLOW_UNLIMITED_BUDGET=1.",
    );
  }
  if (maxPerCallRaw !== undefined) parseRawAmount(maxPerCallRaw, "CASCET_MAX_PER_CALL");
  if (maxSessionRaw !== undefined) parseRawAmount(maxSessionRaw, "CASCET_MAX_SESSION");

  const timeoutMs = parseTimeout(env.CASCET_TIMEOUT_MS);
  const acceptChanges = flags.has("--accept-tool-changes");
  const pinsSetting = value(env.CASCET_TOOL_PINS);
  const pinsPath = pinsSetting ? expandPath(pinsSetting, input.cwd, input.home) : join(input.home, ".cascet", "tool-pins.json");

  const notices: string[] = [];
  if (networks.includes(NETWORK_CASPER_MAINNET)) {
    notices.push("[cascet] MAINNET payments enabled (casper:casper): these are real funds.");
  }
  if (allowAnySeller && missingAllowlists.length > 0) {
    notices.push(
      `[cascet] WARNING: --allow-any-seller: ${missingAllowlists.join(" and ")} not set, so this bridge pays any ` +
        "payee and/or token the gateway names. A hostile or MITM'd gateway can redirect your payments.",
    );
  }
  if (allowUnlimited && missingBudgets.length > 0) {
    notices.push(
      `[cascet] WARNING: --allow-unlimited-budget: ${missingBudgets.join(" and ")} not set, so the agent can spend ` +
        "without that limit.",
    );
  }
  if (acceptChanges) {
    notices.push(
      "[cascet] NOTICE: --accept-tool-changes: changed or new tool definitions will be trusted and re-pinned in this " +
        "run. Review them in this log, then remove the flag.",
    );
  }

  const paying: ConnectConfig["paying"] = {
    privateKeyPath: keyPath,
    keyAlgorithm,
    networks,
    ...(allowedPayTo ? { allowedPayTo } : {}),
    ...(allowedAssets ? { allowedAssets } : {}),
    budget: {
      ...(maxPerCallRaw !== undefined ? { maxPerCallRaw } : {}),
      ...(maxSessionRaw !== undefined ? { maxSessionRaw } : {}),
    },
    timeoutMs,
  };
  const summary =
    `[cascet] bridge up → ${url} | key ${keyPath} | networks ${networks.join(", ")} | ` +
    `payTo ${allowedPayTo ? `${allowedPayTo.length} allowlisted` : "ANY"} | assets ${allowedAssets ? `${allowedAssets.length} allowlisted` : "ANY"} | ` +
    `budget per-call=${maxPerCallRaw ?? "unlimited"}, session=${maxSessionRaw ?? "unlimited"} (per asset) | ` +
    `timeout ${timeoutMs} ms | tool pins ${pinsPath}${acceptChanges ? " (accepting changes)" : ""}`;

  return { url, paying, bridge: { timeoutMs, toolPins: { path: pinsPath, acceptChanges } }, notices, summary };
}

/**
 * A remote gateway over plain http:// can be MITM'd to inject a 402 that
 * redirects the payment, so TLS is required off loopback.
 */
export function checkGatewayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`invalid gateway URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CliError(`unsupported gateway URL scheme ${url.protocol} (use https://)`);
  }
  // URL.hostname keeps the brackets of an IPv6 literal ("[::1]").
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const loopback = host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  if (url.protocol === "http:" && !loopback) {
    throw new CliError(`refusing insecure http:// to remote host ${url.hostname}: use https:// (a MITM could redirect your payment)`);
  }
  return url.href;
}

function attribute<T>(name: string, run: () => T): T {
  try {
    return run();
  } catch (err) {
    throw new CliError(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseTimeout(raw: string | undefined): number {
  const text = value(raw);
  if (text === undefined) return DEFAULT_TIMEOUT_MS;
  const ms = /^[0-9]{1,10}$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 2_147_483_647) {
    throw new CliError(`CASCET_TIMEOUT_MS must be a whole number of milliseconds (e.g. 30000); got "${text}"`);
  }
  return ms;
}

function expandPath(path: string, cwd: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function list(raw: string | undefined): string[] | undefined {
  const items = raw
    ?.split(",")
    .map(item => item.trim())
    .filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}

function value(raw: string | undefined): string | undefined {
  const text = raw?.trim();
  return text ? text : undefined;
}

function isSet(raw: string | undefined): boolean {
  return ["1", "true", "yes"].includes(raw?.trim().toLowerCase() ?? "");
}
