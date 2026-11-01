import { DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE, type AuthorizationStyle } from "@cascet/core";
import { isNoSuchTransaction, type CasperRpc } from "@cascet/gateway";
import { formatCspr } from "./amounts.js";

/**
 * Measured gas: what a transaction really cost, read back from the chain
 * (read-only `info_get_transaction`), so gas limits can be set from
 * measurements instead of library defaults.
 *
 * Casper 2.0 pricing on testnet and mainnet (chainspec, 2026-11):
 *  - payment_limited: the sender names a gas limit and is charged
 *    `cost` = limit × gas price up front (the gas price has been 1);
 *  - refund 75/100: on success, 75% of the unused part (cost − consumed) is
 *    refunded; a reverted transaction gets no refund (testnet 9fe35eed…:
 *    6 CSPR limit, 0.0097 consumed, refund 0);
 *  - fees are burned.
 * So a successful transaction costs consumed + 25% × (limit − consumed), and a
 * reverted one its whole limit: a tight limit is cheap until it runs out.
 */

/** Share of the unused gas refunded on success (chainspec `refund_handling`, testnet and mainnet). */
export const REFUND_RATIO = Object.freeze({ numerator: 75n, denominator: 100n });

/** Headroom over the largest measured consumption when suggesting a limit: ceil(1.3 × max). */
export const SUGGESTED_HEADROOM_PERCENT = 130;
/** Suggested limits are rounded up to 0.01 CSPR. */
export const SUGGESTED_STEP_MOTES = 10_000_000n;
/**
 * Casper's baseline payment, the chainspec's `baseline_motes_amount` (2.5 CSPR):
 * a deploy must pay at least this much and a transaction's initiator must hold
 * at least this much, and none of 418 recorded testnet transactions (CasCet's
 * deployer, Wrapped CSPR, csprUSD, the hosted fee payer) uses a lower limit
 * (the hosted facilitator settles with exactly 2.5 CSPR). Suggestions never go below it.
 */
export const BASELINE_PAYMENT_MOTES = 2_500_000_000n;

/** Gas figures of one executed transaction, in motes. */
export interface TransactionCost {
  status: "success" | "failure";
  errorMessage?: string;
  /** Gas limit (execution results of Casper 2.0 only). */
  limitMotes?: bigint;
  /** Gas used. */
  consumedMotes?: bigint;
  /** Charged up front: limit × gas price. */
  costMotes?: bigint;
  /** Given back after execution (0 when it reverted). */
  refundMotes?: bigint;
  /** What the payer lost: cost − refund. */
  netMotes?: bigint;
  gasPrice?: number;
  blockHeight?: number;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function motes(value: unknown): bigint | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return undefined;
}

/** cost − refund; the cost alone when the refund is unknown or larger (never negative). */
function net(cost: bigint | undefined, refund: bigint | undefined): bigint | undefined {
  if (cost === undefined) return undefined;
  if (refund === undefined || refund > cost) return cost;
  return cost - refund;
}

/**
 * Gas figures from `execution_info` of `info_get_transaction`; undefined while
 * the transaction has not executed. Casper 2.0 results (`Version2`) carry
 * limit, consumed, cost and refund; 1.x results (`Version1`) only a cost.
 */
