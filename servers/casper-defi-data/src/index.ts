import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDataServer } from "./server.js";

/**
 * Casper DeFi & RWA data MCP server (upstream, runs behind a CasCet gateway).
 *
 * Env:
 *   CSPR_CLOUD_URL     cspr.cloud REST base (default https://api.testnet.cspr.cloud)
 *   CSPR_CLOUD_TOKEN   cspr.cloud access token for live staking yields (optional;
 *                      without it get_defi_yields returns the labeled snapshot)
 */

const server = createDataServer();
await server.connect(new StdioServerTransport());
console.error("[casper-defi-data] MCP server ready on stdio");
