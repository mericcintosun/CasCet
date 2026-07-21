import { CONTRACTS, CSPR_LIVE_CONTRACT } from "@/lib/economy";

/** Casper Testnet endpoints + the deployed RevenueSplit config. */
export const NODE_URL = process.env.CASPER_NODE_URL ?? "https://node.testnet.casper.network/rpc";
export const CHAIN_NAME = process.env.CASPER_CHAIN_NAME ?? "casper-test";
export const RELEASE_GAS_MOTES = Number(process.env.RELEASE_GAS_MOTES ?? "5000000000");

export const TOKEN_DECIMALS = 9;
export const TOKEN_SYMBOL = "WCSPR";

export const REVENUE_SPLIT_PACKAGE = CONTRACTS.revenueSplit;
export const DEMO_TOKEN_PACKAGE = CONTRACTS.demoToken;

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
