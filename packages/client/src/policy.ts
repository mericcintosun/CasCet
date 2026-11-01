import { NETWORK_CASPER_TESTNET, normalizePayTo } from "@cascet/core";

/** Raw CEP-18 amounts: 1-40 decimal digits. No sign, spaces, decimals, hex or exponent. */
export const RAW_AMOUNT_PATTERN = /^[0-9]{1,40}$/;

/**
 * Default cap on `maxTimeoutSeconds`, i.e. how long a signed authorization may
 * stay valid. x402 servers default to 300 s; a hostile 402 could otherwise ask
 * for an authorization that stays spendable for years.
 */
export const DEFAULT_MAX_AUTHORIZATION_SECONDS = 900;

/** CAIP-2 id in the casper namespace; the reference charset is [-_a-zA-Z0-9]{1,32}. No wildcards. */
const CASPER_NETWORK = /^casper:[-_a-zA-Z0-9]{1,32}$/;
/** Serialized Casper Key as the exact scheme uses it: "00" account hash or "01" contract package. */
const SERIALIZED_KEY = /^(00|01)[0-9a-f]{64}$/;
const PACKAGE_HASH = /^[0-9a-f]{64}$/;

/**
 * Parse a raw token amount strictly: a string of 1-40 decimal digits, greater
 * than zero. `BigInt()` alone accepts "-5", "0x10", " 5 " and "" (as 0n), which
 * let a hostile 402 drive the session counter negative (M32).
 */
export function parseRawAmount(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !RAW_AMOUNT_PATTERN.test(value)) {
    throw new Error(
      `${label} must be a whole number of raw token units (1-40 decimal digits, no sign, decimals, hex or exponent); got ${show(value)}`,
    );
  }
  const amount = BigInt(value);
  if (amount <= 0n) throw new Error(`${label} must be greater than zero; got ${show(value)}`);
  return amount;
}

/** Validate the CAIP-2 networks a client may pay on. Defaults to Casper testnet only. */
export function normalizeNetworks(networks: readonly string[] | undefined): string[] {
  if (networks === undefined) return [NETWORK_CASPER_TESTNET];
  if (!Array.isArray(networks) || networks.length === 0) {
    throw new Error('networks must list at least one CAIP-2 Casper network, e.g. ["casper:casper-test"]');
  }
  const out: string[] = [];
  for (const entry of networks) {
    const network = typeof entry === "string" ? entry.trim() : entry;
    if (typeof network !== "string" || !CASPER_NETWORK.test(network)) {
      throw new Error(
        `invalid network ${show(entry)}: use a CAIP-2 Casper id such as "casper:casper-test" or "casper:casper" (wildcards are not allowed)`,
      );
    }
    if (!out.includes(network)) out.push(network);
  }
  return out;
}

/** Normalize a CEP-18 contract package hash to bare lower-case hex (accepts "hash-", "contract-package-" or "0x"). */
export function normalizeAssetHash(value: string): string {
  const bare = value.trim().toLowerCase().replace(/^(?:hash-|contract-package-|0x)/, "");
  if (!PACKAGE_HASH.test(bare)) {
    throw new Error(`invalid asset ${show(value)}: expected a CEP-18 contract package hash (64 hex, optionally prefixed "hash-")`);
  }
  return bare;
}

export interface SpendPolicyOptions {
  /** CAIP-2 networks this client pays on. Default: ["casper:casper-test"]. */
  networks?: readonly string[];
  /** Payees this client pays (account hashes or contract packages, see normalizePayTo). Undefined = any account-hash payee. */
  allowedPayTo?: readonly string[];
  /** CEP-18 package hashes this client pays in. Undefined = any asset. */
  allowedAssets?: readonly string[];
  /** Largest single payment, in raw token units. */
  maxPerCallRaw?: string;
  /** Largest total per asset for this session, in raw token units. */
  maxSessionRaw?: string;
  /** Longest validity window accepted for a signed authorization (seconds). */
  maxAuthorizationSeconds?: number;
}

/** Outcome of checking one 402 payment option against the policy. */
export type SpendDecision =
  | { ok: true; network: string; payTo: string; asset: string; amount: bigint }
  | { ok: false; reason: string };

/**
 * The buyer's spending rules. `authorize` checks a server-supplied payment
 * option field by field and, when it passes, reserves the amount against the
 * per-asset session budget in the same synchronous step, so concurrent
 * payments cannot overshoot the budget together.
 *
 * The session budget counts signed authorizations, not settlements: an
 * authorization can be settled by whoever holds it until it expires, so it is
 * treated as spent once signed.
 */
export class SpendPolicy {
  readonly networks: readonly string[];
  readonly allowedPayTo: ReadonlySet<string> | undefined;
  readonly allowedAssets: ReadonlySet<string> | undefined;
  readonly maxPerCall: bigint | undefined;
  readonly maxSession: bigint | undefined;
  readonly maxAuthorizationSeconds: number;
  private readonly spent = new Map<string, bigint>();

