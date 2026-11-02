import { DEFAULT_FACILITATOR_URL, normalizePackageHash, type AuthorizationStyle } from "@cascet/core";
import type { CasperRpc } from "@cascet/gateway";
import { formatCspr } from "./amounts.js";
import { NETWORKS } from "./facilitator-env.js";
import { normalizePayTo } from "./facilitator-core.js";
import { SETTLEABLE_STYLES } from "./settlement.js";
import { parseCli, readCsprBalance, UsageError } from "./testnet-tx.js";
import { TESTNET_WCSPR } from "./wcspr.js";

/**
 * Which real paid call `demo-real` (run-real.ts) makes on testnet: the token
 * buyers pay in (CASCET_ASSET or --asset) and who settles it
 * (CASCET_FACILITATOR or --facilitator; the flag wins).
 *
 *   legacy + self     CasCet X402 Token through the self-hosted facilitator (the original demo, the default)
 *   wcspr  + hosted   Wrapped CSPR through the hosted CSPR.cloud facilitator (CSPR_CLOUD_TOKEN, sent raw)
 *   wcspr  + self     Wrapped CSPR through the self-hosted facilitator, once it settles cep3009-value
 *                     (see SELF_HOSTED_SETTLE_STYLES; refused until then)
 *   legacy + hosted   always refused: the hosted facilitator sends `value`, the legacy token takes
 *                     `amount`, so the settle would revert (User error: 64658)
 */

export const DEMO_ASSETS = ["legacy", "wcspr"] as const;
export type DemoAssetKey = (typeof DEMO_ASSETS)[number];
export const DEMO_FACILITATORS = ["self", "hosted"] as const;
export type DemoFacilitatorKind = (typeof DEMO_FACILITATORS)[number];

/** One demo token: the gateway's `asset` entry. */
export interface DemoAsset {
  key: DemoAssetKey;
  config: {
    packageHash: string;
    name: string;
    symbol: string;
    decimals: number;
    version: string;
    tokensPerUsd: number;
    authorization: AuthorizationStyle;
  };
}

const TESTNET = NETWORKS["casper:casper-test"];

/**
 * The testnet demo tokens. Both have 9 decimals and the same demo rate (50
 * tokens per USD), so a $0.01 call is 0.5 token in either and the measured
 * settle gas compares like for like. (CasCet's x402 token reports the on-chain
 * symbol "WCSPR" too, but it is not Wrapped CSPR.)
 */
export const TESTNET_DEMO_ASSETS: Readonly<Record<DemoAssetKey, DemoAsset>> = Object.freeze({
  legacy: {
    key: "legacy",
    config: {
      packageHash: `hash-${TESTNET.token}`,
      name: "CasCet X402 Token",
      symbol: "WCSPR",
      decimals: 9,
      version: "1",
      tokensPerUsd: 50,
      authorization: "legacy-amount",
    },
  },
  wcspr: {
    key: "wcspr",
    config: {
      packageHash: `hash-${TESTNET_WCSPR.packageHash}`,
      name: TESTNET_WCSPR.name,
      symbol: TESTNET_WCSPR.symbol,
      decimals: TESTNET_WCSPR.decimals,
      version: TESTNET_WCSPR.version,
      tokensPerUsd: 50,
      authorization: "cep3009-value",
    },
  },
});

/**
 * Authorization styles the in-process self-hosted facilitator
 * (real-facilitator.ts) settles: those of its settlement builder
 * (SETTLEABLE_STYLES in settlement.ts), which sends `amount` only, so a
 * cep3009-value token such as Wrapped CSPR would revert with User error 64658
 * and burn the gas limit. The list follows the builder: no copy to keep in sync.
 */
export const SELF_HOSTED_SETTLE_STYLES: readonly AuthorizationStyle[] = SETTLEABLE_STYLES;

/** The hosted CSPR.cloud facilitator. */
export const HOSTED_FACILITATOR_URL = DEFAULT_FACILITATOR_URL;

/**
 * A hosted settle cannot be submitted when the hosted fee payer holds less
 * than its gas limit: @x402/casper's default of 2.5 CSPR, which is also the
 * chainspec's minimum balance (`baseline_motes_amount`). On 2026-11-01 the
 * hosted TESTNET fee payer (account-hash-81d557c9…) held 2.145 CSPR.
 */
export const HOSTED_MIN_FEE_PAYER_MOTES = 2_500_000_000n;

export class DemoConfigError extends Error {
  override name = "DemoConfigError";
}

export interface DemoMode {
  asset: DemoAsset;
  facilitator: DemoFacilitatorKind;
  /** CSPR.cloud access key for the hosted facilitator, sent raw in the Authorization header. Never log it. */
  hostedApiKey?: string;
}

type Env = Record<string, string | undefined>;

function pick<T extends string>(what: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value.trim() === "") return fallback;
  const v = value.trim().toLowerCase();
  if ((allowed as readonly string[]).includes(v)) return v as T;
  throw new DemoConfigError(`${what} must be one of ${allowed.join(", ")}, got "${value.slice(0, 40)}"`);
}

