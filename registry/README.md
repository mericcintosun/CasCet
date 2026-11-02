# MCP Registry listing

[`server.json`](server.json) describes CasCet's flagship paid MCP server,
`casper-defi-data` (CSPR market data, tokenized RWA prices, Casper DeFi yields),
for the [official MCP Registry](https://registry.modelcontextprotocol.io) as
`io.github.mericcintosun/cascet-casper-defi-data`.

It is a **Casper testnet** listing: buyers pay per call over x402 with test
tokens that have no monetary value. The entry is a remote (`streamable-http`)
server, so it lists a public gateway URL and no npm package.

The [`Publish to MCP Registry`](../.github/workflows/mcp-registry.yml) workflow
publishes it. It authenticates with GitHub OIDC, so it needs no secret, and it
runs only when started by hand. Two manual steps come first.

## Step 1: host a public gateway and put its URL into server.json

The registry requires the remote URL to be publicly reachable over HTTPS, and a
remote URL can belong to only one server name.

1. On the host, clone this repository and build it
   (`pnpm install --frozen-lockfile && pnpm build`). The steps below run the
   CLI of this checkout (`node packages/cli/dist/cli.js`), never the npm 0.1.0,
   whose gateway serves every unpriced tool for free on all interfaces. The
   checkout's `--version` prints `0.1.0` until the 0.1.1 release bumps its
   packages, which is expected; the npm 0.1.0 has no `--version` and prints its
   usage text instead.
2. Copy [`casper-defi-data.config.json`](casper-defi-data.config.json), set
   `payTo` to the seller's account hash
   (`node packages/cli/dist/cli.js account-hash <seller-public-key-hex>`, which
   prints `00` + 64 hex), and fund the accounts as described in
   [`examples/wrap-third-party`](../examples/wrap-third-party/README.md#funding-testnet).
   For a live staking APY in `get_defi_yields`, also add
   `"env": { "CSPR_CLOUD_TOKEN": "<your cspr.cloud token>" }` to `upstream`:
   the gateway passes none of its own environment to the server. Your copy
   then holds a secret, so keep it out of git.
3. Start the self-hosted facilitator next to the gateway. It listens on
   127.0.0.1:4501 and settles only payments to that seller in the testnet x402
   token:

   ```bash
   CASCET_FACILITATOR_KEY=/absolute/path/to/fee-payer.pem \
   CASCET_SELLER_ACCOUNT_HASH=00<seller account hash> \
   pnpm --filter @cascet/e2e facilitator
   ```

   If you also set `CASCET_FACILITATOR_TOKEN`, put the same value into
   `facilitator.apiKey` in the gateway config.
4. Start the gateway from the repository root. It stays on 127.0.0.1:4402:

   ```bash
   node packages/cli/dist/cli.js wrap path/to/your/casper-defi-data.config.json
   ```

5. Put an HTTPS reverse proxy or tunnel in front of it, for example
   `caddy reverse-proxy --from mcp.example.com --to 127.0.0.1:4402`.
   Do not expose the facilitator.
6. Check that `https://mcp.example.com/.well-known/x402.json` lists the three
   priced tools, then replace `https://REPLACE-WITH-PUBLIC-GATEWAY/mcp` in
   `server.json` with your URL, for example `https://mcp.example.com/mcp`.
   Commit that change to `main`.

## Step 2: run the workflow

In GitHub, open **Actions → Publish to MCP Registry → Run workflow** on `main`.
The job:

1. refuses to continue while `server.json` still has the placeholder URL, if
   the URL is not `https://`, or if it does not answer an MCP `initialize`
   request with HTTP 200;
2. downloads the pinned `mcp-publisher` release and verifies its Sigstore
   signature;
3. runs `mcp-publisher validate`, logs in with `github-oidc` and publishes.

Every publish needs a new `version` in `server.json`; raise it before you run
the workflow again. To check the result:
<https://registry.modelcontextprotocol.io/v0/servers?search=cascet>.

Keep the listing honest: it must stay marked as testnet until the gateway
settles on mainnet. A mainnet listing should also wait for the external audit
described in [`SECURITY.md`](../SECURITY.md).
