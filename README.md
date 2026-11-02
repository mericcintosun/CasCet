<div align="center">

# CasCet

**Turn any MCP server into a paid service — per-tool x402 micropayments with cascading agent-to-agent payment chains, settled instantly on Casper.**

Casper Agentic Buildathon 2026 · Casper Innovation Track · **finalist**

**Now live on Casper mainnet.** [First real x402 payment settled on mainnet](https://cspr.live/transaction/2c66141c324216f4966f2d565c64c55cb37047cfc86b9863717d08d1b60a3bd1).

**Security status:** not externally audited. Internal multi-agent review on 2026-10-20; external audit planned. See [`SECURITY.md`](SECURITY.md).

[Architecture](#architecture) · [Quickstart](#quickstart) · [How it works](#how-it-works) · [Contracts](#on-chain-layer) · [Roadmap](#roadmap--long-term-plan)

[**Watch the demo (2:43)**](https://youtu.be/ZwHakuOdfiw) · [**Live site**](https://cascet.vercel.app) · [X](https://x.com/cascet_xyz) · [GitHub](https://github.com/mericcintosun/CasCet) · [Issues](https://github.com/mericcintosun/CasCet/issues)

[![@cascet/cli](https://img.shields.io/npm/v/%40cascet%2Fcli?label=%40cascet%2Fcli&color=a3e635)](https://www.npmjs.com/package/@cascet/cli) · [![@cascet/gateway](https://img.shields.io/npm/v/%40cascet%2Fgateway?label=%40cascet%2Fgateway&color=2dd4bf)](https://www.npmjs.com/package/@cascet/gateway) · [![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

</div>

---

## The problem

AI agents reach the outside world through **MCP servers** — small services that expose tools (fetch a price, run an analysis, query a chain). Thousands of developers ship them. Almost all of them are **free**, because there is no clean way to charge an autonomous agent per call: an agent can't fill in a credit-card form or manage a subscription.

x402 (HTTP 402 "Payment Required") fixes the payment primitive. But every x402 tool today is a **static vending machine** and, crucially, **point-to-point**: an agent pays a server, the server answers, done. Real agent workloads aren't shaped like that. A "portfolio analysis" tool internally needs a "price feed" tool and an "RWA data" tool — each of which is itself a paid service. Nobody is settling those **payment chains**.

## What CasCet does

CasCet is the **monetization layer for MCP on Casper** — think *Stripe for MCP servers* — plus the piece no one has shipped: **composable, multi-hop (cascading) payments**.

1. **Wrap** — `cascet wrap` puts a paywall in front of any existing MCP server. Set a price per tool; agents pay per call in CEP-18 over x402; you keep the tool code unchanged.
2. **Connect** — `cascet connect` is a stdio bridge so any MCP host (Claude Code, Claude Desktop, Cursor) can call paid servers, answering 402 challenges automatically within the sellers, tokens, networks and budget you allow.
3. **Cascade** — when a paid tool itself buys from other paid tools, CasCet composes the payments into a chain, links every hop to its parent, and can anchor every receipt on-chain (`anchoring` in the gateway config). The `CascadeController` contract below adds an on-chain budget cap and revenue attribution for the whole tree; today it is a standalone primitive, proven on mainnet but not yet wired into the gateway.
4. **See it** — a live dashboard and on-chain explorer show revenue, receipts (with cspr.live settlement links) and the cascading payment graph, both rebuilt straight from the on-chain `ReceiptRegistry`.

### The primitive: budget-bounded cascades with recursive attribution

CasCet's headline isn't "agents pay per call" — it's a new machine-to-machine
primitive that only makes sense once payments compose into trees. The
**`CascadeController`** contract turns a cascade into a programmable supply chain:

- **On-chain budget tree.** An agent opens a cascade with **one deposit that caps
  the whole call tree**. Every hop is paid out of it and the contract *refuses*
  any hop that would exceed the budget — enforcement by construction, not by
  trusting the gateway.
- **Recursive attribution.** A configurable share of a child hop's earnings flows
  **up** to the parent hop's payee — the composing service earns margin on what
  it resells. The payment graph *is* the revenue-sharing graph.

**Proven on Casper mainnet, end-to-end** (not just unit-tested): open (budget 100)
→ root hop pays the analyst 40 → child hop pays data 20 with 20% attribution (data
+16, analyst +4 up the tree) → an over-budget hop is **rejected on-chain**
(`BudgetExceeded`, User error 5) → close refunds the unspent 40. After close the
contract holds zero tokens and the analyst's balance is exactly 44 — the recursive
split, settled on mainnet.
(Status: the cascade was run through the contracts CLI. `CascadeController` is not yet
wired into the gateway's live payment flow, where cascades are linked by parent ids and
anchored in the `ReceiptRegistry`; wiring it in is the next milestone.)
([open](https://cspr.live/transaction/03c9b08b50e9999612748853e958d2668583a16ea47ddc996b587de3d3cc4c76) ·
[root hop](https://cspr.live/transaction/7b293e54fdbd73e3e959c529c4a465b4c6e2c5d12eff965ac89d1593ffe72321) ·
[attribution hop](https://cspr.live/transaction/999396c44ad6af738000e20928faff4c49978d63571ceaaa8ba9010602d68b9a) ·
[over-budget rejected](https://cspr.live/transaction/abf672055e5c2fe7c6407a3ebffa1954598583724871dd35b9fe0a08434c1a09) ·
[close + refund](https://cspr.live/transaction/2c1aa62c6114b436e9214ac1fdfa9efbaf77c1c0a406a893e592bb9a9565d406))

### The autonomous buyer: an LLM that prices, budgets, and buys tools

The seller side turns MCP tools into paid services. The **buyer** is an
autonomous agent (`@cascet/agent`) that makes that economy *self-driving*.
Given a DeFi/RWA goal, **Claude (Opus 4.8)**:

1. **discovers** the paid tools a gateway advertises — with their x402 prices,
   read straight from `tools/list` (`_meta.cascet.priceUsd`);
2. **decides** which ones are worth buying for the goal, and calls them;
3. **pays** each `tools/call` per x402 out of a **fixed budget enforced by the
   paying client**, which aborts a payment before signing if it would breach the
   cap (this budget is off-chain; the on-chain `CascadeController` budget is not
   wired into this flow yet);
4. **adapts** when the paywall rejects an over-budget call (the rejection is fed
   back to Claude, which works with what it already bought);
5. **synthesizes** a recommendation grounded in the data it actually purchased.

No hardcoded tool list, no fixed call sequence — the model reads prices and
chooses. This is the LLM-in-the-loop half of CasCet: agentic AI spending real
money on real DeFi/RWA data, under budget, settled on Casper.

```bash
ANTHROPIC_API_KEY=… pnpm --filter @cascet/e2e agent   # bespoke loop, real Claude via the Anthropic API
pnpm --filter @cascet/e2e connect-demo                # real Claude Code (Max/Pro plan) through cascet connect
```

These two demos settle real payments with the CasCet operator's testnet keys, so
they run on a maintainer machine (see [Maintainer demos](#maintainer-demos)). To
point your own agent at a paid gateway, see [Point an agent at it](#point-an-agent-at-it).

> **Real Claude, live, for free — via `cascet connect`.** You don't need to buy an
> API key to see a real LLM buy paid tools. Point **Claude Code** (on a Claude
> Pro/Max plan) at a paid gateway through `cascet connect`, and Claude discovers
> the priced tools, decides what's worth buying, and calls them — every 402 paid by
> the connect bridge under a budget. The reasoning runs on the Agent-SDK credit
> included with the plan (no pay-as-you-go API spend); the x402 payments are real.

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
│ (self-hosted, Casper)│             │ on-chain revenue+graph │        │ ReceiptRegistry       │
│ verify + settle     │              │ (Next.js + shadcn/ui)  │        │ RevenueSplit · Cascade│
└─────────────────────┘              └────────────────────────┘        └──────────────────────┘
```

### Monorepo layout

| Path | What |
| --- | --- |
| `packages/core` | Shared types, config schema, receipt + payment-graph model |
| `packages/gateway` | Seller-side proxy: wraps an MCP server, prices tools, runs the x402 flow |
| `packages/client` | Buyer-side paying `fetch` (allowlists, budget guard, cascade parent propagation), stdio bridge |
| `packages/agent` | Autonomous Claude agent: prices, budgets, and buys paid DeFi/RWA MCP tools |
| `packages/cli` | `cascet` CLI — `init` / `wrap` / `connect` / `account-hash` |
| `clients/python` | Python paying client: signs x402 payments with a Casper key |
| `servers/casper-defi-data` | Flagship paid MCP: CSPR market data, RWA prices, DeFi yields (live + labeled fallback) |
| `servers/portfolio-analyst` | Paid MCP that **buys** from the data server — the cascade in action |
| `apps/dashboard` | Next.js + shadcn/ui live dashboard + x402 economy explorer (dark/light/system) |
| `contracts` | Odra 2.8.2 (5): `ReceiptRegistry`, `RevenueSplit`, `CascadeController`, `PaymentChannel`, `DemoToken` (CEP-18), with tests |
| `examples/wrap-third-party` | Wrapping the official `server-everything` MCP server as paid, on testnet, with your own keys |
| `tools/e2e` | The self-hosted x402 facilitator, plus the end-to-end demos (real settlement on Casper testnet and mainnet) |
| `registry` | MCP Registry listing for the `casper-defi-data` server (testnet) |

### Also built

- **On npm** — `npx @cascet/cli init/wrap/connect`, with `@cascet/core`,
  `@cascet/client` and `@cascet/gateway` published alongside it. New releases are
  published from GitHub Actions with npm trusted publishing and provenance. Use
  **0.1.1 or later**; 0.1.0 is unsupported (see [`SECURITY.md`](SECURITY.md)).
- **[`/build`](https://cascet.vercel.app/build) — a config-generator wizard.** Fill
  in your server, payment account and per-tool prices; get a schema-validated
  `cascet.config.json` (copy/download) plus the exact `npx @cascet/cli` commands.
- **[`/withdraw`](https://cascet.vercel.app/withdraw) — wallet-signed revenue (testnet).**
  Connect Casper Wallet and call `release` on the `RevenueSplit` to pull your
  weighted share on-chain, linked to cspr.live.
- **[`/explorer`](https://cascet.vercel.app/explorer) — on-chain-backed.** Rebuilds
  the whole x402 economy (revenue leaderboard, top tools, cascade stats, anchored
  receipts) straight from the testnet **ReceiptRegistry**'s `record` transactions — not an
  off-chain cache.
- **x402 Bazaar discovery** — every gateway serves a Bazaar-compatible catalog at
  `/.well-known/x402.json`, so any x402 agent can *discover* CasCet-monetized MCP
  tools like any paid API.
- **Wrap any MCP server** — `examples/wrap-third-party` monetizes the unmodified
  official `@modelcontextprotocol/server-everything`; CasCet isn't limited to
  first-party servers.

---

## Quickstart

> Reviewers: [`docs/testing-playbook.md`](docs/testing-playbook.md) is a concise,
> step-by-step guide to verify everything works, and
> [`docs/buidl-page.md`](docs/buidl-page.md) lists every contract package hash and
> sample transaction with descriptions.

Requirements: Node.js 22 or newer, pnpm 10 (`corepack enable` provisions the
pinned version), and Rust + [`cargo-odra`](https://odra.dev) only for the contracts.

### 1. Build and test (no keys, no chain)

```bash
git clone https://github.com/mericcintosun/CasCet.git
cd CasCet
pnpm install --frozen-lockfile
pnpm build && pnpm typecheck && pnpm test
(cd contracts && cargo test)   # Odra contract tests in the mock VM
```

### 2. Sell tools on Casper testnet with your own keys

[`examples/wrap-third-party`](examples/wrap-third-party/README.md) walks through
the whole loop with keys you create yourself: a seller account, a fee payer for
the self-hosted facilitator (funded from the testnet faucet), and a buyer
wallet (test tokens on request through a GitHub issue). It ends with an MCP host
paying per call through `cascet connect`. The sections
[Monetize your own MCP server](#monetize-your-own-mcp-server) and
[Point an agent at it](#point-an-agent-at-it) below explain each setting.

### 3. Open the dashboard

```bash
pnpm --filter @cascet/dashboard dev      # http://localhost:3939
```

The on-chain views need a CSPR.cloud access token in `CSPR_CLOUD_TOKEN`; without
it they stay empty.

### Maintainer demos

The scripts in `tools/e2e` that move tokens (`fund-token`, `wrap-wcspr`, `demo`,
`demo-real`, `demo-real-wcspr`, `demo-real-mainnet`, `agent`, `connect-demo`)
sign with the CasCet operator's keys in `contracts/keys/`, which are not part of
the repository, so they only run on a maintainer's machine. They produced the
transactions linked in this README.

```bash
pnpm --filter @cascet/e2e gen-keys                                # throwaway testnet keys in tools/e2e/keys/
pnpm --filter @cascet/e2e fund-token cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3 \
  <analyst-account-hash> 300 --send                               # pays the analyst from the token treasury
pnpm --filter @cascet/e2e demo                                    # full cascade, real settlement on testnet, both hops
```

`fund-token`, and `wrap-wcspr` (testnet CSPR into Wrapped CSPR), are dry runs
unless you add `--send`, and refuse mainnet. The demos have no dry run:
`demo-real-wcspr` signs and pays in Wrapped CSPR on testnet after its read-only
checks, and `settle-report <tx-hash>…` (read-only) prints the measured gas of
settles; see [Two token styles](#two-token-styles-legacy-amount-and-cep3009-value).

You'll see an agent pay `$0.10` for `analyze_portfolio`, which autonomously spends `$0.07` buying four data tools underneath — every downstream payment linked to the root, asserted at the end. With `pnpm --filter @cascet/dashboard dev` running, the demo's gateways push their receipts to the dashboard live.

### Monetize your own MCP server

```bash
npx "@cascet/cli@^0.1.1" init                                 # writes cascet.config.json
npx "@cascet/cli@^0.1.1" account-hash <your-public-key-hex>   # prints your payTo: "00" + account hash
```

The version range keeps `npx` off the unsupported 0.1.0 (see
[`SECURITY.md`](SECURITY.md)): until 0.1.1 is on npm, these commands stop with
`ETARGET` instead of running 0.1.0. In a clone of this repository, run the
checkout's CLI instead: `node packages/cli/dist/cli.js <command>` after
`pnpm build`.

Then edit `cascet.config.json`:

- `upstream`: how to start your MCP server (a stdio command, or an HTTP URL).
- `payTo`: the `00…` value printed by `account-hash`. It must be an account
  hash, never a public key: a public key (`01…` or `02…`) is rejected, because a
  payment to it would land in an account nobody controls. Do not point `payTo`
  at a contract package (such as a `RevenueSplit`) yet: the settlement library,
  `@make-software/casper-x402` 1.0.0, always settles to an account hash, so such
  a payment would be lost.
- `asset`: a token your facilitator can settle (see the table below). On testnet
  that is CasCet's x402 token, `hash-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3`
  (name `CasCet X402 Token`, version `1`, 9 decimals), with the self-hosted
  facilitator; or Wrapped CSPR, `hash-3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e`
  (name `Wrapped CSPR`, version `1`, 9 decimals), with the hosted one.
- `facilitator.url`: the facilitator that verifies and settles payments, and
  `facilitator.apiKey` the credential it expects (for the hosted facilitator,
  your CSPR.cloud access key, sent raw).
- `pricing.tools`: a price per tool. Add `"settleBeforeExecute": true` to tools
  that are expensive, have side effects, or buy from other paid tools
  (cascades): they then run only after the payment has settled on-chain. The
  trade-off: such a call stays charged if the tool then fails.
- `pricing.freeTools`: tools that stay free. Every upstream tool that is neither
  priced nor listed here is hidden from `tools/list` and rejected.

```bash
npx "@cascet/cli@^0.1.1" wrap   # your server is now paid; the gateway listens on 127.0.0.1
```

**Which facilitator settles which token.**

| Facilitator | Settles | Use it with |
| --- | --- | --- |
| Self-hosted (`pnpm --filter @cascet/e2e facilitator`, in this repository) | `legacy-amount` tokens, whose `transfer_with_authorization` takes `amount` (it checks signatures with `@make-software/casper-x402` 1.0.0 and settles with its own transaction builder) | CasCet's x402 tokens: testnet `hash-cb65a928…`, mainnet `hash-8dd4f1aa…` |
| Hosted CSPR.cloud (`x402-facilitator.cspr.cloud`) | only `cep3009-value` tokens, whose `transfer_with_authorization` takes `value`, such as the official Wrapped CSPR | Wrapped CSPR: testnet `hash-3d80df21…` (see [`examples/wrap-third-party/cascet.wcspr.config.json`](examples/wrap-third-party/cascet.wcspr.config.json)); never CasCet's x402 tokens ([why](docs/onchain.md#why-cascet-runs-its-own-x402-facilitator)) |

Start the self-hosted facilitator from a clone of this repository:

```bash
CASCET_FACILITATOR_KEY=/absolute/path/to/fee-payer.pem \
CASCET_SELLER_ACCOUNT_HASH=00<your account hash> \
pnpm --filter @cascet/e2e facilitator   # testnet, http://127.0.0.1:4501
```

The fee payer pays the gas of every settlement, so fund it with testnet CSPR from
the [faucet](https://testnet.cspr.live/tools/faucet); buyers need no CSPR. The
facilitator settles only payments to `CASCET_SELLER_ACCOUNT_HASH` in CasCet's x402
token. `CASCET_SETTLE_PAYMENT_MOTES` sets the gas limit per settlement (default
4 CSPR). For mainnet (`CASCET_NET=mainnet`) it also requires a bearer token in
`CASCET_FACILITATOR_TOKEN` of at least 32 characters (`openssl rand -hex 32`;
put the same value into `facilitator.apiKey`), and it refuses to start when its
fee-payer account is the owner account (`CASCET_OWNER_ACCOUNT_HASH`) or the
seller account. Read [`SECURITY.md`](SECURITY.md) and
[`docs/mainnet-readiness.md`](docs/mainnet-readiness.md) before you run anything
with real funds.

#### Two token styles: legacy-amount and cep3009-value

Buyers sign the same EIP-712 `TransferWithAuthorization` message for both
styles; only the name of the amount argument the facilitator passes to the
token differs (`amount` or `value`). A facilitator that sends the wrong one
makes the settlement revert with `User error: 64658`, which burns its whole gas
limit. So:

- Each `asset` has an authorization style. It is resolved from the package
  hash (CasCet's x402 tokens are `legacy-amount`, every other token
  `cep3009-value`) or set with `"authorization"`. The gateway advertises it in
  every `accepts` entry as `extra.authorizationStyle`; no facilitator trusts
  that field. The hosted facilitator always sends `value`; the self-hosted
  facilitator in this release always sends `amount`, so its
  `CASCET_ALLOWED_ASSETS` must list only `legacy-amount` tokens (never Wrapped
  CSPR).
- The config schema refuses a `legacy-amount` asset settled by the hosted
  facilitator.
- The hosted facilitator takes your CSPR.cloud access key **raw** in the
  `Authorization` header, with no `Bearer ` prefix. Put it in
  `facilitator.apiKey`; `facilitator.authScheme` is `"raw"` by default, and
  `"bearer"` is refused for the hosted facilitator. Its `/supported` needs no key.
- **The hosted facilitator's testnet fee payer is underfunded.** On 2026-11-01
  it held 2.145 CSPR, less than the 2.5 CSPR one settle needs (Casper's minimum
  balance for the account that submits a transaction, and the hosted
  facilitator's gas limit per settle), so every hosted settle on testnet fails
  until MAKE refills it. Its mainnet fee payer is funded.
- Testnet Wrapped CSPR (`hash-3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e`,
  name `Wrapped CSPR`, version `1`, 9 decimals) is minted 1:1 for testnet CSPR
  by its payable `deposit` entry point:
  `pnpm --filter @cascet/e2e wrap-wcspr <cspr> --key /absolute/path/to/key.pem`
  prints the plan and the expected gas, and wraps with `--send`.
- `pnpm --filter @cascet/e2e settle-report <tx-hash>…` reads settle
  transactions back (read-only) and prints consumed gas, refund and net cost,
  with a gas limit suggested from the measurements (ceil(1.3 × max consumed)).
  The self-hosted facilitator's limit for `legacy-amount` settles is 4 CSPR
  (they consume about 2.7 CSPR, more than `@x402/casper`'s 2.5 CSPR default).

[`docs/testing-playbook.md`](docs/testing-playbook.md#two-token-styles-on-testnet-cascet-x402-token-and-wrapped-cspr)
walks through a Wrapped CSPR payment on testnet.

### Point an agent at it

```bash
CASCET_KEY_PATH=./agent.pem \
CASCET_NETWORK=casper:casper-test \
CASCET_ALLOWED_PAYTO=00<seller account hash> \
CASCET_ALLOWED_ASSETS=hash-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3 \
CASCET_MAX_PER_CALL=1000000000 \
CASCET_MAX_SESSION=5000000000 \
npx "@cascet/cli@^0.1.1" connect http://127.0.0.1:4402/mcp
```

Budgets are in raw token units: with 9 decimals, `1000000000` is one token. The
bridge pays only the sellers, tokens and networks listed, and `connect` refuses
to start without the allowlists and both budgets.

| Variable | Required | Meaning |
| --- | --- | --- |
| `CASCET_KEY_PATH` | yes | PEM private key of the paying wallet |
| `CASCET_KEY_ALGO` | no | `ed25519` (default) or `secp256k1` |
| `CASCET_NETWORK` | no | comma-separated CAIP-2 networks the bridge may pay on (default `casper:casper-test`) |
| `CASCET_ALLOWED_PAYTO` | yes¹ | comma-separated seller `payTo` values (`00` + account hash) |
| `CASCET_ALLOWED_ASSETS` | yes¹ | comma-separated token package hashes |
| `CASCET_MAX_PER_CALL` | yes² | most raw token units one call may cost |
| `CASCET_MAX_SESSION` | yes² | most raw token units the whole session may spend (tracked per token) |
| `CASCET_TIMEOUT_MS` | no | deadline per paid call in milliseconds, settlement included (default `30000`) |
| `CASCET_TOOL_PINS` | no | file where the bridge records each gateway's tools (default `~/.cascet/tool-pins.json`); `--accept-tool-changes` accepts a changed tool list after you have reviewed it |

¹ Unless `CASCET_ALLOW_ANY_SELLER=1` or `--allow-any-seller`, which lets any
gateway name any payee and token. Not recommended.
² Unless `CASCET_ALLOW_UNLIMITED_BUDGET=1` or `--allow-unlimited-budget`. Not
recommended.

To use the bridge from an MCP host such as Claude Desktop or Cursor, register it
as a stdio server with the same variables (use absolute paths). Pin an exact
version there and raise it on purpose: the host runs this command, which holds
your wallet key, every time it starts, so it should never float on `@latest`
and pick up whatever is published next.

```json
{
  "mcpServers": {
    "cascet-paid": {
      "command": "npx",
      "args": ["-y", "@cascet/cli@0.1.1", "connect", "http://127.0.0.1:4402/mcp"],
      "env": {
        "CASCET_KEY_PATH": "/absolute/path/to/agent.pem",
        "CASCET_NETWORK": "casper:casper-test",
        "CASCET_ALLOWED_PAYTO": "00<seller account hash>",
        "CASCET_ALLOWED_ASSETS": "hash-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3",
        "CASCET_MAX_PER_CALL": "1000000000",
        "CASCET_MAX_SESSION": "5000000000"
      }
    }
  }
}
```

---

## How it works

**The x402 flow, per tool call.** MCP speaks JSON-RPC over one HTTP endpoint, so the gateway maps each priced tool to a synthetic x402 route. On `tools/call`, the gateway returns `402 Payment Required` with the price; the agent's wallet signs a CEP-18 `transfer_with_authorization` (EIP-712) and retries; the gateway verifies the authorization, runs the tool, and **only settles payment if the tool succeeds** (a failed call is never charged). Tools marked `settleBeforeExecute` settle first and run only once the payment is on-chain. Tools that are neither priced nor listed as free are hidden and rejected. Settlement uses a self-hosted x402 facilitator built on the official `@make-software/casper-x402` package — CasCet builds *on* the official rails, it does not reimplement verification.

> **Real settlement, verified.** `pnpm --filter @cascet/e2e demo-real` (a maintainer
> demo) settles a real `transfer_with_authorization` on-chain: the agent pays from
> its on-chain balance of a real CEP-18 token, the self-hosted x402 facilitator
> (fee-sponsored by the CasCet operator key) verifies and settles it, and the
> receipt is anchored on-chain — e.g. settlement tx
> [`0218ff4c…`](https://testnet.cspr.live/transaction/0218ff4c8d726a610a7a02168cd24941d4db07a9ca787c2fa6f89f21ac159ce7).

**Cascading payments.** When the gateway settles a call it mints a `paymentId` and passes it to the upstream tool via `_meta`. If that tool buys from other paid tools, its paying client forwards the id as `X-CASCET-PARENT-ID`, so each downstream receipt records its parent. The full chain reconstructs from receipts alone — no central coordinator — and renders as a payment graph.

**Budgets and allowlists.** The buyer client enforces per-call and per-session spend caps and aborts a payment *before signing* if it would breach them — an agent can't be drained past its allowance. It also pays only the sellers, tokens and networks it is configured for, so a hostile gateway cannot redirect a payment.

---

## On-chain layer

Five Odra contracts (Rust), unit-tested against a real CEP-18 in Odra's mock VM (`cargo test` or `cargo odra test`):

- **`ReceiptRegistry`** — anchors settled tool-call receipts on-chain, each carrying its cascade `parent_id`. Makes two things verifiable without trusting the gateway: that a call was paid, and how payments compose. Permissioned recorders, duplicate protection, events.
- **`RevenueSplit`** — an OpenZeppelin-style PaymentSplitter for CEP-18: tokens sent to it are split between payees by fixed weights, pull-based, enforced on-chain. A seller forwards earnings to it with a CEP-18 transfer; pointing an x402 `payTo` straight at it needs a settlement stack that can pay contract packages, which `@make-software/casper-x402` 1.0.0 cannot.
- **`CascadeController`** — the budget-bounded cascade primitive: one deposit caps a whole call tree (enforced on-chain), with recursive revenue attribution up the tree. A standalone primitive for now: proven on mainnet, not yet called by the gateway.
- **`PaymentChannel`** — prepaid channels for high-frequency traffic: deposit once, authorize usage off-chain with signed vouchers, redeem/reclaim on-chain. Vouchers verified in-contract via Casper `verify_signature`.
- **`DemoToken`** — CasCet's own CEP-18 token (WCSPR-style), used by the cascade and revenue-split demos. **`Cep18X402`**, the token x402 payments settle in, is *not* CasCet code: it is the reference `transfer_with_authorization` (EIP-3009) token from [make-software/casper-x402](https://github.com/make-software/casper-x402), which CasCet installed on testnet and on mainnet (as "CasCet X402 Token") so its facilitator can settle real x402 payments (see [`contracts/external/`](contracts/external/) and [`NOTICE`](NOTICE)).

```bash
cd contracts
cargo odra test            # run contract tests (mock VM)
cargo odra build           # build optimized wasm
# deploy to testnet: fill contracts/.env from .env.sample, then
cargo run --bin cascet_contracts_cli -- deploy
```

Networks: **Casper mainnet** (`casper:casper`) and **Casper Testnet** (`casper:casper-test`), CEP-18 payment token, `casper-eip-712` signatures.

### Live on Casper mainnet

The full contract set is deployed on **Casper mainnet** (chain `casper`), redeployed with the fixes from the July 2026 internal pre-mainnet review. Open any package at `cspr.live/contract-package/<hash>`.

| Contract | Package hash |
| --- | --- |
| Cep18X402 payment token | `8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41` |
| ReceiptRegistry | `f86bef35062e92d06b8171cf4131fdf557463589aca9112a348e5eb24159eb93` |
| RevenueSplit | `269afcceb147db41f68f5721df7b3957e5efeefb3bedbb9deba324c3a45d09c5` |
| CascadeController | `c7e56988214c62dc5eda20b14894a7514f7388560850b6db3094758363a62189` |
| PaymentChannel | `db2dc42b76f354e7716cafea8619ae6bc85fe50bc3e73979c2360dbba1458c57` |
| DemoToken (CEP-18) | `3da88daf3f276d915ea4f6734e0d4b3d4781358734c369b95de028a2c094fe74` |

The five CasCet contract packages are locked (not upgradable). The payment token package is upgradable by the operator key.

**Real x402 settled on mainnet** (0.5 CasCet X402 Token via `transfer_with_authorization`, from both clients; the token's on-chain symbol is WCSPR, but it is not the official Wrapped CSPR):
[TypeScript](https://cspr.live/transaction/2c66141c324216f4966f2d565c64c55cb37047cfc86b9863717d08d1b60a3bd1) ·
[Python](https://cspr.live/transaction/754224da36db9ecaef8399e720fc04fc2bc4605b383c63964788860db25533b7).
The gateway anchored the TypeScript call's receipt in the mainnet ReceiptRegistry:
[`aacc4977…`](https://cspr.live/transaction/aacc4977a1d1c7902b20f8f21ff5d931b48106a57a7a3abb5eec00bddfb350e7).

**CascadeController — the flagship primitive, proven on mainnet.** A full budget-capped
cascade ran live against the DemoToken CEP-18 (see the primitive proof above):
[open](https://cspr.live/transaction/03c9b08b50e9999612748853e958d2668583a16ea47ddc996b587de3d3cc4c76) ·
[root hop](https://cspr.live/transaction/7b293e54fdbd73e3e959c529c4a465b4c6e2c5d12eff965ac89d1593ffe72321) ·
[attribution hop](https://cspr.live/transaction/999396c44ad6af738000e20928faff4c49978d63571ceaaa8ba9010602d68b9a) ·
[over-budget rejected](https://cspr.live/transaction/abf672055e5c2fe7c6407a3ebffa1954598583724871dd35b9fe0a08434c1a09) ·
[close + refund](https://cspr.live/transaction/2c1aa62c6114b436e9214ac1fdfa9efbaf77c1c0a406a893e592bb9a9565d406).
Full mainnet + testnet address list: [`docs/onchain.md`](docs/onchain.md).

### Live on Casper Testnet

The contracts are deployed and exercised on testnet:

| Contract | Package hash |
| --- | --- |
| ReceiptRegistry | `hash-bdf8422b69d7bfb7581e7b2c63fbfb0fc8b23701181289411170bce5cf996f97` |
| RevenueSplit | `hash-fa21efb406a8151d15a393bc366e51192a9ea15fd7fe23faffc54f021b32883c` |
| DemoToken (CEP-18, WCSPR) | `hash-b3e9908b6cdbf5c565b686938994e3ac8e6749f41bcbe83615604321a0965d49` |
| Cep18X402 (payment token, `transfer_with_authorization`) — *third-party code: the [make-software/casper-x402](https://github.com/make-software/casper-x402) reference token, installed by CasCet* | `hash-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3` |
| PaymentChannel | `hash-53930d3982a5bea717ec919096cef407b71a1ce9022b241c1d94f19ca770ccb0` |
| ReceiptRegistry (upgradable) | `hash-764ed7190b69dafbc94a0148a07be85227f268a85424e7186be66cdb711b8222` |
| CascadeController | `hash-624134336d1f63ce539ebef9c226e6c463f70a8e85b593bbc5d370520d797980` |

Deployer / operator account: [`01dd710d…`](https://testnet.cspr.live/account/01dd710d5083920b20c706a92d742c7bf9162d09c96fa373bd0a67b0bf51d3f183)

**ReceiptRegistry — receipts with cascade links, on-chain.** The contracts CLI
anchored a first sample receipt, and a run of the cascade demo from the
mock-settlement era then anchored 1 root + 4 downstream receipts: on-chain
`count` went `2 → 7` and each child's `parent_id` links back to its root, so the
payment graph reconstructs purely from chain data.
([deploy](https://testnet.cspr.live/transaction/632a0d756c51c18ec0804b8bec338772691dca5a981835777c6512687afe1866) ·
[sample receipt](https://testnet.cspr.live/transaction/0f79680230269c43b31528d282dc094d1f5fea000087332f6193e29361b16e4d))
A receipt anchored by the gateway for a real settled payment is on mainnet (see above).

**RevenueSplit — a real 60/40 split, on-chain.** Funded with 1000 WCSPR; the
contract computed `releasable` of 600 / 400, and releasing paid the buildathon
account exactly **400 WCSPR** (its 40%), zeroing its releasable balance.
([fund](https://testnet.cspr.live/transaction/b7c7bbf54f4dbe9375d536c50264b399191f362ce051e3a8ea2f08f86512390d) ·
[release 40%](https://testnet.cspr.live/transaction/462b1dafa7968ad238f671fd44e6fb3e12a9ce5e9994f1a79330c1adc15a710c) ·
[release 60%](https://testnet.cspr.live/transaction/6fc0195ddfb9d6cd8a80eab240cf6d0f4a76c89afcea45679c0f883de9b87e3c))

**PaymentChannel — prepaid channels for high-frequency agents.** An agent opens a
channel with one CEP-18 deposit, then authorizes usage off-chain by signing
monotonic vouchers over
`CASCET_PAYMENT_CHANNEL_VOUCHER_V2 || contract package hash || channel_id || cumulative`,
so a voucher cannot be replayed on another deployment or chain; the payee
redeems the latest voucher on-chain, verified in-contract with Casper's native
`verify_signature`.
Two on-chain writes cover thousands of paid calls. Unit-tested with real ed25519
signatures (redeem, forged-voucher rejection, expiry guard).

**Upgradable ReceiptRegistry — Casper native in-place upgrade (testnet only).**
Deployed upgradable, anchored a receipt, then upgraded the logic **v1.1.0 → v1.2.0** on
the same package
([upgrade tx `0202cc29…`](https://testnet.cspr.live/transaction/0202cc298c844cb771835612ac028df978c5d8fd0e442b724bdf995c17547e34)).
The package now carries two contract versions and **all anchored state survived**
the upgrade (count, `total_volume`, receipts intact) — feature upgrades ship
without migrating data. The mainnet packages are locked, so this does not apply
to them.

---

## Roadmap & long-term plan

This is a real project, not a hackathon throwaway — there's a live [roadmap section on the site](https://cascet.vercel.app/#roadmap) and a concrete path to a business.

- **Shipped (Qualification · Jul 2026):** 5 Odra contracts; real x402 settlement (no mock); the `CascadeController` primitive (budget tree + recursive attribution); an autonomous LLM buyer; a live dashboard, an interactive cascade playground, and a proposed [x402-MCP spec](docs/x402-mcp-spec.md).
- **Shipped (Final round · Jul 2026) — live on Casper mainnet:** the full contract set redeployed to **Casper mainnet** after an internal pre-mainnet review; real x402 settled from both the **TypeScript and Python** clients; the **`CascadeController` primitive proven on mainnet** (budget cap → attribution up the tree → over-budget revert → refund); an on-chain-backed dashboard + explorer (rebuilt from the testnet ReceiptRegistry); a `/build` config wizard; a `/withdraw` page for `RevenueSplit` `release` on testnet (its wallet signing was fixed in the hardening after the 2026-10-20 review); and the CLI + libraries **published on npm** (`@cascet/*` 0.1.0).
- **Now — hardening:** fixing the findings of the 2026-10-20 internal review, `@cascet/*` 0.1.1, and an external security audit before more value flows through the system.
- **Q4 2026 — monetization:** **a protocol take-rate on settled volume** (the business model); a hosted CasCet control plane (register a server, get a paid endpoint + dashboard in one step); per-second / streaming price schemes for high-frequency agent traffic; a public metrics API.
- **2027 — the agent-economy layer:** an agent-facing pricing-discovery API and a Bazaar marketplace of paid MCP tools; on-chain reputation for tools and agents; cross-chain settlement — CasCet as default rails for machine-to-machine commerce.

**Socials & launch:** X and GitHub are linked above; questions and support go to [GitHub issues](https://github.com/mericcintosun/CasCet/issues). Copy-paste launch content (bio, pinned thread) is in [docs/launch-kit.md](docs/launch-kit.md).

## Tech

TypeScript (Node 22+, pnpm workspaces), Next.js 15 + shadcn/ui, `@make-software/casper-x402` + `@x402/*`, `@modelcontextprotocol/sdk`, Python (paying client), Rust + Odra 2.8.2, Casper mainnet and testnet.

## License

[Apache-2.0](LICENSE). Built for the Casper Agentic Buildathon 2026. All CasCet code is original work created for this event; third-party components used for interop are listed in [`NOTICE`](NOTICE).
