/** CAIP-2 network identifiers for Casper. */
export const NETWORK_CASPER_MAINNET = "casper:casper";
export const NETWORK_CASPER_TESTNET = "casper:casper-test";

/** x402 protocol headers (as used by @x402 packages). */
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

/**
 * CasCet cascade headers. A gateway returns the payment id of a settled call
 * in X-CASCET-PAYMENT-ID; when the paid tool itself buys from downstream paid
 * tools, the buyer client forwards that id as X-CASCET-PARENT-ID so the
 * downstream receipt links into the same payment chain.
 */
export const HEADER_CASCET_PAYMENT_ID = "x-cascet-payment-id";
export const HEADER_CASCET_PARENT_ID = "x-cascet-parent-id";

/**
 * Hosted x402 facilitator operated by MAKE Software on CSPR.cloud (mainnet and
 * testnet). The config schema applies it when `facilitator.url` is omitted.
 *
 * Limits, as of 2026-11:
 * - it needs a CSPR.cloud access token in `facilitator.apiKey`;
 * - it only settles CEP-3009 tokens whose `transfer_with_authorization` takes a
 *   `value` argument, such as the official Wrapped CSPR (see
 *   {@link KNOWN_CEP3009_ASSETS}).
 *
 * CasCet's own x402 token (testnet `hash-cb65a928…`, mainnet `hash-8dd4f1aa…`)
 * is the earlier reference build that takes `amount`, and
 * `@make-software/casper-x402` 1.0.0 still sends `amount`. Every hosted settle
 * against that token reverts with `User error: 64658` (Odra `MissingArg`), so a
 * gateway that sells it must use a self-hosted facilitator instead (see
 * {@link DEFAULT_SELF_HOSTED_FACILITATOR_URL}). The config schema refuses a
 * legacy-amount asset settled by this facilitator, and `cascet wrap` warns when
 * it is paired with any other asset that is not known to be CEP-3009.
 */
export const DEFAULT_FACILITATOR_URL = "https://x402-facilitator.cspr.cloud";

/**
 * Host of the hosted facilitator ({@link DEFAULT_FACILITATOR_URL}). It takes the
 * raw CSPR.cloud access key in the Authorization header (no "Bearer " prefix)
 * and only settles `cep3009-value` tokens.
 */
export const HOSTED_FACILITATOR_HOST = "x402-facilitator.cspr.cloud";

/** Whether `url` points at the hosted facilitator ({@link HOSTED_FACILITATOR_HOST}). False for anything unparsable. */
export function isHostedFacilitatorUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "") === HOSTED_FACILITATOR_HOST;
  } catch {
    return false;
  }
}

/**
 * Default address of CasCet's self-hosted facilitator
 * (`pnpm --filter @cascet/e2e facilitator` in a CasCet checkout). It is built on
 * `@make-software/casper-x402` 1.0.0, so it settles `amount`-style x402 tokens
 * such as CasCet's own, paying the gas from its own fee-payer key.
 */
export const DEFAULT_SELF_HOSTED_FACILITATOR_URL = "http://127.0.0.1:4501";

/**
 * CEP-18 contract packages known to implement CEP-3009
 * `transfer_with_authorization(from, to, value, …)`, i.e. tokens the hosted
 * facilitator can settle. Keyed by CAIP-2 network; bare lower-case package hashes.
 * Checked on-chain (read-only RPC) on 2026-11-01.
 */
export const KNOWN_CEP3009_ASSETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // Official Wrapped CSPR (WCSPR), contract version 3.
  [NETWORK_CASPER_MAINNET]: Object.freeze(["8df5d26790e18cf0404502c62ce5dc9025800ad6975c97466e20506c39c505b6"]),
  // Official Wrapped CSPR (WCSPR) on testnet, contract version 8.
  [NETWORK_CASPER_TESTNET]: Object.freeze(["3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e"]),
});

/** True when `packageHash` (with or without `hash-`) is a known CEP-3009 `value` token on `network`. */
export function isKnownCep3009Asset(network: string, packageHash: string): boolean {
  const bare = packageHash.trim().toLowerCase().replace(/^hash-/, "");
  return KNOWN_CEP3009_ASSETS[network]?.includes(bare) ?? false;
}

/** Default gateway port. */
export const DEFAULT_GATEWAY_PORT = 4402;