export function parseTransactionCost(executionInfo: unknown): TransactionCost | undefined {
  if (!isObject(executionInfo)) return undefined;
  const result = executionInfo["execution_result"];
  if (!isObject(result)) return undefined;
  const blockHeight = typeof executionInfo["block_height"] === "number" ? executionInfo["block_height"] : undefined;
  const at = blockHeight !== undefined ? { blockHeight } : {};

  const v2 = result["Version2"];
  if (isObject(v2)) {
    const errorMessage = typeof v2["error_message"] === "string" && v2["error_message"] ? v2["error_message"] : undefined;
    const limitMotes = motes(v2["limit"]);
    const consumedMotes = motes(v2["consumed"]);
    const costMotes = motes(v2["cost"]);
    const refundMotes = motes(v2["refund"]);
    const netMotes = net(costMotes, refundMotes);
    const gasPrice = typeof v2["current_price"] === "number" ? v2["current_price"] : undefined;
    return {
      status: errorMessage ? "failure" : "success",
      ...(errorMessage ? { errorMessage } : {}),
      ...(limitMotes !== undefined ? { limitMotes } : {}),
      ...(consumedMotes !== undefined ? { consumedMotes } : {}),
      ...(costMotes !== undefined ? { costMotes } : {}),
      ...(refundMotes !== undefined ? { refundMotes } : {}),
      ...(netMotes !== undefined ? { netMotes } : {}),
      ...(gasPrice !== undefined ? { gasPrice } : {}),
      ...at,
    };
  }

  const v1 = result["Version1"];
  if (isObject(v1)) {
    const failure = v1["Failure"];
    const success = v1["Success"];
    const outcome = isObject(failure) ? failure : isObject(success) ? success : undefined;
    if (!outcome) return undefined;
    const costMotes = motes(outcome["cost"]);
    const failed = outcome === failure;
    return {
      status: failed ? "failure" : "success",
      ...(failed ? { errorMessage: String(outcome["error_message"] ?? "execution failed") } : {}),
      ...(costMotes !== undefined ? { costMotes, netMotes: costMotes } : {}),
      ...at,
    };
  }
  return undefined;
}

/** Refund of a successful transaction: 75% of (limit − consumed), rounded down like the node. */
export function expectedRefundMotes(limitMotes: bigint, consumedMotes: bigint, ratio = REFUND_RATIO): bigint {
  if (consumedMotes >= limitMotes) return 0n;
  return ((limitMotes - consumedMotes) * ratio.numerator) / ratio.denominator;
}

/** Net cost of a successful transaction: limit − refund = consumed + 25% × (limit − consumed). */
export function expectedNetMotes(limitMotes: bigint, consumedMotes: bigint, ratio = REFUND_RATIO): bigint {
  return limitMotes - expectedRefundMotes(limitMotes, consumedMotes, ratio);
}

/**
 * A gas limit from measured consumption: ceil(headroom × max consumed),
 * rounded up to `stepMotes` (default 1.3 × max, to 0.01 CSPR).
 */
export function suggestGasLimitMotes(
  consumed: readonly bigint[],
  opts: { headroomPercent?: number; stepMotes?: bigint } = {},
): bigint {
  if (consumed.length === 0) throw new Error("no measured consumption to base a limit on");
  const headroom = opts.headroomPercent ?? SUGGESTED_HEADROOM_PERCENT;
  const step = opts.stepMotes ?? SUGGESTED_STEP_MOTES;
  if (!Number.isInteger(headroom) || headroom < 100) throw new Error("headroomPercent must be a whole number of at least 100");
  if (step <= 0n) throw new Error("stepMotes must be positive");
  const max = consumed.reduce((a, b) => (b > a ? b : a));
  const scaled = (max * BigInt(headroom) + 99n) / 100n;
  return ((scaled + step - 1n) / step) * step;
}

/** What a transaction did, read from its entry point and arguments. */
export type TransactionKind =
  | { kind: "settle"; style?: AuthorizationStyle; asset?: string }
  | { kind: "anchor"; registry?: string }
  | { kind: "wrap"; asset?: string }
  | { kind: "transfer"; asset?: string }
  | { kind: "other"; entryPoint?: string };

interface NamedArg {
  cl_type?: unknown;
  parsed?: unknown;
  bytes?: unknown;
}

