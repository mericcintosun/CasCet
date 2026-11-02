import { resolve } from "node:path";
import { DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE, isAuthorizationStyle, type AuthorizationStyle } from "@cascet/core";
import {
  checkDomainString,
  checkPaymentMotes,
  LANE5_MAX_PAYMENT_MOTES,
  planAssets,
  type FacilitatorAssetOptions,
} from "./facilitator-assets.js";
import { DEFAULT_PREFLIGHT_DEADLINE_MS, knownAuthorizationStyle, normalizeAsset, normalizePayTo } from "./facilitator-core.js";
import { normalizeAccountHash } from "./facilitator-roles.js";
import type { RealFacilitatorOptions } from "./real-facilitator.js";

/**
 * Environment configuration of the self-hosted facilitator (and of the
 * real-settlement demos that start one).
 *
 *   CASCET_NETWORK                casper:casper | casper:casper-test (or legacy CASCET_NET=mainnet|testnet)
 *   CASCET_FACILITATOR_KEY        PEM of the fee payer (REQUIRED on mainnet; testnet falls back to the deployer key)
 *   CASCET_FACILITATOR_KEY_ALGO   ed25519 (default) | secp256k1
 *   CASCET_FACILITATOR_TOKEN      shared bearer token, gateway `facilitator.apiKey` (REQUIRED on mainnet, ≥ 32 chars)
 *   CASCET_SELLER_ACCOUNT_HASH    comma list of payTo account hashes the facilitator settles to
 *   CASCET_OWNER_ACCOUNT_HASH     comma list of owner accounts (e.g. a new ReceiptRegistry owner); on mainnet the
 *                                 CasCet deployer is always added. Start is refused on mainnet if the fee payer is
 *                                 one of them or one of their associated keys
 *   CASCET_ALLOWED_ASSETS         comma list of CEP-18 package hashes (default: the CasCet x402 token). Each is
 *                                 settled in the authorization style its on-chain ABI shows: `amount`
 *                                 (legacy-amount, CasCet's token) or `value` (cep3009-value, e.g. Wrapped CSPR)
 *   CASCET_ASSET_STYLES           optional `<package hash>=<legacy-amount|cep3009-value>` comma list: the style
 *                                 each asset must have; start-up (and every payment) is refused when the chain
 *                                 disagrees, and always for a style CasCet knows to be wrong (its own token as
 *                                 cep3009-value, a known CEP-3009 token such as Wrapped CSPR as legacy-amount).
 *                                 Required with CASCET_PREFLIGHT=off for a token CasCet does not know
 *   CASCET_ASSET_NAMES            optional `<package hash>=<EIP-712 name>` comma list: pinned domain names
 *                                 (default: the names CasCet knows; with the preflight on, the on-chain names).
 *                                 Required for a token without an on-chain `name`
 *   CASCET_SETTLE_PAYMENT_MOTES   gas limit per settle for every asset without its own (default per style:
 *                                 4_000_000_000 for legacy-amount, 2_500_000_000 for cep3009-value)
 *   CASCET_SETTLE_PAYMENT_MOTES_BY_ASSET
 *                                 optional `<package hash>=<motes>` comma list: per-asset gas limits
 *   CASCET_DAILY_GAS_CAP_MOTES    sponsored gas per UTC day, all assets together (default 500 CSPR)
 *   CASCET_SETTLE_WAIT_MS         time /settle waits for execution before answering "pending" (default 60000;
 *                                 keep it below the gateway's timeouts.settleMs, 90 s by default)
 *   CASCET_PREFLIGHT              on (default) | off — on-chain ABI/nonce/balance/name checks (required on mainnet)
 *   CASCET_PREFLIGHT_DEADLINE_MS  total time one request's preflight may take (default 10000; keep it below
 *                                 the gateway's verify timeout, timeouts.facilitatorMs, 15 s by default)
 *   CASCET_TOKEN_VERSION          pinned EIP-712 domain version of every asset (default "1")
 *   CASCET_TOKEN_NAME             pinned EIP-712 domain name when exactly one asset is allowlisted (default
 *                                 "CasCet X402 Token" for the CasCet x402 token); with several, use CASCET_ASSET_NAMES
 *   CASCET_RPC_URL                Casper node JSON-RPC URL (default: the network's public endpoint, which is
 *                                 load-balanced; mainnet warns). Use ONE node you run or trust, so balance reads
 *                                 already include the settlements this facilitator observed
 *   CASCET_FACILITATOR_STATE_FILE path of the state file that keeps every authorization the facilitator submitted a
 *                                 transaction for across restarts, so a retry never submits a second one (REQUIRED on
 *                                 mainnet; "none" runs without one, with a warning; testnet warns when unset). One
 *                                 file per facilitator, on persistent storage, in an existing directory
 *   CASCET_FACILITATOR_MAX_REQUESTS_PER_IP_PER_MINUTE
 *                                 requests without CASCET_FACILITATOR_TOKEN one client IP may send a minute, on
 *                                 every route, before authentication (default 600); requests with it (the
 *                                 gateway's) are limited after authentication only, so traffic without the token
 *                                 through a TLS proxy (one address for every client) cannot use up the gateway's
 *                                 budget. Without a token every request counts: raise it when one gateway sends a
 *                                 lot of traffic, and keep it above the 300 /verify + /settle requests a minute
 *                                 allowed after authentication
 *   CASCET_FACILITATOR_HOST       bind address (default 127.0.0.1; any other address requires the token)
 *   PORT                          port (default 4501)
 */

