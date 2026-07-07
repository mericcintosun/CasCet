<div align="center">

# CasCet

**Turn any MCP server into a paid service — per-tool x402 micropayments with cascading agent-to-agent payment chains, settled instantly on Casper.**

Casper Agentic Buildathon 2026 · Casper Innovation Track

[Architecture](#architecture) · [Quickstart](#quickstart) · [How it works](#how-it-works) · [Contracts](#on-chain-layer) · [Roadmap](#roadmap)

</div>

---

## The problem

AI agents reach the outside world through **MCP servers** — small services that expose tools (fetch a price, run an analysis, query a chain). Thousands of developers ship them. Almost all of them are **free**, because there is no clean way to charge an autonomous agent per call: an agent can't fill in a credit-card form or manage a subscription.

x402 (HTTP 402 "Payment Required") fixes the payment primitive. But every x402 tool today is a **static vending machine** and, crucially, **point-to-point**: an agent pays a server, the server answers, done. Real agent workloads aren't shaped like that. A "portfolio analysis" tool internally needs a "price feed" tool and an "RWA data" tool — each of which is itself a paid service. Nobody is settling those **payment chains**.

## What CasCet does

CasCet is the **monetization layer for MCP on Casper** — think *Stripe for MCP servers* — plus the piece no one has shipped: **composable, multi-hop (cascading) payments**.

1. **Wrap** — `cascet wrap` puts a paywall in front of any existing MCP server. Set a price per tool; agents pay per call in CEP-18 over x402; you keep the tool code unchanged.
2. **Connect** — `cascet connect` is a stdio bridge so any MCP host (Claude Code, Claude Desktop, Cursor) can call paid servers, answering 402 challenges automatically under a spending budget.
3. **Cascade** — when a paid tool itself buys from other paid tools, CasCet composes the payments into a chain, links every hop to its parent, and enforces revenue splits on-chain.
4. **See it** — a live dashboard shows revenue, receipts (with cspr.live settlement links) and the cascading payment graph in real time.

### Why Casper

This is not a portable pattern dressed in Casper branding — it leans on things Casper does that alternatives don't:

- **Zug instant deterministic finality** — a 3-hop payment chain would stall waiting on probabilistic finality; on Casper each hop settles in seconds, with certainty. Cascades are only pleasant here.
- **On-chain revenue splits** via an Odra contract — a server's earnings can be split between co-authors at the contract level (Casper's native multi-party model), not by trusting an off-chain ledger.
- **Predictable fees** — agents can budget spending because gas is predictable.

> **Positioning (honest):** paid-MCP is a proven pattern off-Casper (MCPay, xpay, Cloudflare). Casper shipped native x402 in June 2026 and has **no** MCP monetization layer yet. CasCet brings it first — **and** ships the first composable multi-hop payment chains with on-chain revenue splits.

---

## Architecture

```
┌─────────────┐   MCP tool call     ┌──────────────────────┐   upstream MCP    ┌────────────────────┐
│ MCP host    │ ──────────────────▶ │  CasCet gateway      │ ────────────────▶ │ your MCP server    │
│ (Claude…)   │ ◀── 402 + price ─── │  (cascet wrap)       │                   │ (unchanged)        │
│  + cascet   │ ── pay (x402) ────▶ │  · per-tool pricing  │                   └────────────────────┘
│    connect  │ ◀── result + rcpt ─ │  · charge-on-success │
└─────────────┘                     │  · receipt store     │
      │                             └──────────┬───────────┘
      │ CEP-18 authorization                   │ event push
      ▼                                         ▼
┌─────────────────────┐              ┌────────────────────────┐        ┌──────────────────────┐
│ x402 facilitator    │              │ CasCet dashboard       │        │ Odra contracts        │
│ (cspr.cloud, Casper)│              │ live revenue + graph   │        │ ReceiptRegistry       │
│ verify + settle     │              │ (Next.js + shadcn/ui)  │        │ RevenueSplit (CEP-18) │
└─────────────────────┘              └────────────────────────┘        └──────────────────────┘
```

### Monorepo layout

| Path | What |
| --- | --- |
| `packages/core` | Shared types, config schema, receipt + payment-graph model |
| `packages/gateway` | Seller-side proxy: wraps an MCP server, prices tools, runs the x402 flow |
| `packages/client` | Buyer-side paying `fetch` (budget guard, cascade parent propagation), stdio bridge |
| `packages/cli` | `cascet` CLI — `init` / `wrap` / `connect` |
| `servers/casper-defi-data` | Flagship paid MCP: CSPR market data, RWA prices, DeFi yields (live + labeled fallback) |
| `servers/portfolio-analyst` | Paid MCP that **buys** from the data server — the cascade in action |
| `apps/dashboard` | Next.js + shadcn/ui live dashboard (dark/light/system) |
| `contracts` | Odra 2.8.2: `ReceiptRegistry` + `RevenueSplit`, with tests |
| `tools/e2e` | Local end-to-end demo + mock facilitator (no chain needed) |

