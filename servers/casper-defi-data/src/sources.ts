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
export const MAX_BODY_BYTES = 256 * 1024;

export interface Quote {
  usd: number;
  usd_24h_vol?: number | null;
  usd_24h_change?: number | null;
}

/** A quote plus whether it came from the live API (false = the snapshot fallback). */
export type QuoteResult = Quote & { live: boolean };

/** The live CoinGecko quote of `id`, or undefined when it cannot be fetched or does not validate. */
export async function fetchCoingeckoQuote(id: string, fetchImpl: FetchLike = fetch): Promise<Quote | undefined> {
  try {
    const url =
      `${COINGECKO}/simple/price?ids=${encodeURIComponent(id)}` +
      "&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true";
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return undefined;
    }
    return parseCoingeckoRow(await readJson(res), id);
  } catch {
    return undefined;
  }
}

/** The live quote of `id`, or `fallback` (marked `live: false`) when the live one is unavailable. */
export async function coingeckoSimple(id: string, fallback: Quote, fetchImpl: FetchLike = fetch): Promise<QuoteResult> {
  const quote = await fetchCoingeckoQuote(id, fetchImpl);
  return quote ? { ...quote, live: true } : { ...fallback, live: false };
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

export interface LiveStakingApy {
  nativeApy: number;
  /** CSPR bonded by the validators of one era. */
  totalStakedCspr: number;
  totalSupply: number;
  activeValidators: number;
  eraId: number;
}

export type StakingApy = { live: false } | ({ live: true } & LiveStakingApy);

/**
 * Compute the Casper native-staking APY from live cspr.cloud data: annual
 * staking-reward issuance (fraction of total supply) x total supply, divided
 * by the CSPR bonded in one era. Needs a cspr.cloud token; undefined when the
 * token is absent, the API is unreachable or the answer does not validate.
 */
export async function fetchStakingApy(opts: {
  baseUrl: string;
  token?: string;
  fetchImpl?: FetchLike;
}): Promise<LiveStakingApy | undefined> {
  if (!opts.token) return undefined;
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const init = { headers: { Authorization: opts.token }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) };
    const [supplyRes, auctionRes] = await Promise.all([
      fetchImpl(`${opts.baseUrl}/supply`, init),
      fetchImpl(`${opts.baseUrl}/auction-metrics`, init),
    ]);
    if (!supplyRes.ok || !auctionRes.ok) {
      await Promise.all([supplyRes.body?.cancel(), auctionRes.body?.cancel()]).catch(() => undefined);
      return undefined;
    }
    const [supply, auction] = await Promise.all([readJson(supplyRes), readJson(auctionRes)]);
    const apy = computeStakingApy(supply, auction);
    return apy.live ? withoutLiveFlag(apy) : undefined;
  } catch {
    return undefined;
  }
}

/** fetchStakingApy as a `live` union (`live: false` = use the snapshot). */
export async function casperStakingApy(opts: { baseUrl: string; token?: string; fetchImpl?: FetchLike }): Promise<StakingApy> {
  const apy = await fetchStakingApy(opts);
  return apy ? { live: true, ...apy } : { live: false };
}

/**
 * Validate the /supply and /auction-metrics answers and derive the APY (L50).
 *
 * cspr.cloud documents `total_active_era_stake` as the "total sum of all
 * validator stakes from current and next era", so it counts the bonded stake
 * twice; one era's stake is half of it. Dividing by the whole value
 * understated the APY about 2x. The stake must also be finite and positive,
 * one era's stake cannot exceed the total supply, and the APY must be a
 * plausible percentage, or the tool falls back to its snapshot.
 */
export function computeStakingApy(supplyBody: unknown, auctionBody: unknown): StakingApy {
  const supply = isRecord(supplyBody) && isRecord(supplyBody.data) ? supplyBody.data : undefined;
  const auction = isRecord(auctionBody) && isRecord(auctionBody.data) ? auctionBody.data : undefined;
  if (!supply || !auction) return { live: false };

  const totalSupply = Number(supply.total);
  const issuance = Number(supply.annual_staking_rewards_issuance);
  const twoEraStakeMotes = motes(auction.total_active_era_stake);
  const activeValidators = Number(auction.active_validator_number);
  const eraId = Number(auction.current_era_id);
  if (!(Number.isFinite(totalSupply) && totalSupply > 0)) return { live: false };
  if (!(Number.isFinite(issuance) && issuance > 0 && issuance < 1)) return { live: false };
  if (twoEraStakeMotes === undefined || twoEraStakeMotes <= 0n) return { live: false };
  if (!isCount(activeValidators) || !isCount(eraId)) return { live: false };

  // Current + next era -> one era, in CSPR (1 CSPR = 1e9 motes).
  const totalStakedCspr = Number(twoEraStakeMotes) / 2 / 1e9;
  if (totalStakedCspr > totalSupply) return { live: false };
  const nativeApy = (issuance * totalSupply * 100) / totalStakedCspr;
  // A real staking APY is a small positive percentage; anything else means a unit or data error.
  if (!(Number.isFinite(nativeApy) && nativeApy > 0 && nativeApy <= 100)) return { live: false };
  return { live: true, nativeApy, totalStakedCspr, totalSupply, activeValidators, eraId };
}

/**
 * The Casper network a cspr.cloud base URL serves, for the provenance label
 * (L23): the default base is the TESTNET API, and buyers must be able to tell.
 */
export function csprCloudNetwork(baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "unknown network";
  }
  if (host === "api.testnet.cspr.cloud") return "testnet";
  if (host === "api.cspr.cloud") return "mainnet";
  return `host ${host.slice(0, 40)}`;
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

function withoutLiveFlag(apy: { live: true } & LiveStakingApy): LiveStakingApy {
  const { live: _live, ...rest } = apy;
  return rest;
}

/**
 * Parse a JSON body of at most MAX_BODY_BYTES. The body is read as a stream
 * and abandoned as soon as it passes the cap, so an upstream that sends a huge
 * chunked body (no content-length) cannot make this server buffer all of it.
 */
export async function readJson(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error("body too large");
  }
  if (!res.body) throw new Error("empty body");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("body too large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