/**
 * The demo mode from `--asset`/`--facilitator` (which win) and
 * CASCET_ASSET/CASCET_FACILITATOR, checked: every refusal names the reason and
 * the way out. `selfHostedStyles` is {@link SELF_HOSTED_SETTLE_STYLES} (a
 * parameter for tests).
 */
export function resolveDemoMode(
  env: Env,
  argv: readonly string[],
  selfHostedStyles: readonly AuthorizationStyle[] = SELF_HOSTED_SETTLE_STYLES,
): DemoMode {
  let flags: Map<string, string | true>;
  try {
    // No positionals here, so every "--" is pnpm's pass-through separator (`demo-real-wcspr -- --facilitator hosted`).
    const cli = parseCli(
      argv.filter(arg => arg !== "--"),
      { values: ["asset", "facilitator"] },
    );
    if (cli.positionals.length > 0) throw new UsageError(`unexpected argument "${cli.positionals[0]!.slice(0, 40)}"`);
    flags = cli.flags;
  } catch (err) {
    throw new DemoConfigError(err instanceof Error ? err.message : String(err));
  }
  const flag = (name: string) => {
    const v = flags.get(name);
    return typeof v === "string" ? v : undefined;
  };
  const assetKey = pick("CASCET_ASSET (--asset)", flag("asset") ?? env["CASCET_ASSET"], DEMO_ASSETS, "legacy");
  const facilitator = pick("CASCET_FACILITATOR (--facilitator)", flag("facilitator") ?? env["CASCET_FACILITATOR"], DEMO_FACILITATORS, "self");
  const asset = TESTNET_DEMO_ASSETS[assetKey];
  const style = asset.config.authorization;

  if (facilitator === "hosted") {
    if (style !== "cep3009-value") {
      throw new DemoConfigError(
        `the hosted facilitator settles cep3009-value tokens only (it sends \`value\`); ${asset.config.name} is ${style} ` +
          "(it takes `amount`), so the settle would revert with User error 64658. Use CASCET_FACILITATOR=self",
      );
    }
    const key = env["CSPR_CLOUD_TOKEN"]?.trim();
    if (!key) {
      throw new DemoConfigError(
        "CASCET_FACILITATOR=hosted needs CSPR_CLOUD_TOKEN: a CSPR.cloud access key, which the gateway sends raw in the Authorization header (no Bearer prefix)",
      );
    }
    if (key.length > 256 || /[\s\u0000-\u001f\u007f]/.test(key)) {
      throw new DemoConfigError("CSPR_CLOUD_TOKEN must be one line without spaces (a CSPR.cloud access key)");
    }
    return { asset, facilitator, hostedApiKey: key };
  }

  if (!selfHostedStyles.includes(style)) {
    throw new DemoConfigError(
      `the self-hosted facilitator does not settle ${style} tokens yet: it would send \`amount\` to ${asset.config.name}, ` +
        "whose transfer_with_authorization takes `value`, and the settle would revert (User error 64658) and burn its gas. " +
        "Use CASCET_FACILITATOR=hosted with CSPR_CLOUD_TOKEN, or CASCET_ASSET=legacy",
    );
  }
  return { asset, facilitator };
}

