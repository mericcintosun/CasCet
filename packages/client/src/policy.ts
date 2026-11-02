import {
  AUTHORIZATION_STYLE_EXTRA_KEY,
  AUTHORIZATION_STYLES,
  isAuthorizationStyle,
  NETWORK_CASPER_TESTNET,
  normalizePayTo,
  type AuthorizationStyle,
} from "@cascet/core";

/** Raw CEP-18 amounts: 1-40 decimal digits. No sign, spaces, decimals, hex or exponent. */
export const RAW_AMOUNT_PATTERN = /^[0-9]{1,40}$/;

/**
 * Default cap on `maxTimeoutSeconds`, i.e. how long a signed authorization may
 * stay valid. x402 servers default to 300 s; a hostile 402 could otherwise ask
 * for an authorization that stays spendable for years.
 */
export const DEFAULT_MAX_AUTHORIZATION_SECONDS = 900;

/**
 * Longest EIP-712 domain name (`extra.name`) a payment option may carry, in
 * UTF-16 code units (String.length): the bound CasCet's self-hosted facilitator
 * puts on a token name it pins. Real tokens use a few characters ("Wrapped CSPR").
 */
export const MAX_TOKEN_NAME_LENGTH = 100;

/**
 * Longest EIP-712 domain version (`extra.version`) a payment option may carry,
 * counted as {@link MAX_TOKEN_NAME_LENGTH} is: the self-hosted facilitator's
 * bound for a pinned version. Tokens use "1".
 */
export const MAX_TOKEN_VERSION_LENGTH = 20;

/** CAIP-2 id in the casper namespace; the reference charset is [-_a-zA-Z0-9]{1,32}. No wildcards. */
const CASPER_NETWORK = /^casper:[-_a-zA-Z0-9]{1,32}$/;
/** Serialized Casper Key as the exact scheme uses it: "00" account hash or "01" contract package. */
const SERIALIZED_KEY = /^(00|01)[0-9a-f]{64}$/;
const PACKAGE_HASH = /^[0-9a-f]{64}$/;
/** A UTF-16 surrogate that is not half of a pair: with the u flag, a pair reads as one code point. */
const LONE_SURROGATE = /\p{Surrogate}/u;

/**
 * Why a "01" payee (a contract package such as a RevenueSplit, or a public key
 * passed off as one) is never paid: facilitators built on
 * @make-software/casper-x402 1.0.0 settle any payTo as
 * `Key.newKey("account-hash-" + payTo.slice(2))`, and CasCet's self-hosted
 * facilitator refuses contract payees.
 */
export const CONTRACT_PAYEE_REASON =
  "contract-package payees are not paid: @make-software/casper-x402 1.0.0 facilitators credit the payment " +
  "to an account nobody controls, and CasCet's self-hosted facilitator refuses them";

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

/**
 * Normalize one entry of a payee allowlist to the serialized Key a 402 names
 * ("00" + account hash). Accepts what {@link normalizePayTo} accepts, except a
 * contract package: a payee the client would refuse anyway is a config error.
 */
export function normalizeAllowedPayTo(value: string): string {
  const payTo = normalizePayTo(value);
  if (payTo.startsWith("01")) {
    throw new Error(`${show(value.trim())} is a contract-package payee: ${CONTRACT_PAYEE_REASON}. Allowlist an account hash instead.`);
  }
  return payTo;
}

/**
 * Validate an authorization-style preference (most preferred first): known
 * styles only, duplicates dropped. Undefined means no preference, so the
 * gateway's order of the acceptable options decides. `label` names the setting in errors.
 */
