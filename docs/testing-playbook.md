# CasCet — Testing Playbook

Step-by-step instructions to verify CasCet works. No marketing. Each step lists
the command, what it needs, and what you should observe.

CasCet is live on Casper mainnet with real funds and has not been externally
audited yet (internal multi-agent review on 2026-10-20; external audit planned;
see [`SECURITY.md`](../SECURITY.md)). Everything below runs on testnet or
without a chain, except where it says mainnet.

## Option A — Try it without installing (2 minutes)

1. Open the live app: <https://cascet.vercel.app>
2. Open the interactive playground: <https://cascet.vercel.app/playground>
   - Move the budget and price sliders. The cascade tree redraws and shows which
     calls are affordable. Lower the deposit below the tree cost and the tree
     enters a "budget exceeded" state (the rule the `CascadeController` contract
     enforces).
3. Watch the demo video (linked on the BUIDL page and in the README) for a full
   run: the agent prices tools, buys, pays, and settles on Casper.

## Option B — Build and test locally (no keys, no chain; 10 minutes)

### Prerequisites

- Node.js 22 or newer
- pnpm 10.20.0 (`corepack enable`)
- (Contracts only) Rust; rustup installs the toolchain pinned in
  `contracts/rust-toolchain`
- (Python client only) Python 3

### 1. Install, build, typecheck

```bash
git clone https://github.com/mericcintosun/CasCet.git
cd CasCet
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
```

Expected: the install uses the committed lockfile unchanged, and every workspace
package builds and typechecks with no errors.

### 2. Unit tests

```bash
pnpm test
```

Expected: every package that has tests runs them with Node's built-in test
runner, and all pass.

Python client (when `clients/python/tests` exists):

```bash
python3 -m pip install -r clients/python/requirements.txt
PYTHONPATH=clients/python python3 -m unittest discover -s clients/python/tests
```

### 3. Smart contract tests

```bash
cd contracts
cargo fmt --check
cargo clippy --all-targets
cargo test        # or: cargo odra test
```

Expected: formatting and clippy are clean, and the Odra unit tests pass in the
mock VM against a real CEP-18.

### 4. Dashboard

```bash
pnpm --filter @cascet/dashboard dev      # http://localhost:3939
```

Expected: the landing page, `/playground` and `/build` work. The on-chain views
need a CSPR.cloud access token in `CSPR_CLOUD_TOKEN`; without it they stay empty.

## Option C — A real paid call on testnet, with your own keys

Follow [`examples/wrap-third-party`](../examples/wrap-third-party/README.md). It
runs the CLI of your checkout (`node packages/cli/dist/cli.js`, after
`pnpm build`), never the unsupported npm 0.1.0. In short:

1. Make three testnet keys (seller, facilitator fee payer, buyer), fund the fee
   payer from the faucet, and ask for test tokens for the buyer in a GitHub
   issue.
2. `node packages/cli/dist/cli.js account-hash <seller public key>` gives the
   `payTo`.
3. Start the self-hosted facilitator
   (`CASCET_FACILITATOR_KEY=… CASCET_SELLER_ACCOUNT_HASH=… pnpm --filter @cascet/e2e facilitator`),
   then the gateway
   (`node packages/cli/dist/cli.js wrap examples/wrap-third-party/cascet.config.json`).
4. Connect an MCP host with `node packages/cli/dist/cli.js connect` and the
   allowlist, network, budget and timeout variables shown in the example.

Expected:

- `curl http://127.0.0.1:4410/.well-known/x402.json` lists exactly three priced
  tools (`echo`, `get-sum`, `trigger-long-running-operation`).
- `tools/list` through the bridge shows those three plus the free
  `get-tiny-image`; `get-env` and the other unlisted tools do not appear, and a
  direct call to them is rejected.
- A paid call returns its result, the facilitator logs `settled tx=…`, and the
  transaction is visible on `testnet.cspr.live`.
- `connect` refuses to start if you leave out an allowlist or a budget.

## Option D — Maintainer demos (need the CasCet operator keys)

These scripts sign with the operator keys in `contracts/keys/`, which are not in
the repository, so they only run on a maintainer's machine. They produced the
transactions linked in the README and in [`buidl-page.md`](buidl-page.md).

### Full cascade, real settlement on testnet