export type CasperNetwork = "casper:casper" | "casper:casper-test";

export const NETWORKS = {
  "casper:casper": {
    rpcUrl: "https://node.mainnet.casper.network/rpc",
    chainName: "casper",
    /** CasCet x402 token (Cep18X402) on mainnet. */
    token: "8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41",
    receiptRegistry: "hash-f86bef35062e92d06b8171cf4131fdf557463589aca9112a348e5eb24159eb93",
    /**
     * The account that deployed (and owns) the CasCet mainnet contracts and has
     * been the seller so far: public key 01c3a787…, account hash b9a38c82…
     */
    deployerAccount: "00b9a38c827771d6bc510dd5f1e24fee61acdd4f97f758f4d68fe1dea13a7a140d",
    explorer: "https://cspr.live",
  },
  "casper:casper-test": {
    rpcUrl: "https://node.testnet.casper.network/rpc",
    chainName: "casper-test",
    token: "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3",
    receiptRegistry: "hash-bdf8422b69d7bfb7581e7b2c63fbfb0fc8b23701181289411170bce5cf996f97",
    /** Demo seller of the testnet data gateway. */
    defaultSeller: "00881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36",
    explorer: "https://testnet.cspr.live",
  },
} as const;

/** On-chain `name` of the CasCet x402 token on both networks (read-only check, 2026-11-01). */
export const CASCET_TOKEN_NAME = "CasCet X402 Token";

/**
 * EIP-712 domain names CasCet knows (on-chain `name`, read-only checks on
 * 2026-11-01 and 2026-11-02), pinned by default: the CasCet x402 token on both
 * networks and the official Wrapped CSPR on testnet.
 */
export const KNOWN_TOKEN_NAMES: Readonly<Record<CasperNetwork, Readonly<Record<string, string>>>> = Object.freeze({
  "casper:casper": Object.freeze({ [NETWORKS["casper:casper"].token]: CASCET_TOKEN_NAME }),
  "casper:casper-test": Object.freeze({
    [NETWORKS["casper:casper-test"].token]: CASCET_TOKEN_NAME,
    "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e": "Wrapped CSPR",
  }),
});

/**
 * Gas limit of a settle of CasCet's legacy-amount token. Measured consumption is
 * ~2.68–2.71 CSPR; 4 CSPR keeps headroom and stays in wasm lane 5 (≤ 5 CSPR).
 * Per style: DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE in @cascet/core.
 */
