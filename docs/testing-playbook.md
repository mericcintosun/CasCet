# CasCet — Testing Playbook

Step-by-step instructions to verify CasCet works. No marketing. Each step lists
the command and what you should observe.

## Option A — Try it without installing (2 minutes)

1. Open the live app: <https://cascet.vercel.app>
2. Open the interactive playground: <https://cascet.vercel.app/playground>
   - Move the budget and price sliders. The cascade tree redraws and shows which
     calls are affordable. Lower the deposit below the tree cost and the tree
     enters a "budget exceeded" state (the on-chain rule the contract enforces).
3. Watch the demo video (linked on the BUIDL page and in the README) for a full
   run: the agent prices tools, buys, pays, and settles on Casper.

## Option B — Run it locally (10 minutes)

### Prerequisites

- Node.js >= 20
- pnpm 10.20.0 (`corepack enable`)
- (Contracts only) Rust + [`cargo-odra`](https://odra.dev)

### 1. Install and build

```bash
git clone https://github.com/mericcintosun/CasCet.git
cd CasCet
pnpm install
pnpm build
```

Expected: all workspace packages build with no errors.

### 2. Run the full cascade end-to-end (real on-chain settlement on Casper Testnet)

```bash
pnpm --filter @cascet/e2e gen-keys
pnpm --filter @cascet/e2e fund-token <analyst-account-hash> 300   # fund the analyst wallet once
pnpm --filter @cascet/e2e demo
```

Expected: an agent pays `$0.10` for `analyze_portfolio`, which autonomously
spends `$0.07` buying four data tools underneath. The script asserts at the end
that every downstream payment is linked to the root cascade id, and prints the
reconstructed payment tree.

### 3. Run the autonomous buyer

```bash
ANTHROPIC_API_KEY=<your-key> pnpm --filter @cascet/e2e agent
```

Expected: real Claude (via the Anthropic API) reads the three priced DeFi/RWA
tools, decides which to buy, pays x402 per call under a fixed budget, and returns
a recommendation citing the purchased data. Ends with `AGENT PASS`. Without
`ANTHROPIC_API_KEY` the script prints a message pointing you to the free
`connect-demo` below.

### 3b. Real Claude, live, for FREE — Claude Code via `cascet connect`

If you have the `claude` CLI logged in on a Claude Pro/Max plan (no API key
needed), this drives a **real** Claude that discovers the priced tools and buys
them through `cascet connect`, paying each x402 for real:

```bash
pnpm --filter @cascet/e2e connect-demo
```

Expected: Claude Code reads the priced DeFi/RWA tools, buys the ones it judges
worth it (typically market data + gold + treasury + yields), the connect bridge
pays each 402 under budget, and it prints a grounded allocation citing the numbers
it paid for. Ends with `CONNECT DEMO PASS — Claude bought N paid tool call(s)`.
Settlement is real on-chain either way; add `CSPR_CLOUD_TOKEN=…` only to make `get_defi_yields` compute a live staking APY instead of its labeled snapshot.

### 4. Watch it live in the dashboard

In one terminal:

```bash
pnpm --filter @cascet/dashboard dev      # http://localhost:3939
```

In a second terminal:

```bash
pnpm --filter @cascet/e2e demo
```

Expected: revenue ticks up, receipts stream in, and the payment graph branches
(agent to analyst to data server) in real time.

### 5. Real single-hop settlement

```bash
pnpm --filter @cascet/e2e demo-real
```

Expected: the agent pays from its on-chain balance of a real
`transfer_with_authorization` CEP-18 token; a self-hosted x402 facilitator
(fee-sponsored by the CasCet deployer key) verifies and settles; the receipt is
anchored on-chain. The script prints a `testnet.cspr.live` transaction link you
can open — e.g. `0218ff4c…`.

### 6. Smart contract tests

```bash
cd contracts
cargo odra test
```

Expected: the Odra unit tests pass (13/13) in the mock VM against a real CEP-18.

## Verify the on-chain artifacts directly

Every contract and the sample transactions are listed in
[`docs/buidl-page.md`](buidl-page.md) with `testnet.cspr.live` links. Open any of
them to confirm the deploys and settlements are real on Casper Testnet.

## Monetize your own MCP server (the product surface)

```bash
npx @cascet/cli init          # writes cascet.config.json (set upstream, payTo, prices)
npx @cascet/cli wrap          # your MCP server is now paid, no code changes
```

Point an agent at it:

```bash
CASCET_KEY_PATH=./agent.pem \
CASCET_MAX_SESSION=5000000000 \
npx @cascet/cli connect http://localhost:4402/mcp
```
