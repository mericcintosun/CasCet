import "server-only";
import {
  HttpHandler,
  RpcClient,
  ContractCallBuilder,
  Args,
  CLValue,
  Key,
  PublicKey,
  Transaction,
} from "casper-js-sdk";
import { CHAIN_NAME, NODE_URL, RELEASE_GAS_MOTES, REVENUE_SPLIT_PACKAGE } from "./constants";

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
  const from = PublicKey.fromHex(fromPublicKeyHex);
  const args = Args.fromMap({ account: CLValue.newCLKey(Key.newKey(payeeAccountHash)) });
  const tx = new ContractCallBuilder()
    .byPackageHash(REVENUE_SPLIT_PACKAGE)
    .entryPoint("release")
    .runtimeArgs(args)
    .from(from)
    .chainName(CHAIN_NAME)
    .payment(RELEASE_GAS_MOTES)
    .build();
  return tx.toJSON();
}

function hexToBytes(hex: string): Uint8Array {
  let h = hex.startsWith("0x") ? hex.slice(2) : hex;
  // Casper Wallet may prefix the signature with a 1-byte key-algo tag (65 bytes total).
  if (h.length === 130) h = h.slice(2);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Attach a wallet signature to a prepared tx and submit it; resolves with the tx hash. */
export async function submitSigned(txJson: unknown, signatureHex: string, publicKeyHex: string): Promise<string> {
  const tx = Transaction.fromJSON(txJson);

  // Defence-in-depth: /submit must only relay the RevenueSplit `release` we
  // prepared, never an arbitrary transaction a caller pastes in. The wallet
  // only pays gas (release is permissionless), so this is not fund-loss today,
  // but it keeps the trust boundary correct if the design ever changes.
  const entryPoint = tx.entryPoint?.customEntryPoint;
  if (entryPoint !== "release") {
    throw new Error(`refusing to relay: unexpected entry point "${entryPoint ?? "?"}"`);
  }
  const pkg = REVENUE_SPLIT_PACKAGE.replace(/^hash-/, "").toLowerCase();
  if (!JSON.stringify(txJson).toLowerCase().includes(pkg)) {
    throw new Error("refusing to relay: transaction does not target the RevenueSplit contract");
  }

  const pub = PublicKey.fromHex(publicKeyHex);
  tx.setSignature(hexToBytes(signatureHex), pub);
  const res = await rpc().putTransaction(tx);
  const h = res.transactionHash as { toHex?: () => string } | string;
  if (typeof h === "string") return h;
  if (h && typeof h.toHex === "function") return h.toHex();
  return JSON.stringify(res.transactionHash);
}
