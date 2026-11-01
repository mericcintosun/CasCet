import { x402HTTPResourceServer, x402ResourceServer, type RoutesConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { usdPriceToTokenUnits, type CascetConfig, type ToolPrice } from "@cascet/core";
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

/**
 * How long an authorization must still be valid when it arrives: the
 * facilitator's verify, then (in the default run-then-settle mode) the tool
 * run, must leave SETTLE_HEADROOM_SECONDS for the settle transaction.
 */
export function requiredValiditySeconds(cfg: CascetConfig, settleBeforeExecute: boolean): number {
  const beforeSettleMs = cfg.timeouts.facilitatorMs + (settleBeforeExecute ? 0 : cfg.timeouts.upstreamMs);
  return Math.ceil(beforeSettleMs / 1_000) + SETTLE_HEADROOM_SECONDS;
}

/**
 * The window must cover verifying, running the tool and settling afterwards,
 * so it grows with the configured timeouts; never below x402's customary 300 s.
 */
export function maxTimeoutSecondsFor(cfg: CascetConfig): number {
  const { facilitatorMs, upstreamMs, settleMs } = cfg.timeouts;
  return Math.max(300, Math.ceil((facilitatorMs + upstreamMs + settleMs) / 1_000) + SETTLE_HEADROOM_SECONDS);
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

/** Create the x402 resource server and load the facilitator's supported kinds. */
export async function createPaymentRail(cfg: CascetConfig): Promise<PaymentRail> {
  const network = cfg.network as Network;
  const asset = cfg.asset.packageHash.toLowerCase().replace(/^hash-/, "");
  const payTo = settleablePayTo(cfg.payTo);
  if (!/^[0-9a-f]{64}$/.test(asset)) throw new Error("asset.packageHash must be 64 hex characters (optionally prefixed with hash-)");
  const facilitator = new TimeoutFacilitatorClient({
    url: cfg.facilitator.url,
    authorization: cfg.facilitator.apiKey,
    verifyTimeoutMs: cfg.timeouts.facilitatorMs,
    settleTimeoutMs: cfg.timeouts.settleMs,
  });
  const scheme = new CascetCasperServerScheme([{ network, asset, decimals: cfg.asset.decimals }]);
  const resourceServer = new x402ResourceServer(facilitator).register(network, scheme);
  await resourceServer.initialize();
  if (!resourceServer.getSupportedKind(2, network, "exact")) {
    throw new Error(`facilitator ${cfg.facilitator.url} does not support x402 v2 "exact" payments on ${network}`);
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
          price: {
            asset: rail.asset,
            amount: policy.amount,
            extra: {
              name: cfg.asset.name,
              symbol: cfg.asset.symbol,
              version: cfg.asset.version,
              decimals: String(cfg.asset.decimals),
            },
          },
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