---

## Quickstart

Requirements: Node ≥ 20, pnpm, Rust + [`cargo-odra`](https://odra.dev) (for contracts).

```bash
pnpm install
pnpm build

# Run the full cascade demo locally (no chain, mock facilitator):
pnpm --filter @cascet/e2e gen-keys
pnpm --filter @cascet/e2e demo
```

You'll see an agent pay `$0.10` for `analyze_portfolio`, which autonomously spends `$0.07` buying four data tools underneath — every downstream payment linked to the root, asserted at the end.

### With the live dashboard

```bash
pnpm --filter @cascet/dashboard dev      # http://localhost:3939
pnpm --filter @cascet/e2e demo           # watch revenue + graph update live
```

### Monetize your own MCP server

```bash
npx cascet init                          # writes cascet.config.json
# edit: upstream command, payTo, asset (CEP-18), facilitator API key, per-tool prices
npx cascet wrap                          # your server is now paid
```

Point an agent at it:

```bash
CASCET_KEY_PATH=./agent.pem \
CASCET_MAX_SESSION=5000000000 \
npx cascet connect http://localhost:4402/mcp
```

---

## How it works

**The x402 flow, per tool call.** MCP speaks JSON-RPC over one HTTP endpoint, so the gateway maps each priced tool to a synthetic x402 route. On `tools/call`, the gateway returns `402 Payment Required` with the price; the agent's wallet signs a CEP-18 `transfer_with_authorization` (EIP-712) and retries; the gateway runs the tool, and **only settles payment if the tool succeeds** (a failed call is never charged). Settlement uses the hosted Casper facilitator — CasCet builds *on* the official rails, it does not reimplement verification.

**Cascading payments.** When the gateway settles a call it mints a `paymentId` and passes it to the upstream tool via `_meta`. If that tool buys from other paid tools, its paying client forwards the id as `X-CASCET-PARENT-ID`, so each downstream receipt records its parent. The full chain reconstructs from receipts alone — no central coordinator — and renders as a payment graph.

**Budgets.** The buyer client enforces per-call and per-session spend caps and aborts a payment *before signing* if it would breach them — an agent can't be drained past its allowance.

---

## On-chain layer

Two Odra contracts (Rust), unit-tested against a real CEP-18 in Odra's mock VM (`cargo odra test`, 8/8 green):

- **`ReceiptRegistry`** — anchors settled tool-call receipts on-chain, each carrying its cascade `parent_id`. Makes two things verifiable without trusting the gateway: that a call was paid, and how payments compose. Permissioned recorders, duplicate protection, events.
- **`RevenueSplit`** — an OpenZeppelin-style PaymentSplitter for CEP-18. A gateway can set its `payTo` to this contract so a server's earnings split between payees by fixed weights, pull-based, enforced on-chain.

```bash
cd contracts
cargo odra test            # run contract tests (mock VM)
cargo odra build           # build optimized wasm
# deploy to testnet: fill contracts/.env from .env.sample, then
cargo run --bin cascet_contracts_cli -- deploy
```

Network: **Casper Testnet** (`casper:casper-test`), CEP-18 payment token, `casper-eip-712` signatures.

---

## Roadmap

- **Now (qualification):** working gateway + client + CLI, two flagship paid MCP servers, cascading payments, live dashboard, two Odra contracts deployed to testnet.
- **Final round:** on-chain receipt anchoring wired into the live gateway; RevenueSplit funded by real x402 revenue with a withdraw UI; a public x402 economy explorer indexing the ReceiptRegistry; `npx cascet` published to npm.
- **Beyond:** a hosted CasCet control plane (register a server, get a paid endpoint + dashboard in one step); mainnet; per-second/streaming price schemes; an agent-facing pricing-discovery API.

## Tech

TypeScript (Node 20, pnpm workspaces), Next.js 15 + shadcn/ui, `@make-software/casper-x402` + `@x402/*`, `@modelcontextprotocol/sdk`, Rust + Odra 2.8.2, Casper Testnet.

## License

Apache-2.0. Built for the Casper Agentic Buildathon 2026.
