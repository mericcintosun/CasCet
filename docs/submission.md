# CasCet — DoraHacks Submission Pack

Casper Agentic Buildathon 2026 · Casper Innovation Track

## One-liner

Turn any MCP server into a paid service — per-tool x402 micropayments with cascading agent-to-agent payment chains, settled instantly on Casper.

## Elevator pitch (for the BUIDL description)

AI agents reach the world through MCP servers, but almost all of them are free — there's no clean way to charge an autonomous agent per call. x402 fixes the payment primitive, yet every x402 tool today is point-to-point: an agent pays a server and that's it. Real workloads aren't shaped like that — a paid "analysis" tool needs paid "data" tools underneath. CasCet is the monetization layer for MCP on Casper (*Stripe for MCP servers*) **plus** the piece nobody has shipped: composable multi-hop payments. Wrap any MCP server with one command, price each tool, and let agents pay per call in CEP-18 over x402 — and when a paid tool buys from other paid tools, CasCet composes the payment chain, links every hop on-chain, and splits revenue with an Odra contract. Casper's instant deterministic finality is what makes multi-hop settlement actually usable.

## What's built (all verified)

- **CLI + libraries on npm** — `npx @cascet/cli init/wrap/connect`, published alongside `@cascet/core`, `@cascet/client`, `@cascet/gateway` (via a GitHub Actions release workflow).
- **Gateway** (`@cascet/cli wrap`) — wraps any MCP server, per-tool x402 pricing, charge-only-on-success, receipt store + on-chain anchoring + live event push.
- **Client** (`@cascet/cli connect`) — paying stdio bridge for MCP hosts with per-call/session spend budgets; cascade parent propagation.
- **Two flagship paid MCP servers** — `casper-defi-data` (live CSPR/RWA/DeFi data) and `portfolio-analyst`, which autonomously buys from the data server (the cascade).
- **Autonomous LLM buyer** (`@cascet/agent`) — Claude prices the paid tools, decides what to buy for a DeFi/RWA goal, and pays x402 per call under a fixed budget (real Claude — via the Anthropic API, or free via `cascet connect` on a Claude Max/Pro plan).
- **Five Odra contracts** (13/13 tests) — `ReceiptRegistry` (anchors receipts + cascade links, upgradable), `RevenueSplit` (CEP-18 PaymentSplitter), `CascadeController` (budget-bounded cascade tree), `PaymentChannel` (prepaid voucher channels) and a `DemoToken` CEP-18. **Seven on-chain deployments** (the five + an upgraded ReceiptRegistry + the third-party Cep18X402 settlement token).
- **Live dashboard + pages** (Next.js 15 + shadcn/ui, dark/light/system): `/dashboard` (real-time revenue, receipts, cascading payment graph), **`/build`** (a config-generator wizard — fill a form → validated `cascet.config.json` + commands), **`/withdraw`** (Casper Wallet connect + a real on-chain `release` from the RevenueSplit), **`/explorer`** (on-chain-backed — rebuilds the economy from the ReceiptRegistry), and `/playground` (interactive cascade budget calculator).
- **Real x402 settlement** — a self-hosted x402 facilitator verifies + settles a real CEP-18 `transfer_with_authorization`; receipts anchored on-chain.
- **Local E2E** — one command runs the whole cascade with real on-chain settlement on both hops; asserts every downstream payment links to the root.
- **x402-MCP spec** — the price-advertisement + settlement + cascade-attribution convention written up as a reusable proposal (`docs/x402-mcp-spec.md`).

## Demo video script (~1:50)

1. **Hook (0:00–0:25).** "AI agents pay for almost nothing they use. CasCet makes any MCP server a paid service on Casper — and does something no one else has: it settles whole chains of agents paying agents." Show the one-liner + architecture.
2. **Wrap (0:25–0:50).** The `/build` wizard: fill server + per-tool prices → a validated `cascet.config.json` appears live → `npx @cascet/cli wrap`. "A normal MCP server, now paid. No code changes."
3. **Agent pays + the cascade (0:50–1:25).** Run the demo. `analyze_portfolio` is called; the agent pays 10¢, and the analysis tool is itself a customer buying 4 data tools for 7¢. The dashboard's **payment graph** branches (agent → analyst → data server) and the newest chain highlights.
4. **On-chain proof (1:25–1:45).** The `/explorer` reads it straight from the **ReceiptRegistry** (real counts, anchored receipts with cspr.live links); `/withdraw` pulls a payee's share with a wallet-signed `release`; `cargo odra test` shows 13/13. "Every hop real, on Casper — instant finality, so the chain never stalls."
5. **Close (1:45–1:50).** Repo + npm + live site + socials.

## Testnet artifacts (all live)

- Deployer / operator: [`01dd710d…`](https://testnet.cspr.live/account/01dd710d5083920b20c706a92d742c7bf9162d09c96fa373bd0a67b0bf51d3f183)
- **ReceiptRegistry**: `hash-bdf8422b69d7bfb7581e7b2c63fbfb0fc8b23701181289411170bce5cf996f97`
- **RevenueSplit**: `hash-fa21efb406a8151d15a393bc366e51192a9ea15fd7fe23faffc54f021b32883c`
- **CascadeController**: `hash-624134336d1f63ce539ebef9c226e6c463f70a8e85b593bbc5d370520d797980`
- **DemoToken (CEP-18)**: `hash-b3e9908b6cdbf5c565b686938994e3ac8e6749f41bcbe83615604321a0965d49`
- Full hash table + 10 sample transactions: [`docs/buidl-page.md`](buidl-page.md)

Verified on-chain:
- Gateway anchored a full cascade (1 root + 4 children); `count` 2→7, child `parent_id` links back to root.
- Real x402 settlement: [`0218ff4c…`](https://testnet.cspr.live/transaction/0218ff4c8d726a610a7a02168cd24941d4db07a9ca787c2fa6f89f21ac159ce7)
- RevenueSplit `release` (the `/withdraw` flow): [`f7cda49c…`](https://testnet.cspr.live/transaction/f7cda49c87e1e2f13a3b8f3bb0a75ef19f57e911bdf6238f529ae43489437c21)
- CascadeController over-budget hop rejected on-chain: [`d1df6c89…`](https://testnet.cspr.live/transaction/d1df6c898bbc8edc63fca9018dd4352f40afc6cea45a20666c91dbaf28887572)

## Long-term launch plans (judging criterion)

- **Shipped:** CLI + libraries on npm (`npx @cascet/cli`); a config-generator control-plane wizard; an on-chain-backed explorer.
- **Next:** a hosted control plane (register a server → paid endpoint + dashboard in one step); take the paid-MCP + cascade spec to the x402 / MCP ecosystem.
- **Later:** mainnet; a protocol take-rate on settled volume; streaming / per-second price schemes; an agent-facing price-discovery API and a Bazaar marketplace.
- **Socials (live):** X [`@cascet_xyz`](https://x.com/cascet_xyz) · Discord [`discord.gg/fcjevk47k`](https://discord.gg/fcjevk47k) · GitHub. Copy-paste launch content in [`docs/launch-kit.md`](launch-kit.md).

## Links

- GitHub: <https://github.com/mericcintosun/CasCet>
- Live app: <https://cascet.vercel.app>
- npm: <https://www.npmjs.com/package/@cascet/cli>
- Demo video: `cascet-demo.mp4` (repo root) — published to YouTube; link on the BUIDL page (`docs/youtube.md` has the metadata).
