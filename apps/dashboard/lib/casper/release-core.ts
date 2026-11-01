import { Args, CLValue, ContractCallBuilder, Key, PublicKey, Transaction } from "casper-js-sdk";
import { SignatureFormatError, toApprovalSignature } from "./signature";

/**
 * Network-free core of the RevenueSplit withdraw flow: build the unsigned
 * `release(account)` transaction and turn a wallet signature into a signed,
 * verified transaction. Kept free of `server-only` and RPC so it is unit-tested
 * directly; `release-tx.ts` wires it to the node.
 */

/** A client mistake (bad signature, foreign transaction): the API answers 400 with this message. */
export class RelayRejectedError extends Error {
  override name = "RelayRejectedError";
}

/**
 * The node did not answer the submission in time (the API answers 504). The
 * transaction may still have been accepted, so the hash goes back to the
 * client to look up before it tries again.
 */
export class RelayTimeoutError extends Error {
  override name = "RelayTimeoutError";
  constructor(
    readonly txHash: string,
    readonly timeoutMs: number,
  ) {
    super(`the Casper node did not answer within ${Math.round(timeoutMs / 1000)} s`);
  }
}

export interface ReleaseParams {
  /** RevenueSplit contract package hash (bare hex or "hash-" prefixed). */
  packageHash: string;
  chainName: string;
  paymentMotes: number;
}

export interface RelayPolicy {
  packageHash: string;
  chainName: string;
  /** "account-hash-…" payees a release may name. */
  allowedPayees: readonly string[];
}

const bareHash = (h: string): string => h.trim().toLowerCase().replace(/^hash-/, "");

/**
 * Build an UNSIGNED `release(account)` TransactionV1, paid by `fromPublicKeyHex`
 * (the connected wallet). `release` is permissionless: the wallet only pays gas
 * and the released tokens always go to `payeeAccountHash`.
 */
export function buildUnsignedReleaseTx(payeeAccountHash: string, fromPublicKeyHex: string, p: ReleaseParams): Transaction {
  const from = PublicKey.fromHex(fromPublicKeyHex);
  const args = Args.fromMap({ account: CLValue.newCLKey(Key.newKey(payeeAccountHash)) });
  return new ContractCallBuilder()
    .byPackageHash(bareHash(p.packageHash))
    .entryPoint("release")
    .runtimeArgs(args)
    .from(from)
    .chainName(p.chainName)
    .payment(p.paymentMotes)
    .build();
}

/**
 * Check that `txJson` is exactly the kind of transaction /withdraw prepares, add
 * the wallet signature in Casper's tagged approval format, and verify it.
 * Throws RelayRejectedError for anything a client could have got wrong; never
 * touches the network.
 */
export function attachWalletSignature(
  txJson: unknown,
  signatureHex: string,
  publicKeyHex: string,
  policy: RelayPolicy,
): Transaction {
  let tx: Transaction;
  try {
    tx = Transaction.fromJSON(txJson);
  } catch {
    throw new RelayRejectedError("malformed transaction JSON");
  }
  let pub: PublicKey;
  try {
    pub = PublicKey.fromHex(publicKeyHex);
  } catch {
    throw new RelayRejectedError("invalid public key");
  }

  // Only ever relay the RevenueSplit `release` this app prepares — never an
  // arbitrary transaction a caller pastes in.
  const entryPoint = tx.entryPoint?.customEntryPoint;
  if (entryPoint !== "release") {
    throw new RelayRejectedError(`refusing to relay: unexpected entry point "${entryPoint ?? "?"}"`);
  }
  const target = tx.target?.stored?.id?.byPackageHash?.addr?.toHex()?.toLowerCase();
  if (target !== bareHash(policy.packageHash)) {
    throw new RelayRejectedError("refusing to relay: transaction does not target the RevenueSplit contract");
  }
  if (tx.chainName !== policy.chainName) {
    throw new RelayRejectedError(`refusing to relay: chain "${tx.chainName}" is not "${policy.chainName}"`);
  }
  let payee: string | undefined;
  try {
    payee = tx.args?.getByName("account")?.key?.toPrefixedString();
  } catch {
    payee = undefined;
  }
  if (!payee || !policy.allowedPayees.includes(payee)) {
    throw new RelayRejectedError("refusing to relay: release names an unknown payee");
  }
  const initiator = tx.initiatorAddr?.publicKey?.toHex()?.toLowerCase();
  if (initiator !== pub.toHex().toLowerCase()) {
    throw new RelayRejectedError("refusing to relay: the transaction's initiator is not the signing key");
  }
  if ((tx.approvals?.length ?? 0) > 0) {
    throw new RelayRejectedError("refusing to relay: the transaction already carries approvals");
  }

  let signature: Uint8Array;
  try {
    signature = toApprovalSignature(signatureHex, pub.cryptoAlg);
  } catch (e) {
    throw new RelayRejectedError(e instanceof SignatureFormatError ? e.message : "malformed signature");
  }
  tx.setSignature(signature, pub);

  // validate() checks the hash against the payload and every approval
  // signature against the hash (and throws, rather than returning false, on a
  // bad signature).
  let valid = false;
  try {
    valid = tx.validate();
  } catch {
    valid = false;
  }
  if (!valid) throw new RelayRejectedError("signature does not verify for this transaction and key");
  return tx;
}
