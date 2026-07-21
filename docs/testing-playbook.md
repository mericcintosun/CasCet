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

### 2. Run the full cascade end-to-end (no chain, mock facilitator)

```bash
pnpm --filter @cascet/e2e gen-keys
pnpm --filter @cascet/e2e demo
```

Expected: an agent pays `$0.10` for `analyze_portfolio`, which autonomously
spends `$0.07` buying four data tools underneath. The script asserts at the end
that every downstream payment is linked to the root cascade id, and prints the
reconstructed payment tree.

### 3. Run the autonomous buyer

```bash
pnpm --filter @cascet/e2e agent
```

Expected: a disclosure banner (reasoning runs as a clearly-labeled offline
simulation because no paid API key is bundled), then the agent reads the three
priced DeFi/RWA tools, decides which to buy, pays x402 per call under a fixed
budget, and returns a recommendation citing the purchased data. Ends with
`AGENT PASS`.

Optional — real Claude reasoning (needs your own Anthropic API credits):

```bash
CASCET_AGENT_LIVE=1 pnpm --filter @cascet/e2e agent
```

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

### 5. Real on-chain settlement (optional, needs a CSPR.cloud token)

```bash
CSPR_CLOUD_TOKEN=<your-token> pnpm --filter @cascet/e2e demo-real
```

Expected: no mock. The agent pays from its on-chain balance of a real
`transfer_with_authorization` CEP-18 token; the hosted CSPR.cloud facilitator
verifies and settles; the receipt is anchored on-chain. The script prints a
`testnet.cspr.live` transaction link you can open.

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
