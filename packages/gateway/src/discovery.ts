import type { CascetConfig } from "@cascet/core";
import type { PaymentRail, ToolTable } from "./paywall.js";

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
    maxTimeoutSeconds: number;
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

/** Build a Bazaar discovery catalog for every paid tool this gateway currently exposes. */
export function buildDiscovery(
  cfg: CascetConfig,
  rail: Pick<PaymentRail, "asset" | "payTo" | "maxTimeoutSeconds">,
  table: Pick<ToolTable, "pricedToolNames" | "policyOf">,
  baseUrl: string,
  nowIso: string,
): DiscoveryDocument {
  const items: DiscoveryResource[] = [];
  for (const tool of table.pricedToolNames) {
    const policy = table.policyOf(tool);
    if (!policy || policy.kind !== "paid") continue;
    items.push({
      resource: `${baseUrl}/tools/${encodeURIComponent(tool)}`,
      type: "http",
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: cfg.network,
          amount: policy.amount,
          asset: rail.asset,
          payTo: rail.payTo,
          maxTimeoutSeconds: rail.maxTimeoutSeconds,
        },
      ],
      lastUpdated: nowIso,
      metadata: {
        description:
          policy.price.description ?? `Paid MCP tool "${tool}" on ${cfg.name}, ${policy.price.price} per call via x402 on Casper`,
        protocol: "mcp",
        server: cfg.name,
        mcpEndpoint: `${baseUrl}/mcp`,
        tool,
      },
    });
  }
  return { x402Version: 2, items };
}