```bash
pnpm --filter @cascet/e2e gen-keys
pnpm --filter @cascet/e2e fund-token <analyst-account-hash> 300   # fund the analyst wallet once
pnpm --filter @cascet/e2e demo
```

Expected: an agent pays `$0.10` for `analyze_portfolio`, which autonomously
spends `$0.07` buying four data tools underneath. The script asserts at the end
that every downstream payment is linked to the root cascade id, and prints the
reconstructed payment tree. With the dashboard running (Option B, step 4), the
revenue ticks up, receipts stream in, and the payment graph branches (agent to
analyst to data server) in real time.

### Autonomous buyer

```bash
ANTHROPIC_API_KEY=<your-key> pnpm --filter @cascet/e2e agent
```

Expected: real Claude (via the Anthropic API) reads the three priced DeFi/RWA
tools, decides which to buy, pays x402 per call under a fixed budget enforced by
the paying client, and returns a recommendation citing the purchased data. Ends
with `AGENT PASS`. Without `ANTHROPIC_API_KEY` the script points you to
`connect-demo`.

### Real Claude through `cascet connect`

If the `claude` CLI is logged in on a Claude Pro/Max plan (no API key needed),
this drives a **real** Claude that discovers the priced tools and buys them
through `cascet connect`, paying each x402 for real:

```bash
pnpm --filter @cascet/e2e connect-demo
```

Expected: Claude Code reads the priced DeFi/RWA tools, buys the ones it judges
worth it (typically market data + gold + treasury + yields), the connect bridge
pays each 402 under budget, and it prints a grounded allocation citing the numbers
it paid for. Ends with `CONNECT DEMO PASS — Claude bought N paid tool call(s)`.
Add `CSPR_CLOUD_TOKEN=…` only to make `get_defi_yields` compute a live staking APY
instead of its labeled snapshot.

### Single-hop settlement: testnet and mainnet

```bash
pnpm --filter @cascet/e2e demo-real            # testnet
pnpm --filter @cascet/e2e demo-real-mainnet    # MAINNET, real funds
```

Expected: the agent pays from its on-chain balance of the x402 token; the
self-hosted facilitator verifies and settles; the receipt is anchored on-chain.
The script prints the transaction link (e.g. testnet `0218ff4c…`, mainnet
`2c66141c…`).

### Python client

```bash
pnpm --filter @cascet/e2e facilitator     # in one terminal (variables: see the README)
clients/python/venv/bin/python clients/python/example_settle.py
```

Expected: a Python-signed authorization settles through the facilitator; see
[`clients/python/README.md`](../clients/python/README.md) for setup and the
mainnet switch.

## Verify the on-chain artifacts directly

Every contract and sample transaction is listed in
[`buidl-page.md`](buidl-page.md) and [`onchain.md`](onchain.md), on mainnet
(`cspr.live`) and testnet (`testnet.cspr.live`). Open any of them to confirm the
deploys and settlements are real.

## Monetize your own MCP server (the product surface)

```bash
npx "@cascet/cli@^0.1.1" init                                 # writes cascet.config.json
npx "@cascet/cli@^0.1.1" account-hash <your-public-key-hex>   # your payTo ("00" + account hash)
# edit cascet.config.json: upstream, payTo, asset, facilitator.url, prices,
# pricing.freeTools and settleBeforeExecute where needed
npx "@cascet/cli@^0.1.1" wrap                                 # your MCP server is now paid
```

The quoted range never resolves to the unsupported 0.1.0: until 0.1.1 is on
npm, `npx` stops with `ETARGET`. In a clone, `node packages/cli/dist/cli.js`
runs the same commands from your checkout.

Point an agent at it (all of these limits are required by `connect`):

```bash
CASCET_KEY_PATH=./agent.pem \
CASCET_NETWORK=casper:casper-test \
CASCET_ALLOWED_PAYTO=00<seller account hash> \
CASCET_ALLOWED_ASSETS=hash-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3 \
CASCET_MAX_PER_CALL=1000000000 \
CASCET_MAX_SESSION=5000000000 \
npx "@cascet/cli@^0.1.1" connect http://127.0.0.1:4402/mcp
```

The README sections
[Monetize your own MCP server](../README.md#monetize-your-own-mcp-server) and
[Point an agent at it](../README.md#point-an-agent-at-it) explain every field and
variable, and which facilitator can settle which token.
