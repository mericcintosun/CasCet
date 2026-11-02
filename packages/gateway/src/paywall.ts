import { x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient, type RoutesConfig } from "@x402/core/server";
import type { AssetAmount, Network } from "@x402/core/types";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  AUTHORIZATION_STYLE_EXTRA_KEY,
  assetsForPrice,
  facilitatorAuthorization,
  facilitatorFor,
  facilitatorTimeouts,
  HOSTED_FACILITATOR_HOST,
  isAuthorizationStyle,
  isHostedFacilitatorUrl,
  isLegacyAmountToken,
  isPackageHash,
  normalizePackageHash,
  usdPriceToTokenUnits,
  type CascetConfig,
  type FacilitatorConfig,
  type ResolvedAsset,
  type ToolPrice,
} from "@cascet/core";
import { normalizeAccountAddress } from "./authorization.js";
import { TimeoutFacilitatorClient } from "./facilitator.js";
import { AssetRoutingFacilitatorClient, ExtraStrippingFacilitatorClient, type AssetRoute } from "./facilitator-router.js";
import { CascetCasperServerScheme } from "./server-scheme.js";

/** Seconds an authorization must still be valid when settlement starts (inclusion + execution on Casper). */
export const SETTLE_HEADROOM_SECONDS = 30;
/** Tolerated clock difference between buyer and gateway. */
export const MAX_CLOCK_SKEW_SECONDS = 120;

/** Facilitators, scheme and payment terms shared by every tool. Built once. */
export interface PaymentRail {
  resourceServer: x402ResourceServer;
  network: Network;
  /** Payee account: "00" + account hash, lowercase. */
  payTo: string;
  /**
   * The tokens buyers can pay in, in config order (the order of every 402's
   * `accepts`), package hashes as bare lower-case hex. Each one is verified and
   * settled by its own facilitator.
   */
  assets: readonly ResolvedAsset[];
  /** Validity window the gateway asks buyers to sign (x402 maxTimeoutSeconds). */
  maxTimeoutSeconds: number;
}

export interface PaymentRailOptions {
  /** fetch used for every facilitator request (tests). */
  fetch?: typeof fetch;
}

/** The timeouts a paid call can take, in milliseconds. */
export interface GatewayTimeouts {
  /** Longest /verify (and /supported) call. */
  facilitatorMs: number;
  /** Longest /settle call. */
  settleMs: number;
  /** One upstream MCP request. */
  upstreamMs: number;
}

/**
 * The gateway's effective timeouts: the upstream's, and the longest verify and
 * settle timeouts of the facilitators that settle the configured assets (a
 * facilitator's own `timeoutMs` replaces `timeouts.facilitatorMs` and
 * `timeouts.settleMs` for its calls).
 */
export function gatewayTimeouts(cfg: CascetConfig): GatewayTimeouts {
  let facilitatorMs = 0;
  let settleMs = 0;
  for (const asset of cfg.assets) {
    const timeouts = facilitatorTimeouts(cfg, facilitatorFor(cfg, asset));
    facilitatorMs = Math.max(facilitatorMs, timeouts.verifyMs);
    settleMs = Math.max(settleMs, timeouts.settleMs);
  }
  return { facilitatorMs, settleMs, upstreamMs: cfg.timeouts.upstreamMs };
}

/**
 * How long an authorization must still be valid when it arrives: the
 * facilitator's verify, then (in the default run-then-settle mode) the tool
 * run, must leave SETTLE_HEADROOM_SECONDS for the settle transaction. Sized
 * with the slowest facilitator, so it holds whichever asset a buyer pays in.
 */
export function requiredValiditySeconds(cfg: CascetConfig, settleBeforeExecute: boolean): number {
  const { facilitatorMs, upstreamMs } = gatewayTimeouts(cfg);
  const beforeSettleMs = facilitatorMs + (settleBeforeExecute ? 0 : upstreamMs);
  return Math.ceil(beforeSettleMs / 1_000) + SETTLE_HEADROOM_SECONDS;
}

/**
 * The window must cover verifying, running the tool and settling afterwards,
 * so it grows with the configured timeouts; never below x402's customary 300 s.
 */
export function maxTimeoutSecondsFor(cfg: CascetConfig): number {
  const { facilitatorMs, upstreamMs, settleMs } = gatewayTimeouts(cfg);
  return Math.max(300, Math.ceil((facilitatorMs + upstreamMs + settleMs) / 1_000) + SETTLE_HEADROOM_SECONDS);
}

/**
 * The `extra` of an accepts entry in `asset`: the EIP-712 domain buyers sign
 * over (name, version), the symbol and decimals for display, and the asset's
 * authorization style. The style is server-owned (x402 v2 matching makes
 * buyers echo it) and informational: buyers may prefer a style and refuse
 * unknown ones, facilitators read the token's ABI instead.
 */
