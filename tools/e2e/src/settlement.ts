import casperSdk from "casper-js-sdk";
import { isAuthorizationStyle, type AuthorizationStyle } from "@cascet/core";
import { isNoSuchTransaction, RpcNodeError, type CasperRpc } from "@cascet/gateway";

const { Args, CLValue, CLTypeUInt8, ContractCallBuilder, Key, PublicKey, Timestamp, TransactionWrapper } = casperSdk;
type PrivateKeyT = InstanceType<typeof casperSdk.PrivateKey>;

/**
 * Building, submitting and following the `transfer_with_authorization`
 * settlement transaction (M22): the one settlement path of the self-hosted
 * facilitator, for both authorization styles.
 *
 * Both styles take the same arguments with the same CLTypes; only the name of
 * the U256 amount differs (see {@link AMOUNT_ARGUMENT_BY_STYLE}):
 *  - `legacy-amount` (CasCet's x402 token): `amount`, exactly as
 *    @make-software/casper-x402 1.0.0 builds it; a unit test rebuilds settled
 *    testnet tx 04e54a95… byte for byte;
 *  - `cep3009-value` (the official Wrapped CSPR and other CEP-3009 tokens):
 *    `value`, exactly as @x402/casper 2.29 (the hosted facilitator) builds it;
 *    a unit test rebuilds the hosted facilitator's testnet tx 9fe35eed… byte
 *    for byte.
 * The facilitator core takes the style from the token's on-chain ABI: the
 * wrong name reverts on-chain (Odra `MissingArg`, User error 64658) and burns
 * the whole gas limit. What changes around the transaction:
 *  - submission failures are classified: a JSON-RPC error means the node
 *    rejected the transaction (nothing was submitted); a transport failure
 *    means it may or may not have been accepted (outcome unknown);
 *  - polling never turns a transient RPC error or a "no such transaction" from
 *    a lagging node into a failure: it retries with backoff until a deadline
 *    and then reports the transaction as pending, with its hash;
 *  - the transaction's TTL is set per settlement so that it expires before the
 *    authorization does (it cannot execute, revert and burn gas after validBefore).
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

/** How one settlement transaction is built. */
export interface SettlementSettings {
  /** The token's authorization style (read from its on-chain ABI): the amount argument's name. */
  style: AuthorizationStyle;
  /** Gas limit (motes) of the transaction: the asset's own limit. */
  paymentMotes: bigint;
  /**
   * This transaction's TTL: the core caps it so the transaction expires before
   * the authorization does; it is capped again at the chain maximum
   * ({@link SettlementChain.txTtlMs}) and rounded down to whole seconds.
   */
  ttlMs: number;
}

/** The chain operations the facilitator core needs (a fake implements this in tests). */
export interface SettlementChain {
  readonly feePayerAccountHash: string;
  readonly feePayerPublicKey: string;
  /** Maximum TTL of a settlement transaction (how long it may still be included). */
  readonly txTtlMs: number;
  /** Build and sign a settlement. */
  build(input: SettlementInput, settings: SettlementSettings): BuiltTransaction;
  submit(tx: BuiltTransaction): Promise<SubmitOutcome>;
  waitForExecution(hash: string, deadlineMs: number): Promise<ExecutionOutcome>;
}

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const u8List = (bytes: Uint8Array) => CLValue.newCLList(CLTypeUInt8, Array.from(bytes).map(b => CLValue.newCLUint8(b)));

/**
 * Name of the U256 amount argument of `transfer_with_authorization` per
 * authorization style. Everything else about the call is identical.
 */
export const AMOUNT_ARGUMENT_BY_STYLE: Readonly<Record<AuthorizationStyle, "amount" | "value">> = Object.freeze({
  "legacy-amount": "amount",
  "cep3009-value": "value",
});

/**
 * The authorization styles this builder settles: every style it has an amount
 * argument for. demo-real refuses a token whose style is not listed here.
 */
export const SETTLEABLE_STYLES: readonly AuthorizationStyle[] = Object.freeze(
  Object.keys(AMOUNT_ARGUMENT_BY_STYLE) as AuthorizationStyle[],
);

/** The amount argument's name for `style`; throws for anything that is not a known style. */
export function amountArgumentName(style: AuthorizationStyle): "amount" | "value" {
  if (!isAuthorizationStyle(style)) throw new Error(`unknown authorization style: ${String(style).slice(0, 40)}`);
  return AMOUNT_ARGUMENT_BY_STYLE[style];
}

/**
 * Runtime args of `transfer_with_authorization` in `style`: identical to
 * casper-x402 1.0.0 for `legacy-amount` and to @x402/casper 2.29 for
 * `cep3009-value` (same order, same CLTypes; only the amount's name differs).
 */
export function transferWithAuthorizationArgs(input: SettlementInput, style: AuthorizationStyle) {
  const amountArgument = amountArgumentName(style);
  return Args.fromMap({
    from: CLValue.newCLKey(Key.newKey(`account-hash-${input.from.slice(2).toLowerCase()}`)),
    to: CLValue.newCLKey(Key.newKey(`account-hash-${input.to.slice(2).toLowerCase()}`)),
    [amountArgument]: CLValue.newCLUInt256(input.value.toString()),
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
  /** The token's authorization style: decides the amount argument's name. */
  style: AuthorizationStyle;
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
    .runtimeArgs(transferWithAuthorizationArgs(input, opts.style))
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
  /**
   * Maximum transaction TTL. Default 10 minutes. Each settlement's TTL is also
   * capped at its authorization's validBefore (see `build`).
   */
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

    build(input, { style, paymentMotes, ttlMs: requestedTtlMs }) {
      // Whole seconds: the node parses the TTL as a duration string ("4m 57s").
      const txTtl = Math.floor(Math.min(requestedTtlMs, ttlMs) / 1000) * 1000;
      if (!(txTtl >= 1000)) throw new Error(`settlement TTL must be at least 1 s, got ${requestedTtlMs} ms`);
      if (paymentMotes <= 0n || paymentMotes > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`settlement gas limit out of range: ${paymentMotes} motes`);
      }
      const tx = buildSettlementTransaction(input, { feePayerPublicKey, chainName: opts.chainName, style, paymentMotes, ttlMs: txTtl });
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
