import { DEMO_TOKEN_PACKAGE, NODE_URL, PAYEES, REVENUE_SPLIT_PACKAGE } from "@/lib/casper/constants";
import { readSplitState, SplitReadError, type SplitState } from "@/lib/casper/split-state";
import { clientKey, createRateLimiter, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** One read is ~13 RPC calls: answer repeats from a short cache, and limit each client (L33). */
const CACHE_MS = 10_000;
const limiter = createRateLimiter({ limit: 30, windowMs: 60_000 });
let cache: { at: number; state: SplitState } | null = null;

/**
 * What each RevenueSplit payee could release right now, read from the
 * contract's on-chain state (L124). /withdraw disables Withdraw at zero, so
 * the wallet does not pay gas for a release that reverts with NothingToRelease.
 * A failed read is an error (502/504 with ok:false), never a zero.
 */
export async function GET(req: Request): Promise<Response> {
  const allowed = limiter.check(clientKey(req));
  if (!allowed.ok) return tooManyRequests(allowed.retryAfterSeconds);
  if (cache && Date.now() - cache.at < CACHE_MS) return Response.json({ ok: true, ...cache.state });
  try {
    const state = await readSplitState({
      nodeUrl: NODE_URL,
      splitPackage: REVENUE_SPLIT_PACKAGE,
      tokenPackage: DEMO_TOKEN_PACKAGE,
      payees: PAYEES.map((p) => ({ accountHash: p.accountHash, share: p.share })),
    });
    cache = { at: Date.now(), state };
    return Response.json({ ok: true, ...state });
  } catch (e) {
    const status = e instanceof SplitReadError ? e.status : 502;
    const message = e instanceof Error ? e.message : String(e);
    console.error("[revenue/releasable] could not read the RevenueSplit state:", message);
    return Response.json({ ok: false, error: message }, { status });
  }
}