export function requirementExtra(asset: ResolvedAsset): Record<string, string> {
  return {
    name: asset.name,
    symbol: asset.symbol,
    version: asset.version,
    decimals: String(asset.decimals),
    [AUTHORIZATION_STYLE_EXTRA_KEY]: asset.authorization,
  };
}

/** The x402 price of one `accepts` entry: `amount` raw units of `asset`, with {@link requirementExtra}. */
export function assetAmountFor(asset: ResolvedAsset, amount: string): AssetAmount {
  return { asset: asset.packageHash, amount, extra: requirementExtra(asset) };
}

/**
 * The tokens this gateway sells in, in config order, each checked: a contract
 * package hash (returned as bare lower-case hex), listed once under a unique
 * id, with a known authorization style that does not contradict a known
 * token's ABI. The config schema guarantees all of this already; configs built
 * in code bypass it, so the gateway checks again before it starts.
 */
export function gatewayAssets(cfg: CascetConfig): CascetConfig["assets"] {
  if (!Array.isArray(cfg.assets) || cfg.assets.length === 0) {
    throw new Error("the config lists no asset: parse it with cascetConfigSchema from @cascet/core");
  }
  const ids = new Set<string>();
  const hashes = new Set<string>();
  const assets = cfg.assets.map(asset => {
    const packageHash = normalizePackageHash(String(asset.packageHash));
    if (!isPackageHash(packageHash)) {
      throw new Error(`asset "${asset.id}": packageHash must be 64 hex characters (optionally prefixed with hash-)`);
    }
    if (ids.has(asset.id)) throw new Error(`asset id "${asset.id}" is used twice`);
    if (hashes.has(packageHash)) throw new Error(`asset "${asset.id}": token ${packageHash} is listed twice`);
    ids.add(asset.id);
    hashes.add(packageHash);
    if (!isAuthorizationStyle(asset.authorization)) {
      throw new Error(`asset "${asset.id}": unknown authorization style ${JSON.stringify(asset.authorization)}`);
    }
    if (asset.authorization !== "legacy-amount" && isLegacyAmountToken(packageHash)) {
      throw new Error(`asset "${asset.id}": token ${packageHash} is CasCet's x402 token, whose authorization style is "legacy-amount"`);
    }
    return packageHash === asset.packageHash ? asset : { ...asset, packageHash };
  });
  return assets as CascetConfig["assets"];
}

/** What a priced tool costs in one token. */
export interface AssetPrice {
  asset: ResolvedAsset;
  /** Raw token units buyers must authorize, decimal string. */
  amount: string;
}

/**
 * A price in every token it accepts (`price.assets`, or every configured
 * asset), in config order. Throws when the price accepts no configured asset
 * or rounds to zero units of one of its assets.
 */