export function normalizePreferStyles(styles: readonly unknown[] | undefined, label = "preferStyles"): AuthorizationStyle[] | undefined {
  if (styles === undefined) return undefined;
  if (!Array.isArray(styles) || styles.length === 0) {
    throw new Error(
      `${label} must list at least one authorization style (${AUTHORIZATION_STYLES.join(", ")}); omit it to keep the gateway's order`,
    );
  }
  const out: AuthorizationStyle[] = [];
  for (const entry of styles) {
    const style = typeof entry === "string" ? entry.trim() : entry;
    if (!isAuthorizationStyle(style)) {
      throw new Error(`${label}: unknown authorization style ${show(entry)}; known styles: ${AUTHORIZATION_STYLES.join(", ")}`);
    }
    if (!out.includes(style)) out.push(style);
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
  /**
   * Payees this client pays: account hashes ("00" + 64 hex or "account-hash-<64 hex>").
   * Contract packages are rejected (see {@link CONTRACT_PAYEE_REASON}). Undefined = any account-hash payee.
   */
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
  | {
      ok: true;
      network: string;
      payTo: string;
      asset: string;
      amount: bigint;
      /** The option's `extra.authorizationStyle`, when the gateway advertised one. */
      authorizationStyle?: AuthorizationStyle;
    }
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
        return normalizeAllowedPayTo(value);
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
    const decision = this.check(requirements);
    if (decision.ok) this.spent.set(decision.asset, (this.spent.get(decision.asset) ?? 0n) + decision.amount);
    return decision;
  }

  /**
   * Check one payment option from a 402 against every rule, the session budget
   * included, without reserving anything (to choose among several options).
   */
  check(requirements: unknown): SpendDecision {
    if (typeof requirements !== "object" || requirements === null) return refuse("malformed payment requirements");
    const req = requirements as Record<string, unknown>;

    if (req.scheme !== "exact") return refuse(`unsupported payment scheme ${show(req.scheme)}`);

    const network = req.network;
    if (typeof network !== "string" || !this.networks.includes(network)) {
      return refuse(`network ${show(network)} is not allowed; this client only pays on ${this.networks.join(", ")}`);
    }

    const payTo = typeof req.payTo === "string" ? req.payTo.toLowerCase() : undefined;
    if (payTo === undefined || !SERIALIZED_KEY.test(payTo)) return refuse(`malformed payTo ${show(req.payTo)}`);
    // Checked before the allowlist and never overridable by it: no facilitator can settle a "01" payee today.
    if (payTo.startsWith("01")) {
      return refuse(`payTo ${payTo} is not an account hash (a contract package, or a public key): ${CONTRACT_PAYEE_REASON}`);
    }
    if (this.allowedPayTo && !this.allowedPayTo.has(payTo)) return refuse(`payTo ${payTo} is not allowlisted`);

    const asset = typeof req.asset === "string" ? req.asset.toLowerCase() : undefined;
    if (asset === undefined || !PACKAGE_HASH.test(asset)) return refuse(`malformed asset ${show(req.asset)}`);
    if (this.allowedAssets && !this.allowedAssets.has(asset)) return refuse(`asset ${asset} is not allowlisted`);

    // Informational, but a value this client does not know means terms it cannot judge.
    const extra = typeof req.extra === "object" && req.extra !== null ? (req.extra as Record<string, unknown>) : {};
    const authorizationStyle = extra[AUTHORIZATION_STYLE_EXTRA_KEY];
    if (authorizationStyle !== undefined && !isAuthorizationStyle(authorizationStyle)) {
      return refuse(`unknown authorization style ${show(authorizationStyle)}; this client knows ${AUTHORIZATION_STYLES.join(", ")}`);
    }

    // The token's EIP-712 domain, which the authorization is signed over. An option without a
    // usable name or version is refused here, so that selection moves on to the next option,
    // instead of failing at signing after its budget was reserved.
    const domainRefusal =
      domainFieldRefusal(extra.name, "extra.name", MAX_TOKEN_NAME_LENGTH) ??
      domainFieldRefusal(extra.version, "extra.version", MAX_TOKEN_VERSION_LENGTH);
    if (domainRefusal !== undefined) return refuse(`malformed EIP-712 domain: ${domainRefusal}`);

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
    return { ok: true, network, payTo, asset, amount, ...(authorizationStyle !== undefined ? { authorizationStyle } : {}) };
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
    throw new Error(`${label} must be a non-empty list; omit it to allow any value (not recommended)`);
  }
  const out = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") throw new Error(`${label} entries must be strings; got ${show(value)}`);
    out.add(normalize(value));
  }
  return out;
}

/**
 * Why `value` cannot be signed over as `field` of a token's EIP-712 domain, or
 * undefined when it can. @x402/casper throws when the name or the version is
 * not a non-empty string, and encodes a lone surrogate as U+FFFD, a domain the
 * token does not have.
 */
function domainFieldRefusal(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return `${field} is missing`;
  if (typeof value !== "string") return `${field} must be a string; got ${show(value)}`;
  if (value === "") return `${field} is empty`;
  if (LONE_SURROGATE.test(value)) return `${field} contains lone UTF-16 surrogates, which have no UTF-8 form to sign over`;
  if (value.length > maxLength) return `${field} is ${value.length} characters long, above this client's ${maxLength}-character limit`;
  return undefined;
}

function refuse(reason: string): SpendDecision {
  return { ok: false, reason };
}

/**
 * Escape the control characters (C0, DEL, C1), line and paragraph separators
 * and bidirectional-text controls of gateway-supplied text as `\uXXXX`, so that
 * it cannot fake lines or reorder text in logs and messages.
 */
export function escapeControlCharacters(text: string): string {
  let escaped = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const control =
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    escaped += control ? `\\u${code.toString(16).padStart(4, "0")}` : char;
  }
  return escaped;
}

/**
 * A value quoted for a message, as JSON: a gateway supplies many of them, so
 * strings are shortened and what JSON leaves raw (DEL, C1, separators,
 * bidirectional-text controls) is escaped too.
 */
function show(value: unknown): string {
  if (typeof value === "string") return escapeControlCharacters(JSON.stringify(value.length > 80 ? `${value.slice(0, 77)}...` : value));
  if (typeof value === "bigint") return `${value}n`;
  try {
    return escapeControlCharacters(JSON.stringify(value) ?? String(value));
  } catch {
    return escapeControlCharacters(String(value));
  }
}
