/**
 * Buyer-side configuration of the portfolio analyst, read from the environment.
 *
 * The analyst pays for market data with its OWN wallet, so the safety settings
 * (who it may pay, in which asset, on which network, and how much) are explicit
 * and required: without them it would sign whatever a (possibly hostile or
 * MITM'd) data gateway asks for. The env var names match `cascet connect`.
 *
 * Parsing never throws. A server with an invalid configuration still starts and
 * answers tools/list, but every analyze_portfolio call fails closed (nothing is
 * bought) until the operator fixes the environment.
 */

import { normalizeNetworks } from "@cascet/client";
import { MAX_PURCHASES } from "./analysis.js";
import { analysisBudget } from "./spend-ledger.js";

export const DEFAULT_DATA_GATEWAY_URL = "http://localhost:4402/mcp";
export const DEFAULT_NETWORK = "casper:casper-test";
/** Below the 60 s a CasCet gateway (and the MCP SDK) waits for an upstream tool by default. */
export const DEFAULT_TIMEOUT_MS = 45_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

export interface AnalystConfig {
  /** MCP endpoint of the paid data gateway the analyst buys from. */
  dataGatewayUrl: string;
  /** PEM key of the analyst's own wallet. */
  keyPath: string;
  keyAlgorithm: "ed25519" | "secp256k1";
  /** CAIP-2 networks the analyst may pay on. Never a wildcard. */
  networks: string[];
  /**
   * payTo allowlist: account hashes as "00" + 64 hex (contract-package payees are
   * refused). Undefined only with CASCET_ALLOW_ANY_SELLER=1.
   */
  allowedPayTo?: string[];
  /** Normalized asset allowlist ("hash-" + 64 hex). Undefined only with CASCET_ALLOW_ANY_SELLER=1. */
  allowedAssets?: string[];
  /** Max raw token units for one data purchase. Undefined only with CASCET_ALLOW_UNLIMITED_BUDGET=1. */
  maxPerCallRaw?: string;
  /** Max raw token units for all purchases of one analysis (per asset). Same opt-out as above. */
  maxSessionRaw?: string;
  /**
   * Max raw token units ALL analyses of this process may authorize together
   * (summed over assets), until restart. Same opt-out as above.
   */
  maxTotalRaw?: string;
  /** Deadline for the data purchases of one analysis. */
  timeoutMs: number;
}

export type ConfigResult =
  | { ok: true; config: AnalystConfig; warnings: string[] }
  | { ok: false; problems: string[]; warnings: string[] };

type Env = Readonly<Record<string, string | undefined>>;

