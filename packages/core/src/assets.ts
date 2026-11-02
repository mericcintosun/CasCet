import { NETWORK_CASPER_MAINNET, NETWORK_CASPER_TESTNET } from "./constants.js";

/**
 * Which `transfer_with_authorization` ABI a token implements. Both styles
 * verify the same EIP-712 message (`TransferWithAuthorization(address from,
 * address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32
 * nonce)`), so buyers sign both the same way; only the name of the amount
 * runtime argument the facilitator passes to the entry point differs:
 *
 * - `legacy-amount`: `amount` (U256). CasCet's own x402 token, the earlier
 *   reference build of the Casper x402 stack.
 * - `cep3009-value`: `value` (U256). CEP-3009 tokens such as the official
 *   Wrapped CSPR; the only style the hosted CSPR.cloud facilitator settles.
 */
export const AUTHORIZATION_STYLES = ["legacy-amount", "cep3009-value"] as const;
export type AuthorizationStyle = (typeof AUTHORIZATION_STYLES)[number];

/**
 * Key of the authorization style in an x402 `accepts` entry's `extra`. The
 * gateway sets it (server-owned: v2 matching makes the buyer echo it). Buyers
 * may prefer a style and must refuse values they do not know; facilitators
 * never trust it and read the token's ABI instead.
 */
export const AUTHORIZATION_STYLE_EXTRA_KEY = "authorizationStyle";

/** Whether `value` is one of {@link AUTHORIZATION_STYLES}. */
export function isAuthorizationStyle(value: unknown): value is AuthorizationStyle {
  return typeof value === "string" && (AUTHORIZATION_STYLES as readonly string[]).includes(value);
}

/**
 * Bare, lower-case contract package hash: trims and drops a "hash-",
 * "contract-package-", "package-" or "0x" prefix. Does not validate; a package
 * hash is 64 hex characters ({@link isPackageHash}).
 */
export function normalizePackageHash(value: string): string {
  return value.trim().toLowerCase().replace(/^(?:hash-|contract-package-|package-|0x)/, "");
}

/** Whether `value` is a bare 64-hex contract package hash (as {@link normalizePackageHash} returns it). */
export function isPackageHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * Known tokens whose `transfer_with_authorization` takes `amount`: bare package
 * hash → CAIP-2 network. Both are CasCet's x402 token (Cep18X402, name
 * "CasCet X402 Token"); their ABI was read on-chain (read-only RPC) on 2026-11-01.
 */
export const LEGACY_AMOUNT_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3: NETWORK_CASPER_TESTNET,
  "8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41": NETWORK_CASPER_MAINNET,
});

/** Whether `packageHash` (any prefix or case) is a known `legacy-amount` token. */
export function isLegacyAmountToken(packageHash: string): boolean {
  return Object.hasOwn(LEGACY_AMOUNT_TOKENS, normalizePackageHash(packageHash));
}

/**
 * Style assumed for a token when the config does not name one: known legacy
 * tokens are `legacy-amount`, every other token `cep3009-value` (the standard).
 * Facilitators still read the token's ABI on-chain before they settle.
 */
export function defaultAuthorizationStyle(packageHash: string): AuthorizationStyle {
  return isLegacyAmountToken(packageHash) ? "legacy-amount" : "cep3009-value";
}

/**
 * Default gas limit (motes) of one settlement transaction per style, for
 * facilitators that settle it themselves. Casper charges the whole limit when
 * a transaction reverts (and refunds part of the unused limit on success), so
 * the limit is a measured consumption plus headroom, never a library default:
 *
 * - `legacy-amount`: 4 CSPR. Measured consumption about 2.70 CSPR (testnet and
 *   mainnet; testnet tx 2b031102… consumed 2.69 CSPR), so @x402/casper's
 *   2.5 CSPR default would run out of gas.
 * - `cep3009-value`: 2.5 CSPR. CasCet's own Wrapped CSPR settles consumed
 *   1.117–1.118 CSPR on testnet on 2026-11-02 (tx fd667f19…, 660784c8…,
 *   43bba5ed…, the first one also creating the payee's balance entry), and the
 *   hosted facilitator's 1.13 CSPR. 2.5 CSPR is about 2.2 × that and the limit
 *   the hosted facilitator sets for the same call; ceil(1.3 × max) would be
 *   1.46 CSPR, but a revert loses the payment and burns the whole limit, while
 *   the lower limit would save only about 0.25 CSPR per settle.
 */
export const DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE: Readonly<Record<AuthorizationStyle, number>> = Object.freeze({
  "legacy-amount": 4_000_000_000,
  "cep3009-value": 2_500_000_000,
});