export function assetPricesFor(cfg: CascetConfig, price: ToolPrice): AssetPrice[] {
  const assets = assetsForPrice({ assets: gatewayAssets(cfg) }, price);
  if (assets.length === 0) {
    throw new Error(`price ${price.price} accepts none of the configured assets (it lists ${(price.assets ?? []).join(", ")})`);
  }
  return assets.map(asset => {
    try {
      return { asset, amount: usdPriceToTokenUnits(price.price, asset).toString() };
    } catch (err) {
      throw new Error(`asset "${asset.id}": ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/**
 * Every configured price must convert into each of its assets. Checked at
 * startup, so a price that rounds to zero in one token stops the gateway
 * instead of hiding tools later.
 */
export function checkPricing(cfg: CascetConfig): void {
  const prices: Array<[string, ToolPrice | undefined]> = [
    ["pricing.default", cfg.pricing.default],
    ...Object.entries(cfg.pricing.tools).map(([tool, price]): [string, ToolPrice] => [`pricing.tools.${tool}`, price]),
  ];
  for (const [path, price] of prices) {
    if (!price) continue;
    try {
      assetPricesFor(cfg, price);
    } catch (err) {
      throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * The payee as the scheme settles it: "00" + account hash. casper-x402 1.0.0
 * encodes every `to` as an account-hash key when it settles, so a contract
 * package payee ("01" + 64 hex, written as hash-/package-hash- in the config)
 * would pass verification and then revert on every call (L60); it is refused
 * until the scheme supports contract payees.
 */
export function settleablePayTo(value: string): string {
  const payTo = normalizeAccountAddress(value);
  if (/^00[0-9a-f]{64}$/.test(payTo)) return payTo;
  const hint = "use the payee account's hash instead (for a public key run: npx @cascet/cli account-hash <public-key>)";
  if (/^01[0-9a-f]{64}$/.test(payTo)) {
    throw new Error(
      `payTo ${payTo} is not an account: the x402 Casper scheme (casper-x402 1.0.0) cannot settle to a contract package, ` +
        `and a public key is not an address; ${hint}`,
    );
  }
  throw new Error(`payTo must be the payee's account hash ("00" + 64 hex, or account-hash-<64 hex>); ${hint}`);
}

/** Origin of a facilitator URL, for logs and messages: never its path, query or credentials. */
export function facilitatorOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "<invalid url>";
  }
}

/** The client of one configured facilitator: its URL, its key in its auth scheme, its timeouts. */
function facilitatorClient(cfg: CascetConfig, settler: FacilitatorConfig, fetchImpl: typeof fetch | undefined): FacilitatorClient {
  const timeouts = facilitatorTimeouts(cfg, settler);
  const client = new TimeoutFacilitatorClient({
    url: settler.url,
    authorization: facilitatorAuthorization(settler),
    verifyTimeoutMs: timeouts.verifyMs,
    settleTimeoutMs: timeouts.settleMs,
    fetchImpl,
  });
  // The hosted facilitator gets the requirements without CasCet's own extra field.
  return isHostedFacilitatorUrl(settler.url) ? new ExtraStrippingFacilitatorClient(client, [AUTHORIZATION_STYLE_EXTRA_KEY]) : client;
}

/**
 * Route every configured asset to its facilitator, with one client per
 * facilitator (assets that name the same one share it). Refuses what could
 * never settle, even in a config built in code that bypassed the schema: a
 * legacy-amount token sent to the hosted facilitator (which passes `value`,
 * so every settlement would revert), and the hosted facilitator with a bearer
 * key (it takes the raw access key).
 */
export function assetRoutes(cfg: CascetConfig, network: Network, options: PaymentRailOptions = {}): AssetRoute[] {
  const clients = new Map<string, FacilitatorClient>();
  return gatewayAssets(cfg).map(asset => {
    const settler = facilitatorFor(cfg, asset);
    if (isHostedFacilitatorUrl(settler.url)) {
      if (asset.authorization === "legacy-amount") {
        throw new Error(
          `asset "${asset.id}" is a legacy-amount token, but its facilitator "${asset.facilitator}" is the hosted one ` +
            `(${HOSTED_FACILITATOR_HOST}), which sends the CEP-3009 \`value\` argument: every settlement would revert ` +
            "(User error: 64658). Settle it through a self-hosted facilitator",
        );
      }
      if (settler.authScheme === "bearer") {
        throw new Error(
          `facilitator "${asset.facilitator}" is the hosted one, which takes the raw CSPR.cloud access key: use authScheme "raw"`,
        );
      }
    }
    let client = clients.get(asset.facilitator);
    if (!client) {
      client = facilitatorClient(cfg, settler, options.fetch);
      clients.set(asset.facilitator, client);
    }
    return {
      network,
      asset: asset.packageHash,
      facilitator: client,
      label: `facilitator "${asset.facilitator}" (${facilitatorOrigin(settler.url)})`,
      // x402's retry of a pending settlement shares this budget with the first call.
      settleTimeoutMs: facilitatorTimeouts(cfg, settler).settleMs,
    };
  });
}

/**
 * Create the x402 resource server: every asset's facilitator behind one
 * AssetRoutingFacilitatorClient, the CasCet scheme with every asset, and the
 * startup checks (payTo, every price converts, every facilitator answers and
 * supports "exact" payments on this network).
 */
export async function createPaymentRail(cfg: CascetConfig, options: PaymentRailOptions = {}): Promise<PaymentRail> {
  const network = cfg.network as Network;
  const payTo = settleablePayTo(cfg.payTo);
  const assets = gatewayAssets(cfg);
  checkPricing(cfg);
  const router = new AssetRoutingFacilitatorClient(assetRoutes(cfg, network, options));
  const scheme = new CascetCasperServerScheme(assets.map(asset => ({ network, asset: asset.packageHash, decimals: asset.decimals })));
  const resourceServer = new x402ResourceServer(router).register(network, scheme);
  try {
    await resourceServer.initialize();
  } catch (err) {
    // x402 wraps the facilitator's own error as the cause; name it.
    const reason = err instanceof Error && err.cause instanceof Error ? err.cause.message : err instanceof Error ? err.message : String(err);
    throw new Error(`cannot load the supported payment kinds of the facilitators: ${reason}`, { cause: err });
  }
  await router.assertCoverage();
  return { resourceServer, network, payTo, assets, maxTimeoutSeconds: maxTimeoutSecondsFor(cfg) };
}

/** What the gateway does with one upstream tool. */
export type ToolPolicy =
  | { kind: "free" }
  | {
      kind: "paid";
      price: ToolPrice;
      /** What the tool costs in each token it accepts, in config order (the order of its 402 `accepts`). */
      accepts: readonly AssetPrice[];
      settleBeforeExecute: boolean;
    };

/** The policy of a priced tool. */
export type PaidToolPolicy = Extract<ToolPolicy, { kind: "paid" }>;

/** The price of a tool in `asset` (any spelling), or undefined when the tool does not accept that token. */
export function priceIn(policy: PaidToolPolicy, asset: string): AssetPrice | undefined {
  const wanted = normalizePackageHash(asset);
  return policy.accepts.find(entry => entry.asset.packageHash === wanted);
}

/**
 * Pricing policy of a tool, or undefined when the tool must be hidden: an
 * upstream tool is exposed only when it is priced (explicitly or by
 * `pricing.default`) or listed in `pricing.freeTools`. Own-property lookups
 * only, so names like "constructor" or "toString" are never priced by accident.
 */
export function resolveToolPolicy(cfg: CascetConfig, name: string): ToolPolicy | undefined {
  const explicit = Object.hasOwn(cfg.pricing.tools, name) ? cfg.pricing.tools[name] : undefined;
  const paid = (price: ToolPrice): ToolPolicy => ({
    kind: "paid",
    price,
    accepts: assetPricesFor(cfg, price),
    settleBeforeExecute: price.settleBeforeExecute,
  });
  if (explicit) return paid(explicit);
  if (cfg.pricing.freeTools.includes(name)) return { kind: "free" };
  if (cfg.pricing.default) return paid(cfg.pricing.default);
  return undefined;
}

/**
 * Synthetic x402 route of a priced tool. x402 matches routes case-insensitively
 * and treats `*`, `:name` and `[x]` as patterns, so raw tool names could
 * collide; the hex encoding of the UTF-8 name is collision-free and inert.
 */
export function routeForTool(name: string): string {
  return `/tools/${Buffer.from(name, "utf8").toString("hex")}`;
}

/** Immutable snapshot of the upstream tool list and its paywall. Replaced atomically on refresh. */
export interface ToolTable {
  readonly http: x402HTTPResourceServer;
  /** Tools as listed to buyers (priced ones carry the price annotation). */
  readonly visibleTools: Tool[];
  readonly pricedToolNames: string[];
  readonly freeToolNames: string[];
  readonly hiddenToolNames: string[];
  policyOf(name: string): ToolPolicy | undefined;
  routeFor(name: string): string;
}

export function buildToolTable(cfg: CascetConfig, rail: PaymentRail, tools: Tool[]): ToolTable {
  const policies = new Map<string, ToolPolicy>();
  const visibleTools: Tool[] = [];
  const pricedToolNames: string[] = [];
  const freeToolNames: string[] = [];
  const hiddenToolNames: string[] = [];
  const routes: RoutesConfig = {};

  for (const tool of tools) {
    const name = tool.name;
    const policy = typeof name === "string" && name.length > 0 ? resolveToolPolicy(cfg, name) : undefined;
    if (!policy) {
      hiddenToolNames.push(String(name));
      continue;
    }
    policies.set(name, policy);
    if (policy.kind === "free") {
      freeToolNames.push(name);
      visibleTools.push(tool);
      continue;
    }
    pricedToolNames.push(name);
    routes[`POST ${routeForTool(name)}`] = {
      // One entry per accepted token, in config order: x402 buyers take the first one they can pay.
      accepts: policy.accepts.map(({ asset, amount }) => ({
        scheme: "exact",
        price: assetAmountFor(asset, amount),
        network: rail.network,
        payTo: rail.payTo,
        maxTimeoutSeconds: rail.maxTimeoutSeconds,
      })),
      description: policy.price.description ?? `Paid MCP tool: ${name}`,
      mimeType: "application/json",
      serviceName: cfg.name,
    };
    visibleTools.push({
      ...tool,
      description: `${tool.description ?? ""} [PAID: ${policy.price.price} per call via x402/Casper]`.trim(),
      _meta: { ...tool._meta, cascet: { priceUsd: policy.price.price, network: cfg.network } },
    });
  }

  const http = new x402HTTPResourceServer(rail.resourceServer, routes);
  return {
    http,
    visibleTools,
    pricedToolNames,
    freeToolNames,
    hiddenToolNames,
    policyOf: name => policies.get(name),
    routeFor: routeForTool,
  };
}

/** Configured tool names (priced or free) that the upstream does not offer, i.e. probable typos. */
export function unmatchedConfiguredTools(cfg: CascetConfig, tools: Tool[]): string[] {
  const offered = new Set(tools.map(t => t.name));
  return [...Object.keys(cfg.pricing.tools), ...cfg.pricing.freeTools].filter(name => !offered.has(name));
}