export function loadAnalystConfig(env: Env): ConfigResult {
  const problems: string[] = [];
  const warnings: string[] = [];

  const keyPath = env.CASCET_KEY_PATH?.trim();
  if (!keyPath) problems.push("CASCET_KEY_PATH is not set (PEM key of the analyst's own wallet)");

  const algo = env.CASCET_KEY_ALGO?.trim().toLowerCase() || "ed25519";
  if (algo !== "ed25519" && algo !== "secp256k1") {
    problems.push(`CASCET_KEY_ALGO must be "ed25519" or "secp256k1", got "${algo}"`);
  }

  const dataGatewayUrl = env.DATA_GATEWAY_URL?.trim() || DEFAULT_DATA_GATEWAY_URL;
  const urlProblem = checkGatewayUrl(dataGatewayUrl, isFlagSet(env.CASCET_ALLOW_INSECURE_HTTP));
  if (urlProblem) problems.push(urlProblem);

  const networks = parseList(env.CASCET_NETWORK) ?? [DEFAULT_NETWORK];
  for (const network of networks) {
    const problem = checkNetwork(network);
    if (problem) problems.push(problem);
  }

  const allowedPayTo = parseNormalizedList(env.CASCET_ALLOWED_PAYTO, "CASCET_ALLOWED_PAYTO", normalizePayTo, problems);
  const allowedAssets = parseNormalizedList(env.CASCET_ALLOWED_ASSETS, "CASCET_ALLOWED_ASSETS", normalizeAssetHash, problems);
  const anySeller = isFlagSet(env.CASCET_ALLOW_ANY_SELLER);
  for (const [name, list] of [
    ["CASCET_ALLOWED_PAYTO", allowedPayTo],
    ["CASCET_ALLOWED_ASSETS", allowedAssets],
  ] as const) {
    if (list !== undefined) continue;
    if (anySeller) {
      warnings.push(`${name} is not set and CASCET_ALLOW_ANY_SELLER=1: the analyst will pay any seller the data gateway names`);
    } else {
      problems.push(`${name} is required: pin the data seller (or set CASCET_ALLOW_ANY_SELLER=1 to opt out)`);
    }
  }

  const maxPerCallRaw = parseRawAmount(env.CASCET_MAX_PER_CALL, "CASCET_MAX_PER_CALL", problems);
  const maxSessionRaw = parseRawAmount(env.CASCET_MAX_SESSION, "CASCET_MAX_SESSION", problems);
  const maxTotalRaw = parseRawAmount(env.CASCET_MAX_TOTAL, "CASCET_MAX_TOTAL", problems);
  const unlimited = isFlagSet(env.CASCET_ALLOW_UNLIMITED_BUDGET);
  for (const [name, value] of [
    ["CASCET_MAX_PER_CALL", env.CASCET_MAX_PER_CALL],
    ["CASCET_MAX_SESSION", env.CASCET_MAX_SESSION],
    ["CASCET_MAX_TOTAL", env.CASCET_MAX_TOTAL],
  ] as const) {
    if (value?.trim()) continue;
    if (unlimited) {
      warnings.push(`${name} is not set and CASCET_ALLOW_UNLIMITED_BUDGET=1: that spending cap is disabled`);
    } else {
      problems.push(`${name} is required (raw token units; or set CASCET_ALLOW_UNLIMITED_BUDGET=1 to opt out)`);
    }
  }
  if (maxTotalRaw !== undefined && !env.CASCET_MAX_PER_CALL?.trim() && !env.CASCET_MAX_SESSION?.trim()) {
    // Only reachable with CASCET_ALLOW_UNLIMITED_BUDGET=1: nothing would bound what ONE analysis may spend.
    problems.push("CASCET_MAX_TOTAL needs CASCET_MAX_PER_CALL or CASCET_MAX_SESSION, which bound what one analysis may spend");
  } else if (maxTotalRaw !== undefined) {
    const fullAnalysis = analysisBudget({ maxPerCallRaw, maxSessionRaw, allowedAssets }, MAX_PURCHASES).worstCaseRaw;
    if (fullAnalysis !== undefined && fullAnalysis > BigInt(maxTotalRaw)) {
      warnings.push(
        `CASCET_MAX_TOTAL (${maxTotalRaw}) is below what one full analysis may authorize (${fullAnalysis} raw): ` +
          "analyses of larger portfolios will be refused",
      );
    }
  }

  const timeoutMs = parseTimeout(env.CASCET_TIMEOUT_MS, problems);

  if (problems.length > 0 || !keyPath) return { ok: false, problems, warnings };
  return {
    ok: true,
    warnings,
    config: {
      dataGatewayUrl,
      keyPath,
      keyAlgorithm: algo === "secp256k1" ? "secp256k1" : "ed25519",
      networks,
      allowedPayTo,
      allowedAssets,
      maxPerCallRaw,
      maxSessionRaw,
      maxTotalRaw,
      timeoutMs,
    },
  };
}

/** One-line summary for the startup log (no secrets: the key path is not printed). */
export function describeConfig(cfg: AnalystConfig): string {
  const list = (l?: string[]) => (l ? `${l.length} pinned` : "ANY");
  return (
    `buying from ${cfg.dataGatewayUrl} on ${cfg.networks.join(",")}; ` +
    `payTo ${list(cfg.allowedPayTo)}, assets ${list(cfg.allowedAssets)}; ` +
    `caps per-call=${cfg.maxPerCallRaw ?? "∞"} per-analysis=${cfg.maxSessionRaw ?? "∞"} total=${cfg.maxTotalRaw ?? "∞"} raw; ` +
    `timeout ${cfg.timeoutMs} ms`
  );
}

const HINT_ACCOUNT_HASH = "run: npx @cascet/cli account-hash <public-key>";

/**
 * Validate a payTo allowlist entry and normalize it to "00" + 64 hex
 * ("00"+hex or "account-hash-"+hex). A public key ("01"+64 hex ed25519,
 * "02"+66 hex secp256k1) is NOT a payTo; it is rejected so the operator pins
 * the account hash instead. A contract package ("hash-"/"package-hash-"+hex)
 * is rejected too: the @make-software/casper-x402 1.0.0 facilitators settle
 * to account hashes only, so a payment to a package would be credited to an
 * account nobody controls (the same rule @cascet/client and the gateway apply).
 */
