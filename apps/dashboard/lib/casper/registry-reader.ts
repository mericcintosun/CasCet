import type { PaymentReceipt } from "@cascet/core";

/**
 * Reconstruct settled receipts from the ReceiptRegistry's `record` transactions,
 * as indexed by CSPR.cloud.
 *
 * Odra stores contract state in an internal, hash-keyed dictionary, so the
 * receipts map can't be read directly over RPC. Instead we rebuild each receipt
 * from the args of its `record` transaction: CSPR.cloud indexes every call to
 * the contract, and a `record` call's arguments ARE the receipt.
 *
 * Every failure is an error (finding M16): a missing token, a non-2xx page, a
 * timeout or an unexpected body never turn into an empty, healthy-looking list.
 * Network-free apart from the injected `fetchImpl`, so it is unit-tested.
 */

export type OnchainErrorCode = "not_configured" | "upstream_error" | "upstream_timeout" | "bad_upstream_payload";

export class OnchainReadError extends Error {
  override name = "OnchainReadError";
  constructor(
    message: string,
    /** HTTP status /api/onchain answers with. */
    readonly status: 502 | 503 | 504,
    readonly code: OnchainErrorCode,
  ) {
    super(message);
  }
}

/** The token a receipt was paid in. */
export interface ReceiptToken {
  /** Bare lower-case package hash. */
  packageHash: string;
  /** Empty when the token is not one the caller knows. */
  symbol: string;
}

/** What tells a record's token apart: the `record` args carry no asset. */
export interface AnchoredRecord {
  /** The settlement transaction (`tx_hash`), 64 hex. */
  txHash: string;
  /** When the record was anchored (the `record` transaction's timestamp), as CSPR.cloud gives it. */
  anchoredAt: string;
}

export interface RegistryReadOptions {
  /** CSPR.cloud access token. Missing → OnchainReadError(503, not_configured). */
  token: string | undefined;
  apiBase: string;
  registryPackageHash: string;
  /** CAIP-2 network the registry lives on; stamped on every receipt. */
  network: string;
  /**
   * The token a record was paid in. The `record` args carry no asset, and one
   * registry can hold receipts in several tokens, so the caller tells it (for
   * example from the settlement transaction). Undefined when it cannot be
   * told: the receipt then names no token (`asset` and `assetSymbol` empty)
   * rather than a wrong one. A call that throws counts as undefined.
   */
  tokenOf: (record: AnchoredRecord) => Promise<ReceiptToken | undefined>;
  /** How many `tokenOf` calls run at once. Default 6. */
  tokenConcurrency?: number;
  /** No `tokenOf` call starts later than this after the records were read; the rest name no token this time. Default 4000 ms. */
  tokenBudgetMs?: number;
  /** Payment ids hidden from the view (records whose settle tx never reached the chain). */
  excludedIds?: ReadonlySet<string>;
  fetchImpl?: typeof fetch;
  pageSize?: number;
  maxPages?: number;
  timeoutMs?: number;
  /** Clock of the token budget (tests). */
  now?: () => number;
}

export interface RegistryReadResult {
  /** Newest first. */
  receipts: PaymentReceipt[];
  /** True when the registry has more pages than were read. */
  truncated: boolean;
}

interface CloudDeploy {
  deploy_hash?: string;
  timestamp?: string;
  status?: string;
  error_message?: string | null;
  args?: Record<string, { parsed?: unknown }>;
}

const SETTLE_HASH = /^[0-9a-f]{64}$/i;

const argStr = (a: CloudDeploy["args"], key: string): string => {
  const v = a?.[key]?.parsed;
  return v === undefined || v === null ? "" : String(v);
};

