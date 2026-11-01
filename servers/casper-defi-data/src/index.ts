import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDataServer } from "./server.js";

/**
 * Casper DeFi & RWA data MCP server (upstream, runs behind a CasCet gateway).
 *
 * Env:
 *   CSPR_CLOUD_URL     cspr.cloud REST base (default https://api.testnet.cspr.cloud, i.e. TESTNET
 *                      staking metrics; https://api.cspr.cloud for mainnet). The yields' source
 *                      label and network.name say which network the numbers describe.
 *   CSPR_CLOUD_TOKEN   cspr.cloud access token for live staking yields (optional;
 *                      without it get_defi_yields returns the labeled snapshot)
 *
 * A stdio upstream only sees the environment its gateway gives it. Pass
 * CSPR_CLOUD_TOKEN (and CSPR_CLOUD_URL) explicitly in the gateway config's
 * `upstream.env`; a gateway that does not forward its own environment to the
 * upstream will not pass them on by itself.
 *
 * Live answers are cached briefly (CoinGecko 60 s, cspr.cloud 10 min); when an
 * upstream fails, a recent live answer is served, labeled with its age, before
 * the dated snapshot is.
 */

const server = createDataServer();
await server.connect(new StdioServerTransport());
console.error("[casper-defi-data] MCP server ready on stdio");