/** `[[name, CLValue], …]` (deploys) or `{ Named: [[name, CLValue], …] }` (Version1 transactions). */
function namedArgs(args: unknown): Map<string, NamedArg> {
  const list = isObject(args) && Array.isArray(args["Named"]) ? args["Named"] : Array.isArray(args) ? args : [];
  const out = new Map<string, NamedArg>();
  for (const entry of list) {
    if (Array.isArray(entry) && typeof entry[0] === "string") out.set(entry[0], isObject(entry[1]) ? (entry[1] as NamedArg) : {});
  }
  return out;
}

function byEntryPoint(entryPoint: string | undefined, args: Map<string, NamedArg>, contract: string | undefined): TransactionKind {
  const at = contract ? { asset: contract } : {};
  switch (entryPoint) {
    case "transfer_with_authorization": {
      // The style the transaction used, i.e. the argument name the facilitator sent.
      const style = args.has("value") ? "cep3009-value" : args.has("amount") ? "legacy-amount" : undefined;
      return { kind: "settle", ...(style ? { style } : {}), ...at };
    }
    case "record":
      return { kind: "anchor", ...(contract ? { registry: contract } : {}) };
    case "transfer":
      return { kind: "transfer", ...at };
    default:
      return { kind: "other", ...(entryPoint ? { entryPoint } : {}) };
  }
}

/**
 * Classify the `transaction` of an `info_get_transaction` answer: a settle
 * (`transfer_with_authorization`, with the style its arguments use), an
 * anchor (ReceiptRegistry `record`), a CEP-18 `transfer`, a WCSPR wrap (an
 * Odra proxy session calling `deposit`), or something else.
 */
export function classifyTransaction(transaction: unknown): TransactionKind {
  if (!isObject(transaction)) return { kind: "other" };
  const v1 = transaction["Version1"];
  if (isObject(v1)) {
    const fields = isObject(v1["payload"]) ? v1["payload"]["fields"] : undefined;
    if (!isObject(fields)) return { kind: "other" };
    const args = namedArgs(fields["args"]);
    const target = fields["target"];
    if (isObject(target) && isObject(target["Session"])) {
      // An Odra proxy session names the entry point it calls in its `entry_point` argument.
      const called = args.get("entry_point")?.parsed;
      const pkg = args.get("package_hash")?.parsed;
      const asset = typeof pkg === "string" ? pkg.toLowerCase() : undefined;
      if (called === "deposit") return { kind: "wrap", ...(asset ? { asset } : {}) };
      return { kind: "other", entryPoint: typeof called === "string" ? `session → ${called}` : "session" };
    }
    const entry = fields["entry_point"];
    const entryPoint = isObject(entry) && typeof entry["Custom"] === "string" ? entry["Custom"] : typeof entry === "string" ? entry : undefined;
    const stored = isObject(target) && isObject(target["Stored"]) ? target["Stored"]["id"] : undefined;
    const byPackage = isObject(stored) && isObject(stored["ByPackageHash"]) ? stored["ByPackageHash"]["addr"] : undefined;
    return byEntryPoint(entryPoint, args, typeof byPackage === "string" ? byPackage.toLowerCase() : undefined);
  }
  const deploy = transaction["Deploy"];
  if (isObject(deploy) && isObject(deploy["session"])) {
    const session = deploy["session"];
    for (const variant of ["StoredVersionedContractByHash", "StoredContractByHash", "StoredVersionedContractByName", "StoredContractByName"]) {
      const item = session[variant];
      if (!isObject(item)) continue;
      const entryPoint = typeof item["entry_point"] === "string" ? item["entry_point"] : undefined;
      // Only the versioned form names the package (the others: a contract hash or a named key).
      const pkg = variant === "StoredVersionedContractByHash" && typeof item["hash"] === "string" ? item["hash"].toLowerCase() : undefined;
      return byEntryPoint(entryPoint, namedArgs(item["args"]), pkg);
    }
    return { kind: "other", entryPoint: "session" };
  }
  return { kind: "other" };
}