  constructor(opts: SpendPolicyOptions = {}) {
    this.networks = normalizeNetworks(opts.networks);
    this.allowedPayTo = normalizeList(opts.allowedPayTo, "allowedPayTo", value => {
      try {
        return normalizePayTo(value);
      } catch (err) {
        throw new Error(`allowedPayTo: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    this.allowedAssets = normalizeList(opts.allowedAssets, "allowedAssets", value => {
      try {
        return normalizeAssetHash(value);
      } catch (err) {
        throw new Error(`allowedAssets: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    this.maxPerCall =
      opts.maxPerCallRaw === undefined ? undefined : parseRawAmount(opts.maxPerCallRaw, "budget.maxPerCallRaw");
    this.maxSession =
      opts.maxSessionRaw === undefined ? undefined : parseRawAmount(opts.maxSessionRaw, "budget.maxSessionRaw");
    const seconds = opts.maxAuthorizationSeconds ?? DEFAULT_MAX_AUTHORIZATION_SECONDS;
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      throw new Error(`maxAuthorizationSeconds must be a positive whole number of seconds; got ${show(seconds)}`);
    }
    this.maxAuthorizationSeconds = seconds;
  }

  /** Check one payment option from a 402 and reserve its amount if it is acceptable. */
  authorize(requirements: unknown): SpendDecision {
    if (typeof requirements !== "object" || requirements === null) return refuse("malformed payment requirements");
    const req = requirements as Record<string, unknown>;

    if (req.scheme !== "exact") return refuse(`unsupported payment scheme ${show(req.scheme)}`);

    const network = req.network;
    if (typeof network !== "string" || !this.networks.includes(network)) {
      return refuse(`network ${show(network)} is not allowed; this client only pays on ${this.networks.join(", ")}`);
    }

    const payTo = typeof req.payTo === "string" ? req.payTo.toLowerCase() : undefined;
    if (payTo === undefined || !SERIALIZED_KEY.test(payTo)) return refuse(`malformed payTo ${show(req.payTo)}`);
    if (this.allowedPayTo) {
      if (!this.allowedPayTo.has(payTo)) return refuse(`payTo ${payTo} is not allowlisted`);
    } else if (payTo.startsWith("01")) {
      return refuse(
        `payTo ${payTo} is not an account hash: it is a contract package or a public key, and ` +
          "@make-software/casper-x402 1.0.0 settles it as an account nobody controls. Allowlist it explicitly to pay it.",
      );
    }

    const asset = typeof req.asset === "string" ? req.asset.toLowerCase() : undefined;
    if (asset === undefined || !PACKAGE_HASH.test(asset)) return refuse(`malformed asset ${show(req.asset)}`);
    if (this.allowedAssets && !this.allowedAssets.has(asset)) return refuse(`asset ${asset} is not allowlisted`);

    let amount: bigint;
    try {
      amount = parseRawAmount(req.amount, "amount");
    } catch (err) {
      return refuse(`malformed price: ${err instanceof Error ? err.message : String(err)}`);
    }

    const seconds = req.maxTimeoutSeconds;
    if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0) {
      return refuse(`malformed maxTimeoutSeconds ${show(seconds)}`);
    }
    if (seconds > this.maxAuthorizationSeconds) {
      return refuse(
        `the authorization would stay valid for ${seconds} s, above this client's ${this.maxAuthorizationSeconds} s limit`,
      );
    }

    if (this.maxPerCall !== undefined && amount > this.maxPerCall) {
      return refuse(`price ${amount} exceeds the per-call budget ${this.maxPerCall}`);
    }
    const spent = this.spent.get(asset) ?? 0n;
    if (this.maxSession !== undefined && spent + amount > this.maxSession) {
      return refuse(
        `price ${amount} would exceed the session budget ${this.maxSession} for asset ${asset} (already authorized ${spent})`,
      );
    }
    this.spent.set(asset, spent + amount);
    return { ok: true, network, payTo, asset, amount };
  }

  /** Give back a reservation whose authorization was never created (e.g. signing failed). */
  release(asset: string, amount: bigint): void {
    const spent = this.spent.get(asset) ?? 0n;
    const next = spent > amount ? spent - amount : 0n;
    if (next === 0n) this.spent.delete(asset);
    else this.spent.set(asset, next);
  }

  /** Raw units authorized this session, per asset (bare package hash). */
  spentByAsset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [asset, amount] of this.spent) out[asset] = amount.toString();
    return out;
  }

  /** Raw units authorized this session, summed over every asset. */
  spentTotal(): bigint {
    let total = 0n;
    for (const amount of this.spent.values()) total += amount;
    return total;
  }
}

function normalizeList(
  values: readonly string[] | undefined,
  label: string,
  normalize: (value: string) => string,
): ReadonlySet<string> | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must not be empty; omit it to allow any value (not recommended)`);
  }
  const out = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") throw new Error(`${label} entries must be strings; got ${show(value)}`);
    out.add(normalize(value));
  }
  return out;
}

function refuse(reason: string): SpendDecision {
  return { ok: false, reason };
}

function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.length > 80 ? `${value.slice(0, 77)}...` : value);
  if (typeof value === "bigint") return `${value}n`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
