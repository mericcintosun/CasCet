/**
 * Upstream data sources of the casper-defi-data server (CoinGecko, cspr.cloud).
 *
 * Every upstream payload is validated before use: a field of the wrong type,
 * a non-finite number or an implausible APY makes the tool fall back to its
 * clearly-labeled snapshot instead of selling garbage (or NaN, which JSON
 * turns into null) to a paying buyer. Upstream errors never reach the caller.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const COINGECKO = "https://api.coingecko.com/api/v3";
export const DEFAULT_CSPR_CLOUD = "https://api.testnet.cspr.cloud";
const UPSTREAM_TIMEOUT_MS = 4_000;
/** Upstream answers are a few hundred bytes; anything far larger is not what we asked for. */
const MAX_BODY_BYTES = 256 * 1024;

export interface Quote {
  usd: number;
  usd_24h_vol?: number | null;
  usd_24h_change?: number | null;
}

/** A quote plus whether it came from the live API (false = the snapshot fallback). */
export type QuoteResult = Quote & { live: boolean };

export async function coingeckoSimple(id: string, fallback: Quote, fetchImpl: FetchLike = fetch): Promise<QuoteResult> {
  try {
    const url =
      `${COINGECKO}/simple/price?ids=${encodeURIComponent(id)}` +
      "&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true";
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const row = parseCoingeckoRow(await readJson(res), id);
    if (!row) throw new Error("empty or malformed payload");
    return { ...row, live: true };
  } catch {
    return { ...fallback, live: false };
  }
}

/** The validated `body[id]` row of a /simple/price answer, or undefined when unusable. */
export function parseCoingeckoRow(body: unknown, id: string): Quote | undefined {
  if (!isRecord(body)) return undefined;
  const row = body[id];
  if (!isRecord(row)) return undefined;
  const usd = row.usd;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) return undefined;
  return {
    usd,
    usd_24h_vol: optionalNumber(row.usd_24h_vol, v => v >= 0),
    usd_24h_change: optionalNumber(row.usd_24h_change, () => true),
  };
}

export type StakingApy =
  | { live: false }
  | {
      live: true;
      nativeApy: number;
      totalStakedCspr: number;
      totalSupply: number;
      activeValidators: number;
      eraId: number;
    };

/**
 * Compute the real Casper native-staking APY from live cspr.cloud data:
 * annual staking-reward issuance (fraction of total supply) × total supply,
 * divided by the total CSPR currently bonded. Needs a cspr.cloud token;
 * degrades to the snapshot (`live: false`) when the token is absent, the API
 * is unreachable or the answer does not validate.
 */
export async function casperStakingApy(opts: { baseUrl: string; token?: string; fetchImpl?: FetchLike }): Promise<StakingApy> {
  if (!opts.token) return { live: false };
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const init = { headers: { Authorization: opts.token }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) };
    const [supplyRes, auctionRes] = await Promise.all([
      fetchImpl(`${opts.baseUrl}/supply`, init),
      fetchImpl(`${opts.baseUrl}/auction-metrics`, init),
    ]);
    if (!supplyRes.ok || !auctionRes.ok) throw new Error("http");
    const [supply, auction] = await Promise.all([readJson(supplyRes), readJson(auctionRes)]);
    return computeStakingApy(supply, auction);
  } catch {
    return { live: false };
  }
}

/** Validate the /supply and /auction-metrics answers and derive the APY (L50: finite, plausible). */
export function computeStakingApy(supplyBody: unknown, auctionBody: unknown): StakingApy {
  const supply = isRecord(supplyBody) && isRecord(supplyBody.data) ? supplyBody.data : undefined;
  const auction = isRecord(auctionBody) && isRecord(auctionBody.data) ? auctionBody.data : undefined;
  if (!supply || !auction) return { live: false };

  const totalSupply = Number(supply.total);
  const issuance = Number(supply.annual_staking_rewards_issuance);
  const stakeMotes = motes(auction.total_active_era_stake);
  const activeValidators = Number(auction.active_validator_number);
  const eraId = Number(auction.current_era_id);
  if (!(Number.isFinite(totalSupply) && totalSupply > 0)) return { live: false };
  if (!(Number.isFinite(issuance) && issuance > 0 && issuance < 1)) return { live: false };
  if (stakeMotes === undefined || stakeMotes <= 0n) return { live: false };
  if (!isCount(activeValidators) || !isCount(eraId)) return { live: false };

  const totalStakedCspr = Number(stakeMotes) / 1e9;
  const nativeApy = (issuance * totalSupply * 100) / totalStakedCspr;
  // A real staking APY is a small positive percentage; anything else means a unit or data error.
  if (!(Number.isFinite(nativeApy) && nativeApy > 0 && nativeApy <= 100)) return { live: false };
  return { live: true, nativeApy, totalStakedCspr, totalSupply, activeValidators, eraId };
}

/** Motes as a non-negative integer: a decimal string (the API's form) or a safe integer. */
function motes(value: unknown): bigint | undefined {
  if (typeof value === "string" && /^\d{1,40}$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return undefined;
}

function isCount(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

/** Keep a finite number that passes `ok`; keep null as null; drop anything else. */
function optionalNumber(value: unknown, ok: (v: number) => boolean): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && ok(value) ? value : undefined;
}

async function readJson(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new Error("body too large");
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("body too large");
  return JSON.parse(text) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
