/**
 * Parsing and normalisation of the Casper identifiers people paste into the UI
 * (seller payees, payer accounts, asset package hashes, gateway URLs).
 *
 * Pure and dependency-free so it runs in the browser, on the server and in unit
 * tests. Public-key to account-hash conversion needs blake2b and lives in
 * `account-hash.ts`, which loads casper-js-sdk lazily.
 *
 * Formats (all hex is lower-cased on output):
 *   - account payee   "00" + 64 hex, or "account-hash-" + 64 hex
 *   - contract payee  "hash-" + 64 hex or "package-hash-" + 64 hex (a contract package, e.g. RevenueSplit)
 *   - public key      "01" + 64 hex (ed25519) or "02" + 66 hex (secp256k1). Never a valid payTo by itself:
 *                     x402 needs the account hash, so a public key must be converted first (finding M01).
 */

export type KeyAlgorithmName = "ed25519" | "secp256k1";

export type PayeeInput =
  | { kind: "empty" }
  /** A 32-byte account hash (lower-case hex, no prefix). */
  | { kind: "account"; hash: string }
  /** A 32-byte contract package hash (lower-case hex, no prefix). */
  | { kind: "package"; hash: string }
  /** A public key that still has to be converted to its account hash. */
  | { kind: "public-key"; publicKey: string; algorithm: KeyAlgorithmName }
  | { kind: "invalid"; reason: string };

const ACCOUNT_KEY = /^00([0-9a-f]{64})$/;
const ACCOUNT_HASH = /^account-hash-([0-9a-f]{64})$/;
const PACKAGE_HASH = /^(?:hash|package-hash|contract-package|package)-([0-9a-f]{64})$/;
const ED25519_KEY = /^01[0-9a-f]{64}$/;
const SECP256K1_KEY = /^02[0-9a-f]{66}$/;
const BARE_HASH = /^[0-9a-f]{64}$/;

/** Classify one pasted seller/payer identifier. */
export function parsePayeeInput(raw: string): PayeeInput {
  const s = raw.trim().toLowerCase();
  if (!s) return { kind: "empty" };
  let m = ACCOUNT_KEY.exec(s) ?? ACCOUNT_HASH.exec(s);
  if (m) return { kind: "account", hash: m[1]! };
  m = PACKAGE_HASH.exec(s);
  if (m) return { kind: "package", hash: m[1]! };
  if (ED25519_KEY.test(s)) return { kind: "public-key", publicKey: s, algorithm: "ed25519" };
  if (SECP256K1_KEY.test(s)) return { kind: "public-key", publicKey: s, algorithm: "secp256k1" };
  if (BARE_HASH.test(s)) {
    return {
      kind: "invalid",
      reason: 'ambiguous 64-hex value: prefix it with "00" for an account hash or "hash-" for a contract package',
    };
  }
  return {
    kind: "invalid",
    reason: 'expected an account hash ("00" + 64 hex or "account-hash-…"), a public key (01… / 02…) or "hash-…" for a contract package',
  };
}

/**
 * The value to write into `cascet.config.json` `payTo`: "00" + account hash for
 * an account, "hash-" + package hash for a contract package. Both forms are
 * accepted by the config schema; a raw "01…" string is not, because it is
 * indistinguishable from an ed25519 public key.
 */
export function payToConfigValue(target: { kind: "account" | "package"; hash: string }): string {
  return target.kind === "account" ? `00${target.hash}` : `hash-${target.hash}`;
}

/**
 * The value a buyer puts on its `CASCET_ALLOWED_PAYTO` allowlist: the serialized
 * Casper Key exactly as it appears in the gateway's 402 challenge, "00" + hash
 * for an account and "01" + hash for a contract package.
 */
export function payToAllowlistValue(target: { kind: "account" | "package"; hash: string }): string {
  return target.kind === "account" ? `00${target.hash}` : `01${target.hash}`;
}

export type AssetInput = { ok: true; hash: string } | { ok: false; empty: boolean; reason: string };

/** Normalise a CEP-18 package hash ("hash-…", "contract-package-…" or bare 64 hex) to bare lower-case hex. */
export function parseAssetInput(raw: string): AssetInput {
  const s = raw.trim().toLowerCase();
  if (!s) return { ok: false, empty: true, reason: "empty" };
  const m = PACKAGE_HASH.exec(s) ?? /^([0-9a-f]{64})$/.exec(s);
  if (m) return { ok: true, hash: m[1]! };
  return {
    ok: false,
    empty: false,
    reason: 'expected a CEP-18 contract package hash: 64 hex characters, optionally prefixed with "hash-"',
  };
}

/**
 * Normalise an account reference found in on-chain data (a receipt's payer) to
 * a bare account hash, when it is already in account-hash form. Public keys
 * return null: the caller converts them with `accountHashFromPublicKey`.
 */
export function accountHashOf(value: string): string | null {
  const s = value.trim().toLowerCase();
  const m = ACCOUNT_KEY.exec(s) ?? ACCOUNT_HASH.exec(s);
  return m ? m[1]! : null;
}

/** True for a hostname that only resolves to this machine. Handles the bracketed IPv6 form URL.hostname returns. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "[::1]" || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

export type GatewayUrlCheck =
  | { ok: true; url: string; local: boolean }
  | { ok: false; error: string };

/**
 * A buyer only talks to a remote gateway over TLS: over plain http a
 * man-in-the-middle can rewrite the 402 challenge and redirect the payment.
 * http:// is accepted for a gateway on this machine only.
 */
export function checkGatewayUrl(raw: string): GatewayUrlCheck {
  const s = raw.trim();
  if (!s) return { ok: false, error: "enter the gateway's MCP URL, for example https://gateway.example.com/mcp" };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "not a valid URL" };
  }
  if (u.username || u.password) return { ok: false, error: "remove the user name / password from the URL" };
  const local = isLoopbackHostname(u.hostname);
  if (u.protocol === "https:") return { ok: true, url: u.href, local };
  if (u.protocol === "http:") {
    if (local) return { ok: true, url: u.href, local };
    return {
      ok: false,
      error: "use https:// for a remote gateway: over plain http a man-in-the-middle can redirect your payments",
    };
  }
  return { ok: false, error: "the URL must start with https://" };
}
