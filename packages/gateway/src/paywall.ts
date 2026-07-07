import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorConfig,
  type RoutesConfig,
} from "@x402/core/server";
import type { AssetAmount, Network } from "@x402/core/types";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/server";
import { usdPriceToTokenUnits, type CascetConfig, type ToolPrice } from "@cascet/core";

export interface Paywall {
  http: x402HTTPResourceServer;
  /** Resolve the configured price of a tool ("$0.05"), or undefined if the tool is free. */
  priceOf: (tool: string) => ToolPrice | undefined;
  /** Convert a tool's price into the CEP-18 AssetAmount buyers must authorize. */
  assetAmountOf: (tool: string) => AssetAmount | undefined;
  /** Synthetic route path used for a tool inside the x402 route table. */
  routeFor: (tool: string) => string;
}

/**
 * Build the x402 resource server for a CasCet gateway.
 *
 * MCP speaks JSON-RPC over a single HTTP endpoint, so per-tool pricing cannot
 * use per-route middleware directly. Instead each priced tool gets a synthetic
 * route (`POST /tools/<name>`) in the x402 route table, and the MCP handler
 * dispatches into `processHTTPRequest` with that synthetic path.
 */
export async function buildPaywall(cfg: CascetConfig, toolNames: string[]): Promise<Paywall> {
  const network = cfg.network as Network;
  const assetPackage = cfg.asset.packageHash.replace(/^hash-/, "");

  const facilitatorConfig: FacilitatorConfig = { url: cfg.facilitator.url };
  if (cfg.facilitator.apiKey) {
    const auth = { Authorization: cfg.facilitator.apiKey };
    facilitatorConfig.createAuthHeaders = async () => ({
      verify: auth,
      settle: auth,
      supported: auth,
      bazaar: auth,
    });
  }
  const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);

  const scheme = new ExactCasperScheme().registerAsset(network, assetPackage, cfg.asset.decimals);
  const resourceServer = new x402ResourceServer(facilitatorClient).register(network, scheme);

  const priceOf = (tool: string): ToolPrice | undefined =>
    cfg.pricing.tools[tool] ?? cfg.pricing.default;

  const assetAmountOf = (tool: string): AssetAmount | undefined => {
    const price = priceOf(tool);
    if (!price) return undefined;
    return {
      asset: assetPackage,
      amount: usdPriceToTokenUnits(price.price, cfg.asset).toString(),
      extra: {
        name: cfg.asset.name,
        symbol: cfg.asset.symbol,
        version: cfg.asset.version,
        decimals: String(cfg.asset.decimals),
      },
    };
  };

  const routeFor = (tool: string) => `/tools/${tool}`;

  const routes: RoutesConfig = {};
  for (const tool of toolNames) {
    const amount = assetAmountOf(tool);
    if (!amount) continue;
    routes[`POST ${routeFor(tool)}`] = {
      accepts: [{ scheme: "exact", price: amount, network, payTo: cfg.payTo }],
      description: priceOf(tool)?.description ?? `Paid MCP tool: ${tool}`,
      mimeType: "application/json",
      serviceName: cfg.name,
    };
  }

  const http = new x402HTTPResourceServer(resourceServer, routes);
  await http.initialize();
  return { http, priceOf, assetAmountOf, routeFor };
}