export function normalizePayTo(raw: string): { value: string } | { error: string } {
  const v = raw.trim().toLowerCase();
  const account = /^(?:00|account-hash-)([0-9a-f]{64})$/.exec(v)?.[1];
  if (account) return { value: `00${account}` };
  if (/^(?:hash|package-hash)-[0-9a-f]{64}$/.test(v)) {
    return {
      error:
        `"${short(raw)}" is a contract-package payee: casper-x402 1.0.0 facilitators can only settle to ` +
        `account hashes, so the payment would be credited to an account nobody controls. Allowlist the seller's account hash.`,
    };
  }
  if (/^01[0-9a-f]{64}$/.test(v) || /^02[0-9a-f]{66}$/.test(v)) {
    return { error: `"${short(raw)}" is a public key, not a payTo account hash (${HINT_ACCOUNT_HASH})` };
  }
  return {
    error:
      `"${short(raw)}" is not a payTo: use "00"+64 hex or account-hash-<64 hex> for an account ` +
      `(for a public key, ${HINT_ACCOUNT_HASH})`,
  };
}

/** Normalize a CEP-18 contract package hash to "hash-" + 64 lowercase hex. */
export function normalizeAssetHash(raw: string): { value: string } | { error: string } {
  const v = raw.trim().toLowerCase().replace(/^0x/, "");
  const hex = /^(?:hash-|package-hash-|contract-package-)?([0-9a-f]{64})$/.exec(v)?.[1];
  if (hex) return { value: `hash-${hex}` };
  return { error: `"${short(raw)}" is not a contract package hash (expected hash-<64 hex>)` };
}

function parseNormalizedList(
  raw: string | undefined,
  name: string,
  normalize: (entry: string) => { value: string } | { error: string },
  problems: string[],
): string[] | undefined {
  const entries = parseList(raw);
  if (!entries) return undefined;
  const out: string[] = [];
  for (const entry of entries) {
    const n = normalize(entry);
    if ("error" in n) problems.push(`${name}: ${n.error}`);
    else if (!out.includes(n.value)) out.push(n.value);
  }
  return out;
}

/** Comma-separated list; undefined when unset or blank. */
function parseList(raw: string | undefined): string[] | undefined {
  const items = raw
    ?.split(",")
    .map(s => s.trim())
    .filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}

function checkNetwork(network: string): string | undefined {
  if (network.includes("*")) {
    return `CASCET_NETWORK: wildcard "${short(network)}" is not allowed, list each network (e.g. ${DEFAULT_NETWORK})`;
  }
  if (!/^casper:[a-z0-9][a-z0-9-]{0,62}$/.test(network) || !isClientNetwork(network)) {
    return (
      `CASCET_NETWORK: "${short(network)}" is not a Casper CAIP-2 network id ` +
      '(e.g. casper:casper-test, casper:casper; at most 32 characters after "casper:")'
    );
  }
  return undefined;
}

/**
 * Whether @cascet/client takes `network`. The paying fetch validates its
 * networks again, with the CAIP-2 limit of 32 characters for the part after
 * "casper:": a network it refuses would fail every analysis as an internal
 * error, so it is reported here, at startup.
 */
function isClientNetwork(network: string): boolean {
  try {
    normalizeNetworks([network]);
    return true;
  } catch {
    return false;
  }
}

/** A remote data gateway over plain http:// can be MITM'd (forged data, swapped challenges). */
function checkGatewayUrl(raw: string, allowInsecure: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "DATA_GATEWAY_URL is not a valid URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "DATA_GATEWAY_URL must be an http(s) URL";
  }
  if (url.username || url.password) {
    return "DATA_GATEWAY_URL must not embed credentials";
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (url.protocol === "http:" && !loopback && !allowInsecure) {
    return (
      `DATA_GATEWAY_URL uses plain http:// to the remote host ${url.hostname}: use https:// ` +
      "(or set CASCET_ALLOW_INSECURE_HTTP=1 on a trusted private network)"
    );
  }
  return undefined;
}

/** Positive integer in raw token units, as a canonical decimal string. */
function parseRawAmount(raw: string | undefined, name: string, problems: string[]): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  if (!/^\d{1,40}$/.test(v) || BigInt(v) <= 0n) {
    problems.push(`${name} must be a positive integer in raw token units, got "${short(v)}"`);
    return undefined;
  }
  return BigInt(v).toString();
}

function parseTimeout(raw: string | undefined, problems: string[]): number {
  const v = raw?.trim();
  if (!v) return DEFAULT_TIMEOUT_MS;
  const n = /^\d{1,7}$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < MIN_TIMEOUT_MS || n > MAX_TIMEOUT_MS) {
    problems.push(`CASCET_TIMEOUT_MS must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}, got "${short(v)}"`);
    return DEFAULT_TIMEOUT_MS;
  }
  return n;
}

function isFlagSet(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true";
}

function short(s: string): string {
  return s.length > 24 ? `${s.slice(0, 12)}…${s.slice(-6)}` : s;
}