/** Short label of a kind: "settle (legacy-amount)", "anchor", "wrap", "transfer", "other (session → charge)". */
export function kindLabel(kind: TransactionKind): string {
  switch (kind.kind) {
    case "settle":
      return kind.style ? `settle (${kind.style})` : "settle";
    case "other":
      return kind.entryPoint ? `other (${kind.entryPoint})` : "other";
    default:
      return kind.kind;
  }
}

/** One transaction as read back from the chain. */
export interface TransactionReport {
  hash: string;
  kind: TransactionKind;
  /** Undefined while the transaction has not executed, or when the node does not know it. */
  cost?: TransactionCost;
  /** Why there is no cost yet. */
  note?: string;
}

export interface ReadTransactionOptions {
  /** Absolute time (ms, on `now`'s clock) until which to keep polling. Default: 60 s from now. */
  deadlineMs?: number;
  /** Delay between polls. Default 3000 ms. */
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const HASH = /^[0-9a-f]{64}$/;

/** A transaction hash in bare lower-case hex; throws on anything else. */
export function normalizeTransactionHash(input: string): string {
  const hash = input.trim().toLowerCase().replace(/^0x/, "");
  if (!HASH.test(hash)) throw new Error(`not a transaction hash (64 hex characters): "${input.slice(0, 80)}"`);
  return hash;
}

type Variant = "Version1" | "Deploy";
interface InfoGetTransaction {
  transaction?: unknown;
  execution_info?: unknown;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Read a transaction (read-only) until it has executed or `deadlineMs`
 * passes. Tries it as a Version1 transaction, then as a legacy deploy, and
 * treats "no such transaction" and RPC errors as "not yet" (a lagging node).
 */
export async function readTransactionReport(rpc: CasperRpc, hashInput: string, opts: ReadTransactionOptions = {}): Promise<TransactionReport> {
  const hash = normalizeTransactionHash(hashInput);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = opts.deadlineMs ?? now() + 60_000;
  const pollMs = opts.pollMs ?? 3_000;
  let variant: Variant | undefined;
  let kind: TransactionKind = { kind: "other" };
  let note = "unknown to the node";

  for (;;) {
    try {
      let result: InfoGetTransaction | undefined;
      for (const v of variant ? [variant] : (["Version1", "Deploy"] as const)) {
        try {
          result = await rpc.call<InfoGetTransaction>("info_get_transaction", { transaction_hash: { [v]: hash }, finalized_approvals: false });
          variant = v;
          break;
        } catch (err) {
          if (!isNoSuchTransaction(err)) throw err;
        }
      }
      if (result) {
        kind = classifyTransaction(result.transaction);
        const cost = parseTransactionCost(result.execution_info);
        if (cost) return { hash, kind, cost };
        note = "not executed yet";
      } else {
        note = "unknown to the node";
      }
    } catch (err) {
      note = `RPC error: ${describe(err)}`;
    }
    const left = deadline - now();
    if (left <= 0) return { hash, kind, note };
    await sleep(Math.min(pollMs, left));
  }
}

const shortHash = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-4)}`;
const cspr = (value: bigint | undefined) => (value === undefined ? "-" : formatCspr(value));

/**
 * A fixed-width table of transaction costs (CSPR, 4 decimals), one row per
 * report: label, hash, status, limit, consumed, refund, net cost.
 */
export function formatCostTable(rows: ReadonlyArray<{ label: string; report: TransactionReport }>): string[] {
  const header = ["transaction", "hash", "status", "limit", "consumed", "refund", "net cost"];
  const body = rows.map(({ label, report }) => {
    const c = report.cost;
    return [
      label,
      shortHash(report.hash),
      c ? c.status : "unknown",
      cspr(c?.limitMotes),
      cspr(c?.consumedMotes),
      cspr(c?.refundMotes),
      cspr(c?.netMotes),
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...body.map(r => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i >= 3 ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();
  const out = [`${line(header)}   (CSPR)`, ...body.map(line)];
  for (const { label, report } of rows) {
    if (report.cost?.errorMessage) out.push(`  ${label} ${shortHash(report.hash)} reverted: ${report.cost.errorMessage}`);
    else if (!report.cost) out.push(`  ${label} ${shortHash(report.hash)}: ${report.note ?? "not executed yet"}`);
  }
  return out;
}

export interface GasSuggestion {
  label: string;
  /** Successful transactions measured. */
  samples: number;
  maxConsumedMotes: bigint;
  /** ceil(1.3 × max consumed), to 0.01 CSPR. */
  measuredLimitMotes: bigint;
  /** The measured limit, at least {@link BASELINE_PAYMENT_MOTES}. */
  suggestedLimitMotes: bigint;
  /** The limit currently configured for this kind, when the caller knows it. */
  currentLimitMotes?: bigint;
}

/**
 * Suggested gas limits per kind of transaction, from the successful ones
 * (a reverted transaction's consumption says nothing about what a settle
 * needs): ceil(1.3 × max consumed), and never below Casper's 2.5 CSPR
 * baseline payment. `currentLimit` names the configured limit of a kind, for
 * comparison.
 */
export function gasSuggestions(
  reports: readonly TransactionReport[],
  currentLimit: (kind: TransactionKind) => bigint | undefined = () => undefined,
): GasSuggestion[] {
  const groups = new Map<string, { kind: TransactionKind; consumed: bigint[] }>();
  for (const report of reports) {
    const consumed = report.cost?.status === "success" ? report.cost.consumedMotes : undefined;
    if (consumed === undefined) continue;
    const label = kindLabel(report.kind);
    const group = groups.get(label) ?? { kind: report.kind, consumed: [] };
    group.consumed.push(consumed);
    groups.set(label, group);
  }
  return [...groups.entries()].map(([label, { kind, consumed }]) => {
    const current = currentLimit(kind);
    const measuredLimitMotes = suggestGasLimitMotes(consumed);
    return {
      label,
      samples: consumed.length,
      maxConsumedMotes: consumed.reduce((a, b) => (b > a ? b : a)),
      measuredLimitMotes,
      suggestedLimitMotes: measuredLimitMotes > BASELINE_PAYMENT_MOTES ? measuredLimitMotes : BASELINE_PAYMENT_MOTES,
      ...(current !== undefined ? { currentLimitMotes: current } : {}),
    };
  });
}

/** Gas limit of a ReceiptRegistry anchor by default (`anchoring.gasMotes` of @cascet/core's config schema). */
export const DEFAULT_ANCHOR_GAS_MOTES = 2_500_000_000n;

/** The default limit of a kind (settles per style, anchors), to compare a suggestion with. */
export function defaultLimitFor(kind: TransactionKind): bigint | undefined {
  if (kind.kind === "settle" && kind.style) return BigInt(DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE[kind.style]);
  if (kind.kind === "anchor") return DEFAULT_ANCHOR_GAS_MOTES;
  return undefined;
}

/** Human-readable lines for {@link gasSuggestions}. */
export function formatGasSuggestions(suggestions: readonly GasSuggestion[]): string[] {
  return suggestions.map(s => {
    const why =
      s.suggestedLimitMotes === s.measuredLimitMotes
        ? "ceil(1.3 × max)"
        : `ceil(1.3 × max) = ${formatCspr(s.measuredLimitMotes, 2)} CSPR, raised to Casper's ${formatCspr(BASELINE_PAYMENT_MOTES, 1)} CSPR baseline payment`;
    const current = s.currentLimitMotes !== undefined ? `; current limit ${formatCspr(s.currentLimitMotes, 2)} CSPR` : "";
    return (
      `${s.label}: max consumed ${formatCspr(s.maxConsumedMotes)} CSPR over ${s.samples} transaction${s.samples === 1 ? "" : "s"} → ` +
      `suggested limit ${formatCspr(s.suggestedLimitMotes, 2)} CSPR (${why})${current}`
    );
  });
}
