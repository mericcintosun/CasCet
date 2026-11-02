import "server-only";
import { CONTRACTS, ONCHAIN_NETWORK } from "../economy";
import { NODE_URL } from "./constants";
import { testnetReceiptToken } from "./receipt-token";
import { readRegistryReceipts, type RegistryReadResult } from "./registry-reader";
import { createSettleTokenReader } from "./settle-token";

export { OnchainReadError } from "./registry-reader";

const CSPR_CLOUD_API = process.env.CSPR_CLOUD_API ?? "https://api.testnet.cspr.cloud";

/**
 * Records anchored on 2026-07-07 while the chain-free mock facilitator was
 * still in use: their settle hashes were never submitted, so they don't exist
 * on-chain. Hidden so every receipt shown resolves on cspr.live.
 */
const UNSETTLED_FIXTURE_IDS: ReadonlySet<string> = new Set([
  "80703d47-4a0a-4d4f-9cfb-3bc8e2b8903d",
  "8b805540-f598-420c-8642-cdfbe571599d",
  "a7cd779c-bcd9-4497-874d-e59b1aacf8c9",
  "bbaa6fa0-a2fa-47f8-8087-88b8c659945a",
  "e05e3e02-d737-45a7-a4d5-dfc163c9ab65",
]);

/** The token of each settlement, read from the chain once per server: it never changes. */
const readSettleToken = createSettleTokenReader({ nodeUrl: NODE_URL });

/**
 * Every settled receipt anchored in the TESTNET ReceiptRegistry. Throws
 * OnchainReadError when the read cannot be trusted (no token, upstream error,
 * timeout) instead of returning an empty list.
 */
export function readAnchoredReceipts(): Promise<RegistryReadResult> {
  return readRegistryReceipts({
    token: process.env.CSPR_CLOUD_TOKEN,
    apiBase: CSPR_CLOUD_API,
    registryPackageHash: CONTRACTS.receiptRegistry,
    network: ONCHAIN_NETWORK,
    // A record names no token, and this registry holds receipts in Cep18X402 and in Wrapped CSPR.
    tokenOf: testnetReceiptToken(readSettleToken),
    excludedIds: UNSETTLED_FIXTURE_IDS,
  });
}
