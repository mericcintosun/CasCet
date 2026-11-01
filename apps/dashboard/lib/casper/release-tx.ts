import "server-only";
import { HttpHandler, RpcClient } from "casper-js-sdk";
import { CHAIN_NAME, NODE_URL, PAYEES, RELEASE_GAS_MOTES, REVENUE_SPLIT_PACKAGE } from "./constants";
import { attachWalletSignature, buildUnsignedReleaseTx } from "./release-core";

export { RelayRejectedError } from "./release-core";

function rpc(): InstanceType<typeof RpcClient> {
  return new RpcClient(new HttpHandler(NODE_URL, "fetch"));
}

/**
 * Build an UNSIGNED `release(account)` TransactionV1 for the RevenueSplit contract,
 * paid by `fromPublicKeyHex` (the connected wallet). Returned as JSON for the wallet
 * to sign. `release` is permissionless — the connected account only pays gas; the
 * released tokens always go to `payeeAccountHash`.
 */
export function buildUnsignedRelease(payeeAccountHash: string, fromPublicKeyHex: string): unknown {
  return buildUnsignedReleaseTx(payeeAccountHash, fromPublicKeyHex, {
    packageHash: REVENUE_SPLIT_PACKAGE,
    chainName: CHAIN_NAME,
    paymentMotes: RELEASE_GAS_MOTES,
  }).toJSON();
}

/**
 * Attach a wallet signature to a prepared tx, verify it locally, and submit it;
 * resolves with the tx hash. Throws RelayRejectedError (a 400) before any RPC
 * call when the transaction or signature is not acceptable.
 */
export async function submitSigned(txJson: unknown, signatureHex: string, publicKeyHex: string): Promise<string> {
  const tx = attachWalletSignature(txJson, signatureHex, publicKeyHex, {
    packageHash: REVENUE_SPLIT_PACKAGE,
    chainName: CHAIN_NAME,
    allowedPayees: PAYEES.map((p) => p.accountHash),
  });
  const res = await rpc().putTransaction(tx);
  const h = res.transactionHash as { toHex?: () => string } | string;
  if (typeof h === "string") return h;
  if (h && typeof h.toHex === "function") return h.toHex();
  return JSON.stringify(res.transactionHash);
}
