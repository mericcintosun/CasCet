<div align="center">

# CasCet

**Turn any MCP server into a paid service — per-tool x402 micropayments with cascading agent-to-agent payment chains, settled instantly on Casper.**

Casper Agentic Buildathon 2026 · Casper Innovation Track

[Architecture](#architecture) · [Quickstart](#quickstart) · [How it works](#how-it-works) · [Contracts](#on-chain-layer) · [Roadmap](#roadmap)

[**Live site**](https://cascet.vercel.app) · [X](https://x.com/cascet_xyz) · [Discord](https://discord.gg/fcjevk47k) · [GitHub](https://github.com/mericcintosun/CasCet)

[![@cascet/cli](https://img.shields.io/npm/v/%40cascet%2Fcli?label=%40cascet%2Fcli&color=a3e635)](https://www.npmjs.com/package/@cascet/cli) · [![@cascet/gateway](https://img.shields.io/npm/v/%40cascet%2Fgateway?label=%40cascet%2Fgateway&color=2dd4bf)](https://www.npmjs.com/package/@cascet/gateway) · [![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

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

### The primitive: budget-bounded cascades with recursive attribution

CasCet's headline isn't "agents pay per call" — it's a new machine-to-machine
primitive that only makes sense once payments compose into trees. The
**`CascadeController`** contract turns a cascade into a programmable supply chain:

- **On-chain budget tree.** An agent opens a cascade with **one deposit that caps
  the whole call tree**. Every hop is paid out of it and the contract *refuses*
  any hop that would exceed the budget — enforcement by construction, not by
  trusting the gateway. (Every rival agent-wallet only caps *per-call* spend.)
- **Recursive attribution.** A configurable share of a child hop's earnings flows
  **up** to the parent hop's payee — the composing service earns margin on what
  it resells. The payment graph *is* the revenue-sharing graph.

Verified on testnet end-to-end: open (budget 1000) → root hop pays analyst 100 →
child hop pays data 30 with 20% attribution (data +24, analyst +6 up the tree) →
an over-budget hop is **rejected on-chain** (`BudgetExceeded`) → close refunds the
unspent 870. ([open](https://testnet.cspr.live/transaction/9bea3ea79762d0b8a6fe3e44a593d5943bd03b2ba86dfbfab0043ca018cb28e0) ·
[attribution hop](https://testnet.cspr.live/transaction/eb96a049692b7918a949bb2cd84982980d643e23678f490f8b851b84f0815b68) ·
[over-budget rejected](https://testnet.cspr.live/transaction/d1df6c898bbc8edc63fca9018dd4352f40afc6cea45a20666c91dbaf28887572))

### The autonomous buyer: an LLM that prices, budgets, and buys tools

The seller side turns MCP tools into paid services. The **buyer** is an
autonomous agent (`@cascet/agent`) that makes that economy *self-driving*.
Given a DeFi/RWA goal, **Claude (Opus 4.8)**:

1. **discovers** the paid tools a gateway advertises — with their x402 prices,
   read straight from `tools/list` (`_meta.cascet.priceUsd`);
2. **decides** which ones are worth buying for the goal, and calls them;
3. **pays** each `tools/call` per x402 out of a **fixed on-chain budget** — the
   paying client aborts a payment before signing if it would breach the cap;
4. **adapts** when the paywall rejects an over-budget call (the rejection is fed
   back to Claude, which works with what it already bought);
5. **synthesizes** a recommendation grounded in the data it actually purchased.

No hardcoded tool list, no fixed call sequence — the model reads prices and
chooses. This is the LLM-in-the-loop half of CasCet: agentic AI spending real
money on real DeFi/RWA data, under budget, settled on Casper.

```bash
pnpm --filter @cascet/e2e agent                       # simulated reasoning, mock facilitator (free)
CASCET_AGENT_LIVE=1 pnpm --filter @cascet/e2e agent    # real Claude (needs API credits)
CSPR_CLOUD_TOKEN=… CASCET_AGENT_LIVE=1 pnpm … agent    # real Claude + real on-chain settlement
```

> **On the simulation (full disclosure).** No paid Anthropic API key was bought
> for this hackathon build, so the demo **defaults to a clearly-labeled offline
> simulation** of the reasoning — behind a prominent banner that says so. Only the
> two model decisions (which tools to buy, and the final wording) are scripted;
> the recommendation is still grounded in the **real data the agent purchased**,
> and tool discovery, x402 pricing, per-call payment, budget enforcement, cascade
> receipts and settlement are all **real and unchanged**. The reasoning backend is
> a one-line swap (`Brain`) — `CASCET_AGENT_LIVE=1` runs the exact same loop with
> real Claude the moment credits are available.

The wire convention it relies on — per-tool price advertisement, x402
settlement, and cascade attribution — is written up as a reusable standard
proposal in [`docs/x402-mcp-spec.md`](docs/x402-mcp-spec.md).

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
| `packages/agent` | Autonomous Claude agent: prices, budgets, and buys paid DeFi/RWA MCP tools |
| `packages/cli` | `cascet` CLI — `init` / `wrap` / `connect` |
| `servers/casper-defi-data` | Flagship paid MCP: CSPR market data, RWA prices, DeFi yields (live + labeled fallback) |
| `servers/portfolio-analyst` | Paid MCP that **buys** from the data server — the cascade in action |
| `apps/dashboard` | Next.js + shadcn/ui live dashboard + x402 economy explorer (dark/light/system) |
| `contracts` | Odra 2.8.2: `ReceiptRegistry` + `RevenueSplit` + `DemoToken` (CEP-18), with tests |
| `examples/wrap-third-party` | Wrapping the official `server-everything` MCP server as paid |
| `tools/e2e` | Local end-to-end demo + mock facilitator (no chain needed) |

### Also built

- **x402 Bazaar discovery** — every gateway serves a Bazaar-compatible catalog at
  `/.well-known/x402.json`, so any x402 agent can *discover* CasCet-monetized MCP
  tools like any paid API.
- **Wrap any MCP server** — `examples/wrap-third-party` monetizes the unmodified
  official `@modelcontextprotocol/server-everything`; CasCet isn't limited to
  first-party servers.
- **x402 economy explorer** — `/explorer` aggregates the on-chain-anchored
  receipts into a revenue leaderboard, top tools, cascade stats and unique
  paying agents, linking the live contracts to cspr.live.

---

## Quickstart

> Reviewers: [`docs/testing-playbook.md`](docs/testing-playbook.md) is a concise,
> step-by-step guide to verify everything works, and
> [`docs/buidl-page.md`](docs/buidl-page.md) lists every contract package hash and
> sample Testnet transaction with descriptions.

Requirements: Node ≥ 20, pnpm, Rust + [`cargo-odra`](https://odra.dev) (for contracts).

```bash
pnpm install
pnpm build

# Run the full cascade demo locally (no chain, mock facilitator):
pnpm --filter @cascet/e2e gen-keys
pnpm --filter @cascet/e2e demo
```

You'll see an agent pay `$0.10` for `analyze_portfolio`, which autonomously spends `$0.07` buying four data tools underneath — every downstream payment linked to the root, asserted at the end.

```bash
# Autonomous agent: it prices the paid tools and decides what to buy.
pnpm --filter @cascet/e2e agent                     # free — labeled simulated reasoning
CASCET_AGENT_LIVE=1 pnpm --filter @cascet/e2e agent # real Claude (needs API credits)
```

The agent reads the three priced DeFi/RWA tools, buys the ones it judges necessary for the goal, pays x402 per call under a fixed budget, and returns a recommendation citing the data it purchased. (Reasoning defaults to a clearly-labeled offline simulation — see the note under [The autonomous buyer](#the-autonomous-buyer-an-llm-that-prices-budgets-and-buys-tools).)

### With the live dashboard

```bash
pnpm --filter @cascet/dashboard dev      # http://localhost:3939
pnpm --filter @cascet/e2e demo           # watch revenue + graph update live
```

### Monetize your own MCP server

```bash
npx @cascet/cli init                          # writes cascet.config.json
# edit: upstream command, payTo, asset (CEP-18), facilitator API key, per-tool prices
npx @cascet/cli wrap                          # your server is now paid
```

Point an agent at it:

```bash
CASCET_KEY_PATH=./agent.pem \
CASCET_MAX_SESSION=5000000000 \
npx @cascet/cli connect http://localhost:4402/mcp
```

---

## How it works

**The x402 flow, per tool call.** MCP speaks JSON-RPC over one HTTP endpoint, so the gateway maps each priced tool to a synthetic x402 route. On `tools/call`, the gateway returns `402 Payment Required` with the price; the agent's wallet signs a CEP-18 `transfer_with_authorization` (EIP-712) and retries; the gateway runs the tool, and **only settles payment if the tool succeeds** (a failed call is never charged). Settlement uses the hosted Casper facilitator — CasCet builds *on* the official rails, it does not reimplement verification.

> **Real settlement, verified.** `pnpm --filter @cascet/e2e demo-real` (with a
> CSPR.cloud token) runs the flow with **no mock**: the agent pays from its
> on-chain balance of a real `transfer_with_authorization` CEP-18 token, the
> hosted CSPR.cloud facilitator verifies and settles it, and the receipt is
> anchored on-chain — e.g. settlement tx
> [`9bc90044…`](https://testnet.cspr.live/transaction/9bc90044ac4053be6bd87fa1a09cec80ea24d509decfe747b001fc1bfc561fc2).
> The bundled mock facilitator (`tools/e2e`) exists only for chain-free local dev.

**Cascading payments.** When the gateway settles a call it mints a `paymentId` and passes it to the upstream tool via `_meta`. If that tool buys from other paid tools, its paying client forwards the id as `X-CASCET-PARENT-ID`, so each downstream receipt records its parent. The full chain reconstructs from receipts alone — no central coordinator — and renders as a payment graph.

**Budgets.** The buyer client enforces per-call and per-session spend caps and aborts a payment *before signing* if it would breach them — an agent can't be drained past its allowance.

---

## On-chain layer

Five Odra contracts (Rust), unit-tested against a real CEP-18 in Odra's mock VM (`cargo odra test`, 13/13 green):

- **`ReceiptRegistry`** — anchors settled tool-call receipts on-chain, each carrying its cascade `parent_id`. Makes two things verifiable without trusting the gateway: that a call was paid, and how payments compose. Permissioned recorders, duplicate protection, events.
- **`RevenueSplit`** — an OpenZeppelin-style PaymentSplitter for CEP-18. A gateway can set its `payTo` to this contract so a server's earnings split between payees by fixed weights, pull-based, enforced on-chain.
- **`CascadeController`** — the budget-bounded cascade primitive: one deposit caps a whole call tree (enforced on-chain), with recursive revenue attribution up the tree.
- **`PaymentChannel`** — prepaid channels for high-frequency traffic: deposit once, authorize usage off-chain with signed vouchers, redeem/reclaim on-chain. Vouchers verified in-contract via Casper `verify_signature`.
- **`DemoToken`** — CasCet's own CEP-18 payment token (a WCSPR-style wrapper). **`Cep18X402`** is *not* ours: it's the reference `transfer_with_authorization` (EIP-3009) token from [make-software/casper-x402](https://github.com/make-software/casper-x402), deployed to testnet so the hosted facilitator can settle real x402 payments (see [`contracts/external/`](contracts/external/) and [`NOTICE`](NOTICE)).

```bash
cd contracts
cargo odra test            # run contract tests (mock VM)
cargo odra build           # build optimized wasm
# deploy to testnet: fill contracts/.env from .env.sample, then
cargo run --bin cascet_contracts_cli -- deploy
```

Network: **Casper Testnet** (`casper:casper-test`), CEP-18 payment token, `casper-eip-712` signatures.

### Live on Casper Testnet

All three contracts are deployed and exercised on testnet:

| Contract | Package hash |
| --- | --- |
| ReceiptRegistry | `hash-bdf8422b69d7bfb7581e7b2c63fbfb0fc8b23701181289411170bce5cf996f97` |
| RevenueSplit | `hash-fa21efb406a8151d15a393bc366e51192a9ea15fd7fe23faffc54f021b32883c` |
| DemoToken (CEP-18, WCSPR) | `hash-b3e9908b6cdbf5c565b686938994e3ac8e6749f41bcbe83615604321a0965d49` |
| Cep18X402 (payment token, `transfer_with_authorization`) — *third-party: [make-software/casper-x402](https://github.com/make-software/casper-x402) reference token, deployed for interop* | `hash-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3` |
| PaymentChannel | `hash-53930d3982a5bea717ec919096cef407b71a1ce9022b241c1d94f19ca770ccb0` |
| ReceiptRegistry (upgradable) | `hash-764ed7190b69dafbc94a0148a07be85227f268a85424e7186be66cdb711b8222` |
| CascadeController | `hash-624134336d1f63ce539ebef9c226e6c463f70a8e85b593bbc5d370520d797980` |

Deployer / operator account: [`01dd710d…`](https://testnet.cspr.live/account/01dd710d5083920b20c706a92d742c7bf9162d09c96fa373bd0a67b0bf51d3f183)

**ReceiptRegistry — receipts anchored live by the running gateway.** A full cascade
(1 root + 4 downstream payments) was anchored end-to-end; on-chain `count` went
`2 → 7` and each child's `parent_id` links back to its root, so the payment graph
reconstructs purely from chain data. ([deploy](https://testnet.cspr.live/transaction/632a0d756c51c18ec0804b8bec338772691dca5a981835777c6512687afe1866) ·
[an anchored receipt](https://testnet.cspr.live/transaction/0f79680230269c43b31528d282dc094d1f5fea000087332f6193e29361b16e4d))

**RevenueSplit — a real 60/40 split, on-chain.** Funded with 1000 WCSPR; the
contract computed `releasable` of 600 / 400, and releasing paid the buildathon
account exactly **400 WCSPR** (its 40%), zeroing its releasable balance.
([fund](https://testnet.cspr.live/transaction/b7c7bbf54f4dbe9375d536c50264b399191f362ce051e3a8ea2f08f86512390d) ·
[release 40%](https://testnet.cspr.live/transaction/462b1dafa7968ad238f671fd44e6fb3e12a9ce5e9994f1a79330c1adc15a710c) ·
[release 60%](https://testnet.cspr.live/transaction/6fc0195ddfb9d6cd8a80eab240cf6d0f4a76c89afcea45679c0f883de9b87e3c))

**PaymentChannel — prepaid channels for high-frequency agents.** An agent opens a
channel with one CEP-18 deposit, then authorizes usage off-chain by signing
monotonic vouchers (`channel_id || cumulative`); the payee redeems the latest
voucher on-chain, verified in-contract with Casper's native `verify_signature`.
Two on-chain writes cover thousands of paid calls. Unit-tested with real ed25519
signatures (redeem, forged-voucher rejection, expiry guard).

**Upgradable ReceiptRegistry — Casper native in-place upgrade.** Deployed
upgradable, anchored a receipt, then upgraded the logic **v1.1.0 → v1.2.0** on
the same package
([upgrade tx `0202cc29…`](https://testnet.cspr.live/transaction/0202cc298c844cb771835612ac028df978c5d8fd0e442b724bdf995c17547e34)).
The package now carries two contract versions and **all anchored state survived**
the upgrade (count, `total_volume`, receipts intact) — feature upgrades ship
without migrating data.

---

## Roadmap & long-term plan

This is a real project, not a hackathon throwaway — there's a live [roadmap section on the site](#) and a concrete path to a business.

- **Shipped (Qualification · Jul 2026):** 7 Odra contracts live on testnet; real x402 settlement (no mock); the `CascadeController` primitive (budget tree + recursive attribution); an autonomous LLM buyer; a live dashboard, an interactive cascade playground, a proposed [x402-MCP spec](docs/x402-mcp-spec.md); and the CLI + libraries **published on npm** (`npx @cascet/cli`).
- **Final round (Jul 13–26):** a hosted CasCet control plane — register a server, get a paid endpoint + dashboard in one step; a RevenueSplit withdraw UI on real revenue; take the paid-MCP + cascade spec to the x402 / MCP ecosystem.
- **Q4 2026 — mainnet & monetization:** mainnet launch; **a protocol take-rate on settled volume** (the business model); per-second / streaming price schemes for high-frequency agent traffic; stable JS/Rust/Python SDKs and a public metrics API.
- **2027 — the agent-economy layer:** an agent-facing pricing-discovery API and a Bazaar marketplace of paid MCP tools; on-chain reputation for tools and agents; cross-chain settlement — CasCet as default rails for machine-to-machine commerce.

**Socials & launch:** X / Discord / GitHub linked above; copy-paste launch content (bio, pinned thread, channel descriptions) is in [docs/launch-kit.md](docs/launch-kit.md).

## Tech

TypeScript (Node 20, pnpm workspaces), Next.js 15 + shadcn/ui, `@make-software/casper-x402` + `@x402/*`, `@modelcontextprotocol/sdk`, Rust + Odra 2.8.2, Casper Testnet.

## License

[Apache-2.0](LICENSE). Built for the Casper Agentic Buildathon 2026. All CasCet code is original work created for this event; third-party components used for interop are listed in [`NOTICE`](NOTICE).
