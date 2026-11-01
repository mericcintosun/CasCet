import {
  DEFAULT_FACILITATOR_URL,
  DEFAULT_SELF_HOSTED_FACILITATOR_URL,
  KNOWN_CEP3009_ASSETS,
  NETWORK_CASPER_MAINNET,
  NETWORK_CASPER_TESTNET,
} from "@cascet/core";

/** Left in the template on purpose: `cascet wrap` refuses to start until it is replaced. */
export const PAYTO_PLACEHOLDER = "<00 + your 64-hex account hash: run npx @cascet/cli account-hash <your public key>>";

/**
 * CasCet's testnet x402 token: a Cep18X402 build whose transfer_with_authorization
 * takes `amount`, which the self-hosted facilitator (casper-x402 1.0.0) settles.
 */
export const CASCET_TESTNET_X402_TOKEN = "hash-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";

/** Starter cascet.config.json: testnet, self-hosted facilitator, CasCet's testnet x402 token. */
export function initTemplate(name: string): Record<string, unknown> {
  return {
    name,
    upstream: { type: "stdio", command: "node", args: ["./my-mcp-server.js"] },
    network: NETWORK_CASPER_TESTNET,
    payTo: PAYTO_PLACEHOLDER,
    asset: {
      packageHash: CASCET_TESTNET_X402_TOKEN,
      // Must equal the token's EIP-712 domain name and version, or signatures will not verify.
      name: "CasCet X402 Token",
      symbol: "WCSPR",
      decimals: 9,
      version: "1",
      tokensPerUsd: 50,
    },
    facilitator: { url: DEFAULT_SELF_HOSTED_FACILITATOR_URL },
    pricing: { tools: { my_tool: { price: "$0.01", description: "example priced tool" } } },
    port: 4402,
  };
}

/** What to do after `cascet init`, printed to the terminal. */
export function initNextSteps(): string {
  const wcsprTestnet = KNOWN_CEP3009_ASSETS[NETWORK_CASPER_TESTNET]?.[0] ?? "";
  const wcsprMainnet = KNOWN_CEP3009_ASSETS[NETWORK_CASPER_MAINNET]?.[0] ?? "";
  return [
    "Next steps:",
    "  1. payTo is your ACCOUNT HASH, not your public key. Get it with",
    "       npx @cascet/cli account-hash <your public key (01... or 02...)>",
    '     and paste the printed 00... value into "payTo".',
    `  2. The template settles through a self-hosted facilitator at ${DEFAULT_SELF_HOSTED_FACILITATOR_URL},`,
    "     paying in CasCet's testnet x402 token, whose transfer_with_authorization takes `amount`.",
    "     Start the facilitator from a CasCet checkout (https://github.com/mericcintosun/CasCet):",
    "       pnpm install && pnpm build",
    "       CASCET_FACILITATOR_KEY=/absolute/path/fee-payer.pem CASCET_SELLER_ACCOUNT_HASH=<your payTo> \\",
    "         pnpm --filter @cascet/e2e facilitator",
    "     The fee-payer key pays the CSPR gas of every settlement: fund it with testnet CSPR and keep it",
    "     separate from your payTo account.",
    `     The hosted facilitator (${DEFAULT_FACILITATOR_URL}, CSPR.cloud token in facilitator.apiKey)`,
    "     only settles CEP-3009 tokens that take `value`, such as the official Wrapped CSPR",
    `     (testnet hash-${wcsprTestnet},`,
    `      mainnet hash-${wcsprMainnet}); it cannot settle CasCet's token.`,
    "  3. Price your tools under pricing.tools, then start the paid gateway:",
    "       npx @cascet/cli wrap",
  ].join("\n");
}
