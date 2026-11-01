import { x402HTTPResourceServer, x402ResourceServer, type RoutesConfig } from "@x402/core/server";
import type { AssetAmount, Network } from "@x402/core/types";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  AUTHORIZATION_STYLE_EXTRA_KEY,
  facilitatorAuthorization,
  facilitatorFor,
  facilitatorTimeouts,
  isPackageHash,
  normalizePackageHash,
  usdPriceToTokenUnits,
  type CascetConfig,
  type ResolvedAsset,
  type ToolPrice,
} from "@cascet/core";
import { normalizeAccountAddress } from "./authorization.js";
import { TimeoutFacilitatorClient } from "./facilitator.js";
import { CascetCasperServerScheme } from "./server-scheme.js";

/** Seconds an authorization must still be valid when settlement starts (inclusion + execution on Casper). */
export const SETTLE_HEADROOM_SECONDS = 30;
/** Tolerated clock difference between buyer and gateway. */
export const MAX_CLOCK_SKEW_SECONDS = 120;

/** Facilitator, scheme and payment terms shared by every tool. Built once. */
export interface PaymentRail {
  resourceServer: x402ResourceServer;
  network: Network;
  /** Payee account: "00" + account hash, lowercase. */
  payTo: string;
  /** Token contract package hash, 64 lowercase hex. */
  asset: string;
  /** Validity window the gateway asks buyers to sign (x402 maxTimeoutSeconds). */
  maxTimeoutSeconds: number;
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
 * run, must leave SETTLE_HEADROOM_SECONDS for the settle transaction.
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
 * The x402 price of one `accepts` entry: `amount` raw units of `asset`, with
 * the EIP-712 domain buyers sign over (name, version), the symbol and decimals
 * for display, and the asset's authorization style. The style is server-owned
 * (x402 v2 matching makes buyers echo it) and informational: buyers may prefer
 * a style and refuse unknown ones, facilitators read the token's ABI instead.
 */
export function assetAmountFor(asset: ResolvedAsset, amount: string): AssetAmount {
  return {
    asset: asset.packageHash,
    amount,
    extra: {
      name: asset.name,
      symbol: asset.symbol,
      version: asset.version,
      decimals: String(asset.decimals),
      [AUTHORIZATION_STYLE_EXTRA_KEY]: asset.authorization,
    },
  };
}

/**
 * The asset this gateway sells in. This version settles every call in one
 * asset: a config listing several is refused at startup rather than silently
 * charging in the first one only.
 */
export function gatewayAsset(cfg: CascetConfig): ResolvedAsset {
  if (!Array.isArray(cfg.assets) || cfg.assets.length === 0) {
    throw new Error("the config lists no asset: parse it with cascetConfigSchema from @cascet/core");
  }
  if (cfg.assets.length > 1) {
    throw new Error(
      `this gateway version accepts one asset per gateway, and the config lists ${cfg.assets.length} ` +
        `(${cfg.assets.map(asset => asset.id).join(", ")}); configure a single asset`,
    );
  }
  return cfg.assets[0];
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

/** Create the x402 resource server and load the supported kinds of the asset's facilitator. */
export async function createPaymentRail(cfg: CascetConfig): Promise<PaymentRail> {
  const network = cfg.network as Network;
  const assetConfig = gatewayAsset(cfg);
  const asset = normalizePackageHash(assetConfig.packageHash);
  const payTo = settleablePayTo(cfg.payTo);
  if (!isPackageHash(asset)) throw new Error("asset.packageHash must be 64 hex characters (optionally prefixed with hash-)");
  const settler = facilitatorFor(cfg, assetConfig);
  const timeouts = facilitatorTimeouts(cfg, settler);
  const facilitator = new TimeoutFacilitatorClient({
    url: settler.url,
    authorization: facilitatorAuthorization(settler),
    verifyTimeoutMs: timeouts.verifyMs,
    settleTimeoutMs: timeouts.settleMs,
  });
  const scheme = new CascetCasperServerScheme([{ network, asset, decimals: assetConfig.decimals }]);
  const resourceServer = new x402ResourceServer(facilitator).register(network, scheme);
  await resourceServer.initialize();
  if (!resourceServer.getSupportedKind(2, network, "exact")) {
    throw new Error(`facilitator ${settler.url} does not support x402 v2 "exact" payments on ${network}`);
  }
  return {
    resourceServer,
    network,
    payTo,
    asset,
    maxTimeoutSeconds: maxTimeoutSecondsFor(cfg),
  };
}

/** What the gateway does with one upstream tool. */
export type ToolPolicy =
  | { kind: "free" }
  | {
      kind: "paid";
      price: ToolPrice;
      /** Raw token units buyers must authorize. */
      amount: string;
      settleBeforeExecute: boolean;
    };

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
    amount: usdPriceToTokenUnits(price.price, cfg.asset).toString(),
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
      accepts: [
        {
          scheme: "exact",
          price: assetAmountFor({ ...cfg.asset, packageHash: rail.asset }, policy.amount),
          network: rail.network,
          payTo: rail.payTo,
          maxTimeoutSeconds: rail.maxTimeoutSeconds,
        },
      ],
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
