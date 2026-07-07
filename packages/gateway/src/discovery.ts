import type { CascetConfig } from "@cascet/core";
import type { Paywall } from "./paywall.js";

/**
 * x402 Bazaar-compatible discovery resource.
 * Mirrors the CDP Bazaar `/discovery/resources` catalog item shape so any x402
 * agent can find CasCet-monetized MCP tools the same way it finds paid HTTP APIs.
 */
export interface DiscoveryResource {
  resource: string;
  type: "http";
  x402Version: 2;
  accepts: Array<{
    scheme: "exact";
    network: string;
    amount: string;
    asset: string;
    payTo: string;
  }>;
  lastUpdated: string;
  metadata: {
    description: string;
    protocol: "mcp";
    server: string;
    mcpEndpoint: string;
    tool: string;
  };
}

export interface DiscoveryDocument {
  x402Version: 2;
  items: DiscoveryResource[];
}

/** Build a Bazaar discovery catalog for every paid tool this gateway exposes. */
export function buildDiscovery(
  cfg: CascetConfig,
  paywall: Paywall,
  toolNames: string[],
  baseUrl: string,
  nowIso: string,
): DiscoveryDocument {
  const assetPackage = cfg.asset.packageHash.replace(/^hash-/, "");
  const items: DiscoveryResource[] = [];

  for (const tool of toolNames) {
    const amount = paywall.assetAmountOf(tool);
    if (!amount) continue; // free tools aren't advertised as payable
    const price = paywall.priceOf(tool);
    items.push({
      resource: `${baseUrl}${paywall.routeFor(tool)}`,
      type: "http",
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: cfg.network,
          amount: amount.amount,
          asset: assetPackage,
          payTo: cfg.payTo,
        },
      ],
      lastUpdated: nowIso,
      metadata: {
        description:
          price?.description ??
          `Paid MCP tool "${tool}" on ${cfg.name}, ${price?.price ?? ""} per call via x402 on Casper`.trim(),
        protocol: "mcp",
        server: cfg.name,
        mcpEndpoint: `${baseUrl}/mcp`,
        tool,
      },
    });
  }

  return { x402Version: 2, items };
}
