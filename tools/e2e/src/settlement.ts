import casperSdk from "casper-js-sdk";
import { isNoSuchTransaction, RpcNodeError, type CasperRpc } from "./casper-rpc.js";

const { Args, CLValue, CLTypeUInt8, ContractCallBuilder, Key, PublicKey, Timestamp, TransactionWrapper } = casperSdk;
type PrivateKeyT = InstanceType<typeof casperSdk.PrivateKey>;

/**
 * Building, submitting and following the `transfer_with_authorization`
 * settlement transaction (M22).
 *
 * The transaction is built exactly like @make-software/casper-x402 1.0.0 builds
 * it (same entry point, same `amount` argument name the CasCet token expects,
 * same CLTypes); a unit test rebuilds settled testnet tx 04e54a95… byte for
 * byte. What changes is everything around it:
 *  - submission failures are classified: a JSON-RPC error means the node
 *    rejected the transaction (nothing was submitted); a transport failure
 *    means it may or may not have been accepted (outcome unknown);
 *  - polling never turns a transient RPC error or a "no such transaction" from
 *    a lagging node into a failure: it retries with backoff until a deadline
 *    and then reports the transaction as pending, with its hash.
 */

/** Validated authorization fields needed to build the settlement. */
export interface SettlementInput {
  /** CEP-18 package hash, 64 hex. */
  asset: string;
  /** Payer, "00" + 64 hex. */
  from: string;
  /** Payee, "00" + 64 hex. */
  to: string;
  value: bigint;
  validAfter: number;
  validBefore: number;
  /** 64 hex. */
  nonce: string;
  /** Payer public key hex (with algorithm tag). */
  publicKey: string;
  /** 65-byte signature hex (algorithm tag + 64 bytes). */
  signature: string;
}

export interface BuiltTransaction {
  hash: string;
  /** `TransactionWrapper` JSON, as `account_put_transaction` expects it. */
  json: unknown;
}

export type SubmitOutcome =
  | { kind: "accepted"; hash: string }
  | { kind: "rejected"; error: string }
  | { kind: "unknown"; hash: string; error: string };

export type ExecutionOutcome =
  | { kind: "success"; costMotes?: bigint; blockHeight?: number }
  | { kind: "failure"; errorMessage: string; costMotes?: bigint; blockHeight?: number }
  | { kind: "pending"; seen: boolean; lastError?: string };

/** The chain operations the facilitator core needs (a fake implements this in tests). */
export interface SettlementChain {
  readonly feePayerAccountHash: string;
  readonly feePayerPublicKey: string;
  /** How long a submitted transaction may still be included (its TTL). */
  readonly txTtlMs: number;
  build(input: SettlementInput, paymentMotes: bigint): BuiltTransaction;
  submit(tx: BuiltTransaction): Promise<SubmitOutcome>;
  waitForExecution(hash: string, deadlineMs: number): Promise<ExecutionOutcome>;
}

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const u8List = (bytes: Uint8Array) => CLValue.newCLList(CLTypeUInt8, Array.from(bytes).map(b => CLValue.newCLUint8(b)));

/** Runtime args of `transfer_with_authorization`, identical to casper-x402 1.0.0. */
export function transferWithAuthorizationArgs(input: SettlementInput) {
  return Args.fromMap({
    from: CLValue.newCLKey(Key.newKey(`account-hash-${input.from.slice(2).toLowerCase()}`)),
    to: CLValue.newCLKey(Key.newKey(`account-hash-${input.to.slice(2).toLowerCase()}`)),
    // The CasCet token is the pre-CEP-3009-rename build: the argument is `amount`, not `value`.
    amount: CLValue.newCLUInt256(input.value.toString()),
    valid_after: CLValue.newCLUint64(input.validAfter),
    valid_before: CLValue.newCLUint64(input.validBefore),
    nonce: u8List(hexToBytes(input.nonce)),
    public_key: CLValue.newCLPublicKey(PublicKey.fromHex(input.publicKey)),
    signature: u8List(hexToBytes(input.signature)),
  });
}

export interface BuildOptions {
  feePayerPublicKey: string;
  chainName: string;
  paymentMotes: bigint;
  ttlMs: number;
  /** Fixed timestamp (tests); defaults to now. */
  timestamp?: Date;
}

/** Build the (unsigned) settlement transaction. */
export function buildSettlementTransaction(input: SettlementInput, opts: BuildOptions) {
  const builder = new ContractCallBuilder()
    .from(PublicKey.fromHex(opts.feePayerPublicKey))
    .byPackageHash(input.asset)
    .entryPoint("transfer_with_authorization")
    .runtimeArgs(transferWithAuthorizationArgs(input))
    .chainName(opts.chainName)
    .payment(Number(opts.paymentMotes))
    .ttl(opts.ttlMs);
  if (opts.timestamp) builder.timestamp(new Timestamp(opts.timestamp));
  return builder.build();
}

/** Net motes the payer was charged: cost − refund when both are known. */
export function netCostMotes(cost: unknown, refund: unknown): bigint | undefined {
  const c = typeof cost === "string" && /^\d+$/.test(cost) ? BigInt(cost) : undefined;
  if (c === undefined) return undefined;
  const r = typeof refund === "string" && /^\d+$/.test(refund) ? BigInt(refund) : 0n;
  return c >= r ? c - r : c;
}

