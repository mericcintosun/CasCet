import { resolve } from "node:path";
import { DEFAULT_PREFLIGHT_DEADLINE_MS, normalizeAsset, normalizePayTo } from "./facilitator-core.js";
import { normalizeAccountHash } from "./facilitator-roles.js";

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
 *   CASCET_ALLOWED_ASSETS         comma list of CEP-18 package hashes (default: the CasCet x402 token)
 *   CASCET_SETTLE_PAYMENT_MOTES   gas limit per settle (default 4_000_000_000 = 4 CSPR)
 *   CASCET_DAILY_GAS_CAP_MOTES    sponsored gas per UTC day (default 500 CSPR)
 *   CASCET_SETTLE_WAIT_MS         time /settle waits for execution before answering "pending" (default 60000;
 *                                 keep it below the gateway's timeouts.settleMs, 90 s by default)
 *   CASCET_PREFLIGHT              on (default) | off — on-chain nonce/balance/name checks (required on mainnet)
 *   CASCET_PREFLIGHT_DEADLINE_MS  total time one request's preflight may take (default 10000; keep it below
 *                                 the gateway's verify timeout, timeouts.facilitatorMs, 15 s by default)
 *   CASCET_TOKEN_VERSION          pinned EIP-712 domain version (default "1")
 *   CASCET_TOKEN_NAME             pinned EIP-712 domain name (default "CasCet X402 Token" when only the CasCet
 *                                 x402 token is allowlisted; required when CASCET_PREFLIGHT=off)
 *   CASCET_RPC_URL                Casper node JSON-RPC URL (default: the public node of the network);
 *                                 use ONE node, not a load balancer, so balance reads follow settlements
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

/** Measured settle consumption is ~2.68–2.71 CSPR; 4 CSPR keeps headroom and stays in wasm lane 5 (≤ 5 CSPR). */
export const DEFAULT_SETTLE_PAYMENT_MOTES = 4_000_000_000;
/** Below this a settle is likely to run out of gas, and a revert burns the whole limit. */
export const MIN_SETTLE_PAYMENT_MOTES = 3_000_000_000;
/** Above this a settle leaves wasm lane 5 (40 tx/block) for lane 4 (2 tx/block). */
export const LANE5_MAX_PAYMENT_MOTES = 5_000_000_000;
/** Lane 4 limit; nothing a settle needs comes close. */
export const MAX_SETTLE_PAYMENT_MOTES = 100_000_000_000;
export const DEFAULT_DAILY_GAS_CAP_MOTES = 500_000_000_000n;
/**
 * Blocks come every 8 s and a settle's result is visible a block or two after
 * submission; waiting this long lets almost every /settle answer success or
 * failure instead of "pending" (which the gateway records as an unknown
 * outcome and the buyer gets no result). casper-x402 1.0.0 polled up to 60 s too.
 */
export const DEFAULT_SETTLE_WAIT_MS = 60_000;
/** On-chain `name` of the CasCet x402 token on both networks (read-only check, 2026-11-01). */
export const CASCET_TOKEN_NAME = "CasCet X402 Token";

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

/** CASCET_RPC_URL must be an http(s) URL; plain http to a remote node only warns. */
function rpcUrl(env: Env, fallback: string, warnings: string[]): string {
  const raw = value(env, "CASCET_RPC_URL");
  if (raw === undefined) return fallback;
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
  allowedAssets: string[];
  /** Owner accounts (bare 64 hex); on mainnet always includes the deployer. */
  ownerAccountHashes: string[];
  paymentMotes: number;
  dailyGasCapMotes: bigint;
  settleWaitMs: number;
  preflight: boolean;
  preflightDeadlineMs: number;
  tokenVersion: string;
  /** Pinned EIP-712 domain name, when known. */
  tokenName?: string;
  /** Non-fatal notes for the operator (never contain secrets). */
  warnings: string[];
}

/**
 * Read and validate the facilitator configuration. Throws
 * {@link FacilitatorConfigError} with an actionable message; the key-role and
 * token-strength rules are enforced again by `startRealFacilitator`.
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
    allowedAssets = (list(env, "CASCET_ALLOWED_ASSETS") ?? [net.token]).map(normalizeAsset);
  } catch (err) {
    throw new FacilitatorConfigError(`CASCET_ALLOWED_ASSETS: ${(err as Error).message}`);
  }

  let ownerAccountHashes: string[];
  try {
    ownerAccountHashes = ownerAccountsFor(network, list(env, "CASCET_OWNER_ACCOUNT_HASH") ?? []);
  } catch (err) {
    throw new FacilitatorConfigError(`CASCET_OWNER_ACCOUNT_HASH: ${(err as Error).message}`);
  }

  const paymentMotes = integer(env, "CASCET_SETTLE_PAYMENT_MOTES", DEFAULT_SETTLE_PAYMENT_MOTES, MIN_SETTLE_PAYMENT_MOTES, MAX_SETTLE_PAYMENT_MOTES);
  if (paymentMotes > LANE5_MAX_PAYMENT_MOTES) {
    warnings.push("CASCET_SETTLE_PAYMENT_MOTES above 5 CSPR moves settles from wasm lane 5 (40/block) to lane 4 (2/block)");
  }
  const capRaw = value(env, "CASCET_DAILY_GAS_CAP_MOTES")?.replace(/_/g, "");
  if (capRaw !== undefined && !/^\d+$/.test(capRaw)) throw new FacilitatorConfigError("CASCET_DAILY_GAS_CAP_MOTES must be a whole number");
  const dailyGasCapMotes = capRaw !== undefined ? BigInt(capRaw) : DEFAULT_DAILY_GAS_CAP_MOTES;
  if (dailyGasCapMotes < BigInt(paymentMotes)) {
    throw new FacilitatorConfigError("CASCET_DAILY_GAS_CAP_MOTES must be at least one settle (CASCET_SETTLE_PAYMENT_MOTES)");
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

  // The pinned name defaults to the CasCet token's when that is the only asset settled.
  const tokenNameRaw = value(env, "CASCET_TOKEN_NAME");
  const onlyCascetToken = allowedAssets.length > 0 && allowedAssets.every(a => a === net.token);
  const tokenName = tokenNameRaw ?? (onlyCascetToken ? CASCET_TOKEN_NAME : undefined);
  if (!preflight && tokenName === undefined) {
    throw new FacilitatorConfigError("CASCET_PREFLIGHT=off requires CASCET_TOKEN_NAME (the EIP-712 domain name of the allowlisted token)");
  }

  return {
    network,
    rpcUrl: rpcUrl(env, net.rpcUrl, warnings),
    host: value(env, "CASCET_FACILITATOR_HOST") ?? "127.0.0.1",
    port: integer(env, "PORT", 4501, 1, 65_535),
    keyPath,
    keyAlgo: algo,
    ...(authToken ? { authToken } : {}),
    allowedPayTo,
    allowedAssets,
    ownerAccountHashes,
    paymentMotes,
    dailyGasCapMotes,
    settleWaitMs: integer(env, "CASCET_SETTLE_WAIT_MS", DEFAULT_SETTLE_WAIT_MS, 3_000, 300_000),
    preflight,
    preflightDeadlineMs: integer(env, "CASCET_PREFLIGHT_DEADLINE_MS", DEFAULT_PREFLIGHT_DEADLINE_MS, 1_000, 60_000),
    tokenVersion: value(env, "CASCET_TOKEN_VERSION") ?? "1",
    ...(tokenName !== undefined ? { tokenName } : {}),
    warnings,
  };
}
