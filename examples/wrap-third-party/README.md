# Wrapping a third-party MCP server with CasCet

This example puts a CasCet paywall in front of the official reference server
[`@modelcontextprotocol/server-everything`](https://www.npmjs.com/package/@modelcontextprotocol/server-everything),
started with `npx` and not modified in any way. It runs on **Casper testnet**
and sells **three** of the server's tools per call over x402:

| Tool | Price | Raw token units | Notes |
| --- | --- | --- | --- |
| `echo` | $0.001 | 50,000,000 | |
| `get-sum` | $0.002 | 100,000,000 | |
| `trigger-long-running-operation` | $0.05 | 2,500,000,000 | `settleBeforeExecute`: the payment settles on-chain before the job starts |

Prices are converted at `asset.tokensPerUsd` (50 tokens per USD) with 9
decimals, so 1 token is 1,000,000,000 raw units.

`trigger-long-running-operation` is paid before it runs: the gateway waits
until the settlement has executed on-chain, then starts the job, which runs for
`duration` seconds (10 by default; the buyer picks the value). If settlement and
`duration` together take longer than the bridge's per-call deadline
(`CASCET_TIMEOUT_MS`, 30 s by default), the payment is final but the result
never reaches the MCP host. Step 5 therefore raises the deadline to 90 s. Keep
`duration` well below that, and below the gateway's upstream timeout
(`timeouts.upstreamMs`, 60 s by default).

`get-tiny-image` stays free because it is listed in `pricing.freeTools`.
Every other tool of the upstream server is neither priced nor free, so the
gateway hides it from `tools/list` and rejects calls to it. That matters here:
`get-env` returns the environment of the process it runs in, and
`gzip-file-as-resource` fetches URLs you give it. Neither should ever be
reachable through a paid gateway.

The upstream version is pinned (`server-everything@2026.8.31`) so the tool set
under the paywall cannot change when a new version of that package is
published. Check the tool list again before you move the pin.

## What you need

- Node.js 22 or newer, pnpm, and a clone of this repository (the self-hosted
  facilitator lives in `tools/e2e`; it is not published to npm).
- The CasCet CLI of this checkout, **0.1.1 or later**
  (`node packages/cli/dist/cli.js --version` after `pnpm build`). Every command
  below runs it from there. Never run this example with the published
  `@cascet/cli` 0.1.0: its gateway listens on every network interface, allows
  any website (CORS `*`) and passes every unpriced tool through for free, so it
  would serve `get-env` (the gateway's whole environment) and
  `gzip-file-as-resource` (fetches any URL) to anyone who can reach it, and its
  `connect` silently ignores the allowlist and budget variables.
- Three Casper testnet key pairs (ed25519 PEM files):
  - **seller**: receives the payments;
  - **fee payer**: the facilitator pays the gas for each settlement from this
    account, so it needs testnet CSPR;
  - **buyer**: the agent's wallet, which needs payment tokens.

  For a quick start, `pnpm --filter @cascet/e2e gen-keys` writes throwaway keys
  to `tools/e2e/keys/` (the folder is gitignored). Use `seller-data.pem` as the
  seller, `analyst.pem` as the fee payer and `agent.pem` as the buyer; each
  `.pub` file next to them holds the public key in hex. ed25519 keys from
  `casper-client keygen` work just as well. Never fund these keys on mainnet.

## Funding (testnet)

- **Fee payer:** import the key into Casper Wallet and request testnet CSPR
  from the faucet at <https://testnet.cspr.live/tools/faucet>.
- **Buyer:** the payment token is CasCet's testnet x402 token
  (`hash-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3`,
  9 decimals). Its supply is held by the CasCet maintainers, so open a
  [GitHub issue](https://github.com/mericcintosun/CasCet/issues) titled
  "Testnet x402 tokens" with the buyer's account hash, and a maintainer sends
  you some.

The buyer needs no CSPR: the facilitator pays the gas.

## Run it

All commands run from the repository root.

```bash
pnpm install --frozen-lockfile && pnpm build

# 1. payTo is the seller's account hash ("00" + 64 hex), never a public key.
node packages/cli/dist/cli.js account-hash "$(cat tools/e2e/keys/seller-data.pub)"
#    Paste the printed value into "payTo" in examples/wrap-third-party/cascet.config.json.

# 2. Start the self-hosted facilitator (testnet, 127.0.0.1:4501). It only
#    settles payments to the seller's account hash and in the testnet x402 token.
#    pnpm runs it from tools/e2e, so pass the key as an absolute path.
CASCET_FACILITATOR_KEY="$PWD/tools/e2e/keys/analyst.pem" \
CASCET_SELLER_ACCOUNT_HASH=<the 00... value from step 1> \
pnpm --filter @cascet/e2e facilitator

# 3. In a second terminal, start the paid gateway (127.0.0.1:4410).
node packages/cli/dist/cli.js wrap examples/wrap-third-party/cascet.config.json

# 4. Discover the paid tools (x402 Bazaar format).
curl http://127.0.0.1:4410/.well-known/x402.json

# 5. The paying bridge. Your MCP host starts it: register this command and
#    these variables (with absolute paths) as a stdio MCP server, as shown under
#    "Point an agent at it" in the main README.
CASCET_KEY_PATH=tools/e2e/keys/agent.pem \
CASCET_NETWORK=casper:casper-test \
CASCET_ALLOWED_PAYTO=<the 00... value from step 1> \
CASCET_ALLOWED_ASSETS=hash-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3 \
CASCET_MAX_PER_CALL=2500000000 \
CASCET_MAX_SESSION=10000000000 \
CASCET_TIMEOUT_MS=90000 \
node packages/cli/dist/cli.js connect http://127.0.0.1:4410/mcp
```

`connect` refuses to start without the payTo and asset allowlists and without
both budgets. The bridge then pays only this seller, only in this token, only
on testnet, at most 2.5 tokens per call and 10 tokens per session, and gives
each call up to 90 s.

If the facilitator should be reachable from anywhere but this machine, start
it with a secret `CASCET_FACILITATOR_TOKEN` and put the same value in
`facilitator.apiKey`; the gateway sends it in the `Authorization` header.

## Why the self-hosted facilitator?

The hosted CSPR.cloud facilitator only settles CEP-3009 tokens whose
`transfer_with_authorization` takes a `value` argument (for example the
official Wrapped CSPR). CasCet's x402 tokens, on testnet and on mainnet, are the
earlier reference build that takes `amount`, so the hosted facilitator cannot
settle them. The self-hosted facilitator in `tools/e2e` is built on
`@make-software/casper-x402` 1.0.0, which sends `amount`. Background and
transaction evidence: [`docs/onchain.md`](../../docs/onchain.md#why-cascet-runs-its-own-x402-facilitator).

The upstream server is unmodified: CasCet adds the paywall, receipts and
discovery around it.