export const DEFAULT_SETTLE_PAYMENT_MOTES = DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE["legacy-amount"];
export { LANE5_MAX_PAYMENT_MOTES, MAX_SETTLE_PAYMENT_MOTES, MIN_SETTLE_PAYMENT_MOTES_BY_STYLE } from "./facilitator-assets.js";
export const DEFAULT_DAILY_GAS_CAP_MOTES = 500_000_000_000n;
/**
 * Blocks come every 8 s and a settle's result is visible a block or two after
 * submission; waiting this long lets almost every /settle answer success or
 * failure instead of "pending" (which the gateway records as an unknown
 * outcome and the buyer gets no result). casper-x402 1.0.0 polled up to 60 s too.
 */
export const DEFAULT_SETTLE_WAIT_MS = 60_000;

/** /verify + /settle requests a minute from all callers together, after authentication. */
export const DEFAULT_MAX_REQUESTS_PER_MINUTE = 300;
/**
 * Requests a minute from one client IP, on every route, before authentication
 * (only those without the facilitator token, when one is set). Without a token
 * it cannot tell a settle retry of a known transaction from other requests, so
 * it stays well above {@link DEFAULT_MAX_REQUESTS_PER_MINUTE}.
 */
export const DEFAULT_MAX_REQUESTS_PER_IP_PER_MINUTE = 600;

/**
 * Accounts a hot key must never be, nor be able to sign for: the configured
 * owners plus, on mainnet, always the CasCet deployer. It keeps the upgrade
 * access of the unlocked x402 token package even after ReceiptRegistry
 * ownership moves, so naming a new owner must not drop it. Bare 64-hex hashes.
 */
export function ownerAccountsFor(network: CasperNetwork, owners: readonly string[]): string[] {
  const list = owners.map(normalizeAccountHash);
  if (network === "casper:casper") list.push(normalizeAccountHash(NETWORKS["casper:casper"].deployerAccount));
  return [...new Set(list)];
}

export class FacilitatorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FacilitatorConfigError";
  }
}

type Env = Record<string, string | undefined>;

const value = (env: Env, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v ? v : undefined;
};

const list = (env: Env, name: string): string[] | undefined =>
  value(env, name)
    ?.split(",")
    .map(s => s.trim())
    .filter(Boolean);

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  const cleaned = raw.replace(/_/g, "");
  if (!/^\d+$/.test(cleaned)) throw new FacilitatorConfigError(`${name} must be a whole number, got "${raw.slice(0, 40)}"`);
  const n = Number(cleaned);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new FacilitatorConfigError(`${name} must be between ${min} and ${max}`);
  return n;
}

/** A whole number of motes ("4_000_000_000" allowed), or a config error naming `what`. */
function motes(raw: string, what: string): number {
  const cleaned = raw.trim().replace(/_/g, "");
  if (!/^\d+$/.test(cleaned)) throw new FacilitatorConfigError(`${what} must be a whole number, got "${raw.slice(0, 40)}"`);
  const n = Number(cleaned);
  if (!Number.isSafeInteger(n)) throw new FacilitatorConfigError(`${what} is too large`);
  return n;
}

/**
 * Parse an optional `<package hash>=<value>` comma list. Every hash must be
 * allowlisted (CASCET_ALLOWED_ASSETS) and appear once; the value is everything
 * after the first "=".
 */
