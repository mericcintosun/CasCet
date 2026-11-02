/**
 * The token a settle transaction paid in, read back from the chain (read-only
 * `info_get_transaction`): the contract package its `transfer_with_authorization`
 * call targets. A ReceiptRegistry `record` carries no asset, so this is how the
 * token of an anchored receipt is told once more than one token is anchored in
 * the same registry.
 *
 * Network-free apart from the injected `fetchImpl`, so it is unit-tested.
 */

const HASH = /^[0-9a-f]{64}$/;
/** JSON-RPC error code for "No such transaction" (info_get_transaction). */
const RPC_NO_SUCH_TRANSACTION = -32014;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** A package hash as bare lower-case hex, or undefined. */
function bareHash(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const hex = value.toLowerCase().replace(/^(?:hash-|contract-package-)/, "");
  return HASH.test(hex) ? hex : undefined;
}

/**
 * The contract package a `transfer_with_authorization` transaction calls (bare
 * lower-case hex), from the `transaction` of an `info_get_transaction` answer:
 * a Version1 transaction stored by package hash, or a legacy deploy calling a
 * versioned contract by hash. Undefined for anything else.
 */
export function settledTokenOf(transaction: unknown): string | undefined {
  if (!isObject(transaction)) return undefined;
  const v1 = transaction.Version1;
  if (isObject(v1)) {
    const fields = isObject(v1.payload) ? v1.payload.fields : undefined;
    if (!isObject(fields)) return undefined;
    const entry = fields.entry_point;
    const target = fields.target;
    const stored = isObject(target) && isObject(target.Stored) ? target.Stored.id : undefined;
    const pkg = isObject(stored) && isObject(stored.ByPackageHash) ? stored.ByPackageHash.addr : undefined;
    return isObject(entry) && entry.Custom === "transfer_with_authorization" ? bareHash(pkg) : undefined;
  }
  const deploy = transaction.Deploy;
  const call = isObject(deploy) && isObject(deploy.session) ? deploy.session.StoredVersionedContractByHash : undefined;
  return isObject(call) && call.entry_point === "transfer_with_authorization" ? bareHash(call.hash) : undefined;
}

export interface SettleTokenReaderOptions {
  /** Casper node JSON-RPC endpoint. */
  nodeUrl: string;
  fetchImpl?: typeof fetch;
  /** Deadline per RPC call. Default 3000 ms. */
  timeoutMs?: number;
  /** How many answers to keep; the oldest go first. Default 2000. */
  cacheSize?: number;
}

/**
 * Reads the token a settle transaction (64-hex hash) paid in, or undefined when
 * that cannot be told. A transaction's target never changes, so every definite
 * answer, "names no token" included, is kept and the node is asked once; a
 * transaction the node does not know (yet) and every failure are asked again
 * next time.
 */
export function createSettleTokenReader(o: SettleTokenReaderOptions): (txHash: string) => Promise<string | undefined> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 3_000;
  const cacheSize = o.cacheSize ?? 2_000;
  /** null: the transaction names no token, for good. */
  const known = new Map<string, string | null>();

  /** The node's `result`, null when it does not know the hash as `variant`, undefined on any failure. */
  const lookup = async (variant: "Version1" | "Deploy", hash: string): Promise<unknown> => {
    try {
      const res = await fetchImpl(o.nodeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "info_get_transaction",
          params: { transaction_hash: { [variant]: hash }, finalized_approvals: false },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { result?: unknown; error?: { code?: unknown } };
      if (isObject(body.error)) return body.error.code === RPC_NO_SUCH_TRANSACTION ? null : undefined;
      return isObject(body.result) ? body.result : undefined;
    } catch {
      return undefined;
    }
  };

  return async (txHash) => {
    const hash = txHash.toLowerCase();
    if (!HASH.test(hash)) return undefined;
    const kept = known.get(hash);
    if (kept !== undefined) return kept ?? undefined;
    for (const variant of ["Version1", "Deploy"] as const) {
      const result = await lookup(variant, hash);
      if (result === null) continue;
      if (result === undefined) return undefined;
      const token = settledTokenOf((result as Record<string, unknown>).transaction);
      if (known.size >= cacheSize) known.delete(known.keys().next().value as string);
      known.set(hash, token ?? null);
      return token;
    }
    return undefined;
  };
}