/** Interpret `execution_info` from `info_get_transaction`; `undefined` while not executed yet. */
export function parseExecutionInfo(info: unknown): Exclude<ExecutionOutcome, { kind: "pending" }> | undefined {
  if (typeof info !== "object" || info === null) return undefined;
  const ei = info as { block_height?: unknown; execution_result?: unknown };
  const result = ei.execution_result as Record<string, unknown> | null | undefined;
  if (!result || typeof result !== "object") return undefined;
  const blockHeight = typeof ei.block_height === "number" ? ei.block_height : undefined;
  const at = blockHeight !== undefined ? { blockHeight } : {};

  const v2 = result["Version2"] as { error_message?: unknown; cost?: unknown; refund?: unknown } | undefined;
  if (v2 && typeof v2 === "object") {
    const cost = netCostMotes(v2.cost, v2.refund);
    const costPart = cost !== undefined ? { costMotes: cost } : {};
    if (typeof v2.error_message === "string" && v2.error_message.length > 0) {
      return { kind: "failure", errorMessage: v2.error_message, ...costPart, ...at };
    }
    return { kind: "success", ...costPart, ...at };
  }
  const v1 = result["Version1"] as Record<string, { error_message?: unknown; cost?: unknown }> | undefined;
  if (v1 && typeof v1 === "object") {
    if (v1["Failure"]) {
      const cost = netCostMotes(v1["Failure"].cost, undefined);
      return {
        kind: "failure",
        errorMessage: String(v1["Failure"].error_message ?? "execution failed"),
        ...(cost !== undefined ? { costMotes: cost } : {}),
        ...at,
      };
    }
    if (v1["Success"]) {
      const cost = netCostMotes(v1["Success"].cost, undefined);
      return { kind: "success", ...(cost !== undefined ? { costMotes: cost } : {}), ...at };
    }
  }
  return undefined;
}

export interface CasperSettlementChainOptions {
  rpc: CasperRpc;
  privateKey: PrivateKeyT;
  chainName: string;
  /** Transaction TTL. Default 10 minutes (bounds how long a pending settle can still land). */
  ttlMs?: number;
  /** Backoff schedule between polls; the last value repeats. */
  pollDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * JSON-RPC errors on `account_put_transaction` that prove the node did NOT
 * accept the transaction (casper-sidecar codes): invalid transaction/deploy,
 * and malformed requests. Anything else is treated as "may have been accepted".
 */
export const DEFINITE_REJECTION_CODES = new Set([-32016, -32008, -32602, -32600, -32601]);

export function createCasperSettlementChain(opts: CasperSettlementChainOptions): SettlementChain {
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const delays = opts.pollDelaysMs && opts.pollDelaysMs.length > 0 ? opts.pollDelaysMs : [1000, 1500, 2000, 3000];
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const feePayerPublicKey = opts.privateKey.publicKey.toHex();
  const feePayerAccountHash = opts.privateKey.publicKey.accountHash().toHex();

  return {
    feePayerAccountHash,
    feePayerPublicKey,
    txTtlMs: ttlMs,

    build(input, paymentMotes) {
      const tx = buildSettlementTransaction(input, { feePayerPublicKey, chainName: opts.chainName, paymentMotes, ttlMs });
      tx.sign(opts.privateKey);
      return { hash: tx.hash.toHex(), json: TransactionWrapper.toJSON(tx.getTransactionWrapper()) };
    },

    async submit(tx) {
      try {
        const result = await opts.rpc.call<{ transaction_hash?: Record<string, unknown> }>("account_put_transaction", {
          transaction: tx.json,
        });
        const returned = result?.transaction_hash?.["Version1"] ?? result?.transaction_hash?.["Deploy"];
        if (typeof returned === "string" && /^[0-9a-f]{64}$/i.test(returned) && returned.toLowerCase() !== tx.hash) {
          // Should never happen (the hash covers the payload); trust the node's view.
          opts.log?.(`node returned transaction hash ${returned.slice(0, 16)}… for local ${tx.hash.slice(0, 16)}…`);
          return { kind: "accepted", hash: returned.toLowerCase() };
        }
        return { kind: "accepted", hash: tx.hash };
      } catch (err) {
        if (err instanceof RpcNodeError && DEFINITE_REJECTION_CODES.has(err.code)) {
          return { kind: "rejected", error: describe(err) };
        }
        // Transport failure, or a node/proxy error that does not prove rejection
        // (e.g. -32018 "Node request failure"): it may have been accepted.
        return { kind: "unknown", hash: tx.hash, error: describe(err) };
      }
    },

    async waitForExecution(hash, deadlineMs) {
      let seen = false;
      let lastError: string | undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await opts.rpc.call<{ execution_info?: unknown }>("info_get_transaction", {
            transaction_hash: { Version1: hash },
            finalized_approvals: false,
          });
          seen = true;
          const outcome = parseExecutionInfo(result?.execution_info);
          if (outcome) return outcome;
        } catch (err) {
          // Every error is transient while polling: "No such transaction" from a
          // lagging or load-balanced node, other node errors, timeouts and network
          // failures. None of them says the transfer did not happen, so keep
          // polling until the deadline and then report "pending" with the hash.
          lastError = isNoSuchTransaction(err) ? "transaction not yet known to the node" : describe(err);
        }
        const remaining = deadlineMs - now();
        if (remaining <= 0) return { kind: "pending", seen, ...(lastError ? { lastError } : {}) };
        await sleep(Math.min(delays[Math.min(attempt, delays.length - 1)]!, remaining));
      }
    },
  };
}