function assetMap<T>(env: Env, name: string, allowed: readonly string[], parse: (raw: string, hash: string) => T): Map<string, T> {
  const out = new Map<string, T>();
  for (const pair of list(env, name) ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new FacilitatorConfigError(`${name}: expected <package hash>=<value>, got "${pair.slice(0, 80)}"`);
    let hash: string;
    try {
      hash = normalizeAsset(pair.slice(0, eq));
    } catch (err) {
      throw new FacilitatorConfigError(`${name}: ${(err as Error).message}`);
    }
    if (!allowed.includes(hash)) throw new FacilitatorConfigError(`${name}: ${hash.slice(0, 10)}… is not in CASCET_ALLOWED_ASSETS`);
    if (out.has(hash)) throw new FacilitatorConfigError(`${name}: ${hash.slice(0, 10)}… is listed twice`);
    try {
      out.set(hash, parse(pair.slice(eq + 1).trim(), hash));
    } catch (err) {
      throw err instanceof FacilitatorConfigError ? err : new FacilitatorConfigError(`${name}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** CASCET_RPC_URL must be an http(s) URL; plain http to a remote node only warns. */
function rpcUrl(env: Env, network: CasperNetwork, warnings: string[]): string {
  const fallback = NETWORKS[network].rpcUrl;
  const raw = value(env, "CASCET_RPC_URL");
  if (raw === undefined) {
    if (network === "casper:casper") {
      warnings.push(
        `CASCET_RPC_URL not set: ${new URL(fallback).host} is load-balanced, and a lagging backend can overstate a payer's ` +
          "balance right after a settle (the next settle then reverts and burns gas); set CASCET_RPC_URL to a single node",
      );
    }
    return fallback;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FacilitatorConfigError(`CASCET_RPC_URL must be an http(s) URL, got "${raw.slice(0, 80)}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new FacilitatorConfigError(`CASCET_RPC_URL must be an http(s) URL, got "${raw.slice(0, 80)}"`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    warnings.push("CASCET_RPC_URL uses plain http to a remote node: balance, nonce and settlement answers can be altered in transit");
  }
  return raw;
}

/**
 * CASCET_FACILITATOR_STATE_FILE: an absolute path, or `false` for "none" (run
 * without a state file, explicitly). Unset is refused on mainnet (F11).
 */
function stateFile(env: Env, mainnet: boolean): string | false | undefined {
  const raw = value(env, "CASCET_FACILITATOR_STATE_FILE");
  if (raw === undefined) {
    if (!mainnet) return undefined;
    throw new FacilitatorConfigError(
      "CASCET_FACILITATOR_STATE_FILE is required on mainnet: the path of a file on persistent storage where the " +
        "facilitator keeps every authorization it submitted a transaction for, so a restart never submits a second one " +
        "(it would revert and burn its gas). Set it to none to run without one anyway (not recommended)",
    );
  }
  if (raw.toLowerCase() === "none") return false;
  // A switch-like value is a mistake, not a file name: say so instead of creating ./off.
  if (/^(off|false|no|0|disabled?)$/i.test(raw)) {
    throw new FacilitatorConfigError(`CASCET_FACILITATOR_STATE_FILE must be a path, or none to run without one; got "${raw.slice(0, 40)}"`);
  }
  return resolve(raw);
}

/** Network from CASCET_NETWORK (CAIP-2) or the legacy CASCET_NET=mainnet|testnet. Default testnet. */
export function resolveNetwork(env: Env): CasperNetwork {
  const caip = value(env, "CASCET_NETWORK");
  const legacy = value(env, "CASCET_NET");
  let fromLegacy: CasperNetwork | undefined;
  if (legacy !== undefined) {
    if (legacy === "mainnet") fromLegacy = "casper:casper";
    else if (legacy === "testnet") fromLegacy = "casper:casper-test";
    else throw new FacilitatorConfigError(`CASCET_NET must be "mainnet" or "testnet", got "${legacy.slice(0, 40)}"`);
  }
  if (caip !== undefined) {
    if (caip !== "casper:casper" && caip !== "casper:casper-test") {
      throw new FacilitatorConfigError(`CASCET_NETWORK must be exactly one of casper:casper, casper:casper-test for the facilitator`);
    }
    if (fromLegacy && fromLegacy !== caip) throw new FacilitatorConfigError("CASCET_NETWORK and CASCET_NET disagree");
    return caip;
  }
  return fromLegacy ?? "casper:casper-test";
}

export interface FacilitatorEnvConfig {
  network: CasperNetwork;
  rpcUrl: string;
  host: string;
  port: number;
  keyPath: string;
  keyAlgo: "ed25519" | "secp256k1";
  authToken?: string;
  allowedPayTo: string[];
  /** The allowlisted assets with their settings (pass these to startRealFacilitator as `assets`). */
  assets: FacilitatorAssetOptions[];
  /** Bare package hashes of `assets`, in order. */
  allowedAssets: string[];
  /** Owner accounts (bare 64 hex); on mainnet always includes the deployer. */
  ownerAccountHashes: string[];
  /** CASCET_SETTLE_PAYMENT_MOTES: the gas limit of assets without their own; undefined = per style. */
  paymentMotes?: number;
  dailyGasCapMotes: bigint;
  settleWaitMs: number;
  preflight: boolean;
  preflightDeadlineMs: number;
  tokenVersion: string;
  /** Pinned EIP-712 domain name of the single allowlisted asset, when known. */
  tokenName?: string;
  /**
   * CASCET_FACILITATOR_STATE_FILE: an absolute path, `false` for "none" (no
   * state file, chosen explicitly), undefined when unset (testnet only).
   */
  stateFile?: string | false;
  /** CASCET_FACILITATOR_MAX_REQUESTS_PER_IP_PER_MINUTE. */
  maxRequestsPerIpPerMinute: number;
  /** Non-fatal notes for the operator (never contain secrets). */
  warnings: string[];
}

/**
 * Read and validate the facilitator configuration. Throws
 * {@link FacilitatorConfigError} with an actionable message; the key-role and
 * token-strength rules, and everything about the assets that needs the chain,
 * are enforced again by `startRealFacilitator`.
 */
export function readFacilitatorEnv(env: Env, repoRoot: string, forceNetwork?: CasperNetwork): FacilitatorEnvConfig {
  const network = forceNetwork ?? resolveNetwork(env);
  const mainnet = network === "casper:casper";
  const net = NETWORKS[network];
  const warnings: string[] = [];

  const keyFromEnv = value(env, "CASCET_FACILITATOR_KEY");
  let keyPath: string;
  if (keyFromEnv) keyPath = resolve(keyFromEnv);
  else if (mainnet) {
    throw new FacilitatorConfigError(
      "CASCET_FACILITATOR_KEY is required on mainnet: the PEM of a dedicated, low-float fee-payer key " +
        "(generate one with: pnpm --filter @cascet/e2e key-roles -- --out <dir>)",
    );
  } else {
    keyPath = resolve(repoRoot, "contracts/keys/deployer_secret_key.pem");
    warnings.push("CASCET_FACILITATOR_KEY not set: using the testnet deployer key as fee payer");
  }

  const algo = value(env, "CASCET_FACILITATOR_KEY_ALGO") ?? "ed25519";
  if (algo !== "ed25519" && algo !== "secp256k1") {
    throw new FacilitatorConfigError("CASCET_FACILITATOR_KEY_ALGO must be ed25519 or secp256k1");
  }

  const authToken = value(env, "CASCET_FACILITATOR_TOKEN");
  if (mainnet && !authToken) {
    throw new FacilitatorConfigError("CASCET_FACILITATOR_TOKEN is required on mainnet (generate one with: openssl rand -hex 32)");
  }
  const statePath = stateFile(env, mainnet);

  let allowedPayTo: string[];
  try {
    const sellers = list(env, "CASCET_SELLER_ACCOUNT_HASH");
    if (sellers?.length) allowedPayTo = sellers.map(normalizePayTo);
    else if (mainnet) {
      allowedPayTo = [NETWORKS["casper:casper"].deployerAccount];
      warnings.push("CASCET_SELLER_ACCOUNT_HASH not set: settling to the deployer account (00b9a38c…) as before");
    } else allowedPayTo = [NETWORKS["casper:casper-test"].defaultSeller];
  } catch (err) {
    throw new FacilitatorConfigError(`CASCET_SELLER_ACCOUNT_HASH: ${(err as Error).message}`);
  }

  let allowedAssets: string[];
  try {
    allowedAssets = [...new Set((list(env, "CASCET_ALLOWED_ASSETS") ?? [net.token]).map(normalizeAsset))];
  } catch (err) {
    throw new FacilitatorConfigError(`CASCET_ALLOWED_ASSETS: ${(err as Error).message}`);
  }

  let ownerAccountHashes: string[];
  try {
    ownerAccountHashes = ownerAccountsFor(network, list(env, "CASCET_OWNER_ACCOUNT_HASH") ?? []);
  } catch (err) {
    throw new FacilitatorConfigError(`CASCET_OWNER_ACCOUNT_HASH: ${(err as Error).message}`);
  }

  const preflightRaw = (value(env, "CASCET_PREFLIGHT") ?? "on").toLowerCase();
  if (!["on", "off", "1", "0", "true", "false"].includes(preflightRaw)) {
    throw new FacilitatorConfigError("CASCET_PREFLIGHT must be on or off");
  }
  const preflight = ["on", "1", "true"].includes(preflightRaw);
  if (!preflight && mainnet) {
    throw new FacilitatorConfigError("CASCET_PREFLIGHT=off is refused on mainnet: the on-chain nonce and balance checks keep doomed settles from burning gas");
  }
  if (!preflight) warnings.push("CASCET_PREFLIGHT=off: replayed or unfunded authorizations are only caught by this process's nonce ledger");

  // --- per-asset settings ---
  const styles = assetMap(env, "CASCET_ASSET_STYLES", allowedAssets, raw => {
    if (!isAuthorizationStyle(raw)) throw new FacilitatorConfigError(`CASCET_ASSET_STYLES: "${raw.slice(0, 40)}" is neither legacy-amount nor cep3009-value`);
    return raw;
  });
  const names = assetMap(env, "CASCET_ASSET_NAMES", allowedAssets, raw => checkDomainString(raw, "CASCET_ASSET_NAMES: a name", 100));
  const limits = assetMap(env, "CASCET_SETTLE_PAYMENT_MOTES_BY_ASSET", allowedAssets, raw =>
    motes(raw, "CASCET_SETTLE_PAYMENT_MOTES_BY_ASSET: a gas limit"),
  );
  const defaultLimitRaw = value(env, "CASCET_SETTLE_PAYMENT_MOTES");
  const paymentMotes = defaultLimitRaw !== undefined ? motes(defaultLimitRaw, "CASCET_SETTLE_PAYMENT_MOTES") : undefined;

  // The single-asset name pin (CasCet's own token by default).
  const tokenNameRaw = value(env, "CASCET_TOKEN_NAME");
  if (tokenNameRaw !== undefined && allowedAssets.length !== 1) {
    throw new FacilitatorConfigError(
      "CASCET_TOKEN_NAME pins the name of a single allowlisted asset; with several, use CASCET_ASSET_NAMES=<package hash>=<name>,…",
    );
  }
  const tokenVersion = value(env, "CASCET_TOKEN_VERSION") ?? "1";

  const assets: FacilitatorAssetOptions[] = allowedAssets.map(hash => {
    const style: AuthorizationStyle | undefined = styles.get(hash);
    const name = names.get(hash) ?? (tokenNameRaw !== undefined ? tokenNameRaw : undefined) ?? KNOWN_TOKEN_NAMES[network][hash];
    const limit = limits.get(hash) ?? paymentMotes;
    return {
      packageHash: hash,
      ...(style ? { authorization: style } : {}),
      ...(name !== undefined ? { name } : {}),
      version: tokenVersion,
      ...(limit !== undefined ? { paymentMotes: limit } : {}),
    };
  });

  // Gas limits: never below the measured consumption of the asset's style.
  for (const asset of assets) {
    if (asset.paymentMotes === undefined) continue;
    const style = asset.authorization ?? knownAuthorizationStyle(network, asset.packageHash);
    const source = limits.has(asset.packageHash) ? "CASCET_SETTLE_PAYMENT_MOTES_BY_ASSET" : "CASCET_SETTLE_PAYMENT_MOTES";
    try {
      checkPaymentMotes(asset.paymentMotes, style, `${source} (${asset.packageHash.slice(0, 10)}…)`);
    } catch (err) {
      throw new FacilitatorConfigError((err as Error).message);
    }
  }
  // Without the preflight, nothing reads styles and names on-chain: they must be pinned.
  try {
    planAssets(assets, {
      network,
      preflight,
      label: (i, field) =>
        field === "name"
          ? `CASCET_TOKEN_NAME / CASCET_ASSET_NAMES (${assets[i]!.packageHash.slice(0, 10)}…)`
          : field === "authorization"
            ? `CASCET_ASSET_STYLES (${assets[i]!.packageHash.slice(0, 10)}…)`
            : `${field} of ${assets[i]!.packageHash.slice(0, 10)}…`,
    });
  } catch (err) {
    throw new FacilitatorConfigError((err as Error).message);
  }

  const largestLimit = Math.max(
    ...assets.map(a => {
      if (a.paymentMotes !== undefined) return a.paymentMotes;
      const style = a.authorization ?? knownAuthorizationStyle(network, a.packageHash);
      return style ? DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE[style] : Math.max(...Object.values(DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE));
    }),
  );
  if (largestLimit > LANE5_MAX_PAYMENT_MOTES) {
    warnings.push("a gas limit above 5 CSPR moves settles from wasm lane 5 (40/block) to lane 4 (2/block)");
  }
  const capRaw = value(env, "CASCET_DAILY_GAS_CAP_MOTES")?.replace(/_/g, "");
  if (capRaw !== undefined && !/^\d+$/.test(capRaw)) throw new FacilitatorConfigError("CASCET_DAILY_GAS_CAP_MOTES must be a whole number");
  const dailyGasCapMotes = capRaw !== undefined ? BigInt(capRaw) : DEFAULT_DAILY_GAS_CAP_MOTES;
  if (dailyGasCapMotes < BigInt(largestLimit)) {
    throw new FacilitatorConfigError("CASCET_DAILY_GAS_CAP_MOTES must be at least one settle (the largest per-asset gas limit)");
  }

  const singleName = assets.length === 1 ? assets[0]!.name : undefined;
  return {
    network,
    rpcUrl: rpcUrl(env, network, warnings),
    host: value(env, "CASCET_FACILITATOR_HOST") ?? "127.0.0.1",
    port: integer(env, "PORT", 4501, 1, 65_535),
    keyPath,
    keyAlgo: algo,
    ...(authToken ? { authToken } : {}),
    allowedPayTo,
    assets,
    allowedAssets,
    ownerAccountHashes,
    ...(paymentMotes !== undefined ? { paymentMotes } : {}),
    dailyGasCapMotes,
    settleWaitMs: integer(env, "CASCET_SETTLE_WAIT_MS", DEFAULT_SETTLE_WAIT_MS, 3_000, 300_000),
    preflight,
    preflightDeadlineMs: integer(env, "CASCET_PREFLIGHT_DEADLINE_MS", DEFAULT_PREFLIGHT_DEADLINE_MS, 1_000, 60_000),
    tokenVersion,
    ...(singleName !== undefined ? { tokenName: singleName } : {}),
    ...(statePath !== undefined ? { stateFile: statePath } : {}),
    maxRequestsPerIpPerMinute: integer(
      env,
      "CASCET_FACILITATOR_MAX_REQUESTS_PER_IP_PER_MINUTE",
      DEFAULT_MAX_REQUESTS_PER_IP_PER_MINUTE,
      1,
      1_000_000,
    ),
    warnings,
  };
}

/**
 * The `startRealFacilitator` options of an environment configuration. Every
 * script that starts the facilitator from the environment (the standalone
 * facilitator and the real-settlement demos) passes these, so no setting is
 * dropped on the way: each asset carries its declared style, pinned name and
 * version, and gas limit (`assets`, never the `allowedAssets` shorthand).
 */
export function facilitatorOptionsFromEnv(cfg: FacilitatorEnvConfig): RealFacilitatorOptions {
  return {
    port: cfg.port,
    host: cfg.host,
    network: cfg.network,
    keyPath: cfg.keyPath,
    keyAlgo: cfg.keyAlgo,
    rpcUrl: cfg.rpcUrl,
    ...(cfg.authToken ? { authToken: cfg.authToken } : {}),
    allowedPayTo: cfg.allowedPayTo,
    assets: cfg.assets,
    ownerAccountHashes: cfg.ownerAccountHashes,
    dailyGasCapMotes: cfg.dailyGasCapMotes,
    settleWaitMs: cfg.settleWaitMs,
    preflight: cfg.preflight,
    preflightDeadlineMs: cfg.preflightDeadlineMs,
    ...(cfg.stateFile !== undefined ? { stateFile: cfg.stateFile } : {}),
    maxRequestsPerIpPerMinute: cfg.maxRequestsPerIpPerMinute,
  };
}
