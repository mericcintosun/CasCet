import { CONTRACTS, CSPR_LIVE_CONTRACT } from "../economy";

/**
 * Casper Testnet endpoints + the deployed RevenueSplit config.
 *
 * Testnet only: the package hashes, payees, token and cspr.live links below are
 * testnet values, so the chain name is fixed rather than read from the
 * environment (L26). Overriding it produced transactions that mixed networks.
 * CASPER_NODE_URL may point at another casper-test node; a node of any other
 * network rejects a casper-test transaction.
 */
export const NODE_URL = process.env.CASPER_NODE_URL ?? "https://node.testnet.casper.network/rpc";
export const CHAIN_NAME = "casper-test";

const DEFAULT_RELEASE_GAS_MOTES = 5_000_000_000;
/** Gas for the `release` call; a malformed RELEASE_GAS_MOTES falls back to the default instead of NaN. */
export const RELEASE_GAS_MOTES = positiveInt(process.env.RELEASE_GAS_MOTES, DEFAULT_RELEASE_GAS_MOTES);

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export const TOKEN_DECIMALS = 9;
export const TOKEN_SYMBOL = "WCSPR";

export const REVENUE_SPLIT_PACKAGE = CONTRACTS.revenueSplit;
export const DEMO_TOKEN_PACKAGE = CONTRACTS.demoToken;
/** CasCet's x402 token on testnet (Cep18X402, on-chain symbol WCSPR, 9 decimals): every testnet settlement until 2026-11-01. */
export const X402_TOKEN_PACKAGE = CONTRACTS.x402Token;
/**
 * The official Wrapped CSPR on testnet (CEP-3009, on-chain symbol WCSPR, 9
 * decimals). The real-payment demo pays in it too since 2026-11-02 and anchors
 * those receipts in the same ReceiptRegistry.
 */
export const WCSPR_TOKEN_PACKAGE = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";

export const CSPR_LIVE_TX = "https://testnet.cspr.live/transaction/";
export const CSPR_LIVE_ACCOUNT = "https://testnet.cspr.live/account/";
export { CSPR_LIVE_CONTRACT };

export interface Payee {
  label: string;
  /** "account-hash-…" — the on-chain payee key `release(account)` expects. */
  accountHash: string;
  /** Public key hex (used to match a connected wallet to a payee row). */
  publicKeyHex: string;
  /** Weight out of TOTAL_SHARES (immutable after the contract's init). */
  share: number;
}

export const TOTAL_SHARES = 100;

/** The two payees fixed at deploy time (60/40), enforced on-chain. */
export const PAYEES: Payee[] = [
  {
    label: "Deployer / operator",
    accountHash: "account-hash-fcf6bc94cef41aab24599669d62e919f0c65382a1bb734ae5e57706b997093ca",
    publicKeyHex: "01dd710d5083920b20c706a92d742c7bf9162d09c96fa373bd0a67b0bf51d3f183",
    share: 60,
  },
  {
    label: "Buildathon account",
    accountHash: "account-hash-a88a12ab6f3f7942ec3f9ddcc4c5fcc552a535604942f46cf712ddcdb40f903f",
    publicKeyHex: "0203865a0caf734d1620e8b938c0f086f2ab4c459e461bb0f9254d10d8ca5a05c172",
    share: 40,
  },
];

/** Find the payee a connected wallet corresponds to, if any. */
export function payeeForPublicKey(publicKeyHex: string): Payee | undefined {
  const k = publicKeyHex.toLowerCase();
  return PAYEES.find((p) => p.publicKeyHex.toLowerCase() === k);
}
