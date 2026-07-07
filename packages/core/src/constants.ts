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

/** Hosted facilitator operated by MAKE Software (mainnet + testnet). */
export const DEFAULT_FACILITATOR_URL = "https://x402-facilitator.cspr.cloud";

/** Default gateway port. */
export const DEFAULT_GATEWAY_PORT = 4402;