export async function readRegistryReceipts(o: RegistryReadOptions): Promise<RegistryReadResult> {
  if (!o.token) {
    throw new OnchainReadError("CSPR_CLOUD_TOKEN is not configured on this deployment", 503, "not_configured");
  }
  const fetchImpl = o.fetchImpl ?? fetch;
  const pageSize = o.pageSize ?? 50;
  const maxPages = o.maxPages ?? 10;
  const timeoutMs = o.timeoutMs ?? 8_000;

  const out: PaymentReceipt[] = [];
  let page = 1;
  let pages = 1;
  do {
    const url = `${o.apiBase}/deploys?contract_package_hash=${o.registryPackageHash}&page=${page}&page_size=${pageSize}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { Authorization: o.token },
        signal: AbortSignal.timeout(timeoutMs),
        // Next.js data cache: at most one upstream read per 30 s per page.
        next: { revalidate: 30 },
      } as RequestInit);
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new OnchainReadError(`CSPR.cloud did not answer within ${timeoutMs} ms`, 504, "upstream_timeout");
      }
      throw new OnchainReadError(`CSPR.cloud request failed: ${(e as Error)?.message ?? String(e)}`, 502, "upstream_error");
    }
    if (!res.ok) {
      throw new OnchainReadError(`CSPR.cloud answered HTTP ${res.status} (page ${page})`, 502, "upstream_error");
    }
    let json: { data?: unknown; page_count?: unknown };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new OnchainReadError("CSPR.cloud returned a body that is not JSON", 502, "bad_upstream_payload");
    }
    if (!json || !Array.isArray(json.data)) {
      throw new OnchainReadError("CSPR.cloud returned an unexpected response shape", 502, "bad_upstream_payload");
    }
    pages = typeof json.page_count === "number" && json.page_count > 0 ? Math.floor(json.page_count) : 1;

    for (const d of json.data as CloudDeploy[]) {
      const paymentId = argStr(d.args, "payment_id");
      if (!paymentId) continue; // not a `record` call (init/authorize/…)
      if (d.status && d.status !== "processed") continue;
      if (d.error_message) continue;
      // Skip test fixtures: placeholder tx hashes ("demo-tx") and unsettled mock-era records.
      const txHash = argStr(d.args, "tx_hash");
      if (!SETTLE_HASH.test(txHash) || o.excludedIds?.has(paymentId)) continue;
      const amount = argStr(d.args, "amount");
      out.push({
        id: paymentId,
        parentId: argStr(d.args, "parent_id") || undefined,
        createdAt: d.timestamp ?? "",
        network: o.network,
        server: argStr(d.args, "server"),
        tool: argStr(d.args, "tool"),
        payer: argStr(d.args, "payer"),
        payTo: argStr(d.args, "payee"),
        amountRaw: /^\d{1,78}$/.test(amount) ? amount : "0",
        // Told by `tokenOf` below.
        asset: "",
        assetSymbol: "",
        txHash,
        status: "settled",
        anchoredTxHash: d.deploy_hash,
      });
    }
    page++;
  } while (page <= pages && page <= maxPages);

  // Newest first; ties keep upstream order.
  out.sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1));
  await tellTokens(out, o);
  return { receipts: out, truncated: pages > maxPages };
}

/**
 * Give each receipt the token `o.tokenOf` tells, newest first, with at most
 * `tokenConcurrency` calls at once; once `tokenBudgetMs` has passed no call
 * starts, and the receipts not reached keep naming no token.
 */
async function tellTokens(receipts: PaymentReceipt[], o: RegistryReadOptions): Promise<void> {
  const now = o.now ?? Date.now;
  const deadline = now() + (o.tokenBudgetMs ?? 4_000);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < receipts.length && now() < deadline) {
      const receipt = receipts[next++]!;
      let token: ReceiptToken | undefined;
      try {
        token = await o.tokenOf({ txHash: receipt.txHash ?? "", anchoredAt: receipt.createdAt });
      } catch {
        token = undefined;
      }
      if (token) {
        receipt.asset = token.packageHash;
        receipt.assetSymbol = token.symbol;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.tokenConcurrency ?? 6, receipts.length) }, worker));
}
