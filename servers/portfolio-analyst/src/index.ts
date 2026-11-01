import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { describeConfig, loadAnalystConfig } from "./config.js";
import { createAnalystServer } from "./server.js";

/**
 * Portfolio analyst MCP server — CasCet's cascading-payments flagship.
 *
 * Its `analyze_portfolio` tool is itself a PAYING CUSTOMER: it buys market
 * data from the (paid) casper-defi-data gateway using this server's own
 * Casper wallet, links those downstream payments to the inbound payment via
 * X-CASCET-PARENT-ID, and discloses its cost breakdown in the result. Inputs
 * are bought in parallel; if some cannot be bought the analysis is partial and
 * lists them in costBreakdown.failed. Settlement is per hop: a purchase is not
 * rolled back when the inbound call later fails, times out or is cancelled.
 *
 * Env (the wallet spends real tokens, so the safety settings are REQUIRED; the
 * names match `cascet connect`):
 *   DATA_GATEWAY_URL               MCP url of the paid data gateway (default http://localhost:4402/mcp);
 *                                  plain http:// only to localhost unless CASCET_ALLOW_INSECURE_HTTP=1
 *   CASCET_KEY_PATH                PEM key of THIS server's wallet
 *   CASCET_KEY_ALGO                ed25519 (default) | secp256k1
 *   CASCET_NETWORK                 comma list of CAIP-2 networks it may pay on (default casper:casper-test)
 *   CASCET_ALLOWED_PAYTO           comma list of data-seller payTo values: "00"+64 hex or account-hash-<64 hex>
 *                                  (hash-<64 hex> for a contract-package payee); never a public key, use
 *                                  `npx @cascet/cli account-hash <public-key>` to convert one
 *   CASCET_ALLOWED_ASSETS          comma list of CEP-18 package hashes it may pay in (hash-<64 hex>)
 *                                  -> both allowlists are required unless CASCET_ALLOW_ANY_SELLER=1
 *   CASCET_MAX_PER_CALL            max raw token units for ONE data purchase
 *   CASCET_MAX_SESSION             max raw token units for ALL purchases of ONE analysis (per asset)
 *                                  -> both caps are required unless CASCET_ALLOW_UNLIMITED_BUDGET=1
 *   CASCET_TIMEOUT_MS              deadline for the purchases of one analysis (default 45000); keep it
 *                                  below the inbound gateway's upstream timeout (60 s by default) so a
 *                                  partial analysis is still returned in time
 */

const log = (line: string) => console.error(`[analyst] ${line}`);

const config = loadAnalystConfig(process.env);
for (const warning of config.warnings) log(`⚠️  ${warning}`);
if (config.ok) {
  log(describeConfig(config.config));
} else {
  for (const problem of config.problems) log(`❌ config: ${problem}`);
  log("analyze_portfolio will refuse to buy anything until the configuration is fixed");
}

const server = createAnalystServer({ config, log });
await server.connect(new StdioServerTransport());
console.error("[portfolio-analyst] MCP server ready on stdio");