/** payTo of a hosted run: the first CASCET_SELLER_ACCOUNT_HASH entry, else the testnet demo seller (as the self-hosted facilitator picks it). */
export function demoSeller(env: Env): string {
  const first = env["CASCET_SELLER_ACCOUNT_HASH"]
    ?.split(",")
    .map(s => s.trim())
    .find(Boolean);
  try {
    return first ? normalizePayTo(first) : TESTNET.defaultSeller;
  } catch (err) {
    throw new DemoConfigError(`CASCET_SELLER_ACCOUNT_HASH: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The environment the self-hosted facilitator of a demo run reads: it
 * allowlists the demo token and pins its EIP-712 name unless the operator's
 * own CASCET_ALLOWED_ASSETS / CASCET_TOKEN_NAME say otherwise.
 */
export function selfHostedEnv(env: Env, asset: DemoAsset): Env {
  return { CASCET_ALLOWED_ASSETS: asset.config.packageHash, CASCET_TOKEN_NAME: asset.config.name, ...env };
}

/** Throws when the self-hosted facilitator would refuse the demo token (CASCET_ALLOWED_ASSETS without it). */
export function assertAssetAllowed(allowedAssets: readonly string[], asset: DemoAsset): void {
  const wanted = normalizePackageHash(asset.config.packageHash);
  if (!allowedAssets.map(normalizePackageHash).includes(wanted)) {
    throw new DemoConfigError(`CASCET_ALLOWED_ASSETS does not list ${asset.config.name} (${wanted}); add it or unset the variable`);
  }
}

/** The fee payer the hosted facilitator names for `network` in GET /supported (`kinds[].extra.feePayer`), if any. */
export function hostedFeePayer(supported: unknown, network: string): string | undefined {
  if (typeof supported !== "object" || supported === null) return undefined;
  const kinds = (supported as { kinds?: unknown }).kinds;
  if (!Array.isArray(kinds)) return undefined;
  for (const kind of kinds) {
    if (typeof kind !== "object" || kind === null) continue;
    const k = kind as { scheme?: unknown; network?: unknown; extra?: { feePayer?: unknown } };
    if (k.scheme !== "exact" || k.network !== network) continue;
    const feePayer = typeof k.extra?.feePayer === "string" ? k.extra.feePayer.toLowerCase().replace(/^account-hash-/, "") : "";
    if (/^[0-9a-f]{64}$/.test(feePayer)) return feePayer;
  }
  return undefined;
}

/** Why the hosted facilitator cannot settle now, judged by its fee payer's balance; undefined when it can. */
export function hostedFeePayerProblem(feePayer: string, balanceMotes: bigint, minMotes = HOSTED_MIN_FEE_PAYER_MOTES): string | undefined {
  if (balanceMotes >= minMotes) return undefined;
  return (
    `the hosted facilitator's testnet fee payer (account-hash-${feePayer.slice(0, 8)}…) holds ${formatCspr(balanceMotes, 3)} CSPR, ` +
    `less than the ${formatCspr(minMotes, 3)} CSPR a settle needs, so hosted testnet settles fail until MAKE refills it`
  );
}

/** The `fetch` that reads GET /supported (injected in tests). */
export type SupportedFetch = (input: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** GET /supported of the hosted facilitator (no authentication), with a timeout. */
export async function fetchHostedSupported(
  url: string = HOSTED_FACILITATOR_URL,
  opts: { timeoutMs?: number; fetchImpl?: SupportedFetch } = {},
): Promise<unknown> {
  const doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const response = await doFetch(`${url.replace(/\/+$/, "")}/supported`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
  if (!response.ok) throw new Error(`GET /supported answered HTTP ${response.status}`);
  return response.json();
}

/** The hosted facilitator cannot settle now, or demo-real cannot tell: it stops before anyone signs. */
export class HostedPreflightError extends Error {
  override name = "HostedPreflightError";
}

export interface HostedPreflightDeps {
  /** Read-only node RPC: the fee payer's CSPR balance. */
  rpc: CasperRpc;
  /** The hosted facilitator. Default {@link HOSTED_FACILITATOR_URL}. */
  url?: string;
  /** `fetch` for GET /supported (tests). */
  fetchImpl?: SupportedFetch;
  /** Timeout of GET /supported. Default 10 s. */
  timeoutMs?: number;
}

/** The hosted facilitator's testnet fee payer, checked. */
export interface HostedFeePayerCheck {
  feePayer: string;
  balanceMotes: bigint;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Read-only, before anyone signs: the hosted facilitator names a testnet fee
 * payer in GET /supported, and that fee payer holds enough CSPR to submit a
 * settle ({@link hostedFeePayerProblem}). Fails closed: it throws
 * {@link HostedPreflightError} when /supported or the balance cannot be read,
 * when no testnet fee payer is listed, and when the balance is short. A buyer
 * who signs anyway would only get "payment settlement failed", with an
 * authorization that stays valid until it expires.
 */
export async function hostedPreflight(deps: HostedPreflightDeps): Promise<HostedFeePayerCheck> {
  const network = "casper:casper-test";
  let supported: unknown;
  try {
    supported = await fetchHostedSupported(deps.url ?? HOSTED_FACILITATOR_URL, {
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    });
  } catch (err) {
    throw new HostedPreflightError(
      `cannot read the hosted facilitator's /supported (${errorText(err)}), so its testnet fee payer is unchecked; not paying`,
    );
  }
  const feePayer = hostedFeePayer(supported, network);
  if (!feePayer) throw new HostedPreflightError(`the hosted facilitator lists no fee payer for ${network} in /supported; not paying`);
  let balanceMotes: bigint;
  try {
    balanceMotes = await readCsprBalance(deps.rpc, feePayer);
  } catch (err) {
    throw new HostedPreflightError(
      `cannot read the CSPR balance of the hosted facilitator's testnet fee payer (account-hash-${feePayer.slice(0, 8)}…): ` +
        `${errorText(err)}; not paying`,
    );
  }
  const problem = hostedFeePayerProblem(feePayer, balanceMotes);
  if (problem) throw new HostedPreflightError(problem);
  return { feePayer, balanceMotes };
}

/** How to fund the buyer with the demo token (printed when its balance is too low). */
export function fundingHint(asset: DemoAsset, buyerAccountHash: string): string {
  const token = normalizePackageHash(asset.config.packageHash);
  const fund = `pnpm --filter @cascet/e2e fund-token ${token} ${buyerAccountHash} 5 --send`;
  if (asset.key === "wcspr") return `wrap testnet CSPR first (pnpm --filter @cascet/e2e wrap-wcspr 10 --send), then: ${fund}`;
  return fund;
}
