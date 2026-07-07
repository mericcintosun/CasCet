# CasCet — DoraHacks Submission Pack

Casper Agentic Buildathon 2026 · Casper Innovation Track

## One-liner

Turn any MCP server into a paid service — per-tool x402 micropayments with cascading agent-to-agent payment chains, settled instantly on Casper.

## Elevator pitch (for the BUIDL description)

AI agents reach the world through MCP servers, but almost all of them are free — there's no clean way to charge an autonomous agent per call. x402 fixes the payment primitive, yet every x402 tool today is point-to-point: an agent pays a server and that's it. Real workloads aren't shaped like that — a paid "analysis" tool needs paid "data" tools underneath. CasCet is the monetization layer for MCP on Casper (*Stripe for MCP servers*) **plus** the piece nobody has shipped: composable multi-hop payments. Wrap any MCP server with one command, price each tool, and let agents pay per call in CEP-18 over x402 — and when a paid tool buys from other paid tools, CasCet composes the payment chain, links every hop on-chain, and splits revenue with an Odra contract. Casper's instant deterministic finality is what makes multi-hop settlement actually usable.

## What's built (all verified)

- **Gateway** (`cascet wrap`) — wraps any MCP server, per-tool x402 pricing, charge-only-on-success, receipt store + live event push.
- **Client** (`cascet connect`) — paying stdio bridge for MCP hosts with per-call/session spend budgets; cascade parent propagation.
- **Two flagship paid MCP servers** — `casper-defi-data` (live CSPR/RWA/DeFi data) and `portfolio-analyst`, which autonomously buys from the data server (the cascade).
- **Two Odra contracts** — `ReceiptRegistry` (anchors receipts + cascade links) and `RevenueSplit` (CEP-18 PaymentSplitter). 8/8 unit tests green against a real CEP-18.
- **Live dashboard** — Next.js + shadcn/ui, dark/light/system, real-time revenue, receipts with cspr.live links, and the cascading payment graph.
- **Local E2E** — one command runs the whole cascade with a mock facilitator; asserts every downstream payment links to the root.

## Demo video script (~2.5 min)

1. **Hook (0:00–0:20).** "AI agents pay for almost nothing they use. CasCet makes any MCP server a paid service on Casper — and does something no one else has: it settles whole chains of agents paying agents." Show the one-liner + architecture diagram.
2. **Wrap (0:20–0:50).** Terminal: `npx cascet init` → show `cascet.config.json` with per-tool prices → `npx cascet wrap`. "That's a normal MCP server, now paid. No code changes."
3. **Agent pays (0:50–1:30).** Start the dashboard. Run the demo / point Claude at the analyst via `cascet connect`. Call `analyze_portfolio`. Narrate: "The agent pays 10 cents. But watch — the analysis tool is itself a customer." Show the terminal cost breakdown: analyst buys 4 data tools for 7 cents.
4. **The cascade on-chain (1:30–2:05).** Cut to the dashboard: revenue ticks up live, receipts stream in, the **payment graph** branches (agent → analyst → data server) and the newest chain highlights. Click a settlement link → cspr.live testnet deploy. "Every hop, real, on Casper — instant finality, so the chain never stalls."
5. **On-chain layer + close (2:05–2:30).** Show `cargo odra test` (8/8) and the deployed ReceiptRegistry / RevenueSplit on cspr.live. "Receipts anchored, revenue split by contract. CasCet: the payment layer for the MCP economy, first on Casper." End on repo + socials.

## Testnet artifacts

- Deployer account: [`01dd710d…`](https://testnet.cspr.live/account/01dd710d5083920b20c706a92d742c7bf9162d09c96fa373bd0a67b0bf51d3f183)
- **ReceiptRegistry** package: `hash-bdf8422b69d7bfb7581e7b2c63fbfb0fc8b23701181289411170bce5cf996f97`
- Deploy tx: [`632a0d75…`](https://testnet.cspr.live/transaction/632a0d756c51c18ec0804b8bec338772691dca5a981835777c6512687afe1866)
- On-chain `record` (anchored receipt): [`0f796802…`](https://testnet.cspr.live/transaction/0f79680230269c43b31528d282dc094d1f5fea000087332f6193e29361b16e4d)
- Verified on-chain: `count → 1`, receipt reads back with intact fields.
- RevenueSplit: unit-tested (8/8); testnet deploy pending final round.

## Long-term launch plans (judging criterion)

- Publish `cascet` to npm; hosted control plane (register server → paid endpoint + dashboard in one step).
- Public x402 economy explorer indexing the on-chain ReceiptRegistry.
- Mainnet; streaming/per-second price schemes; agent-facing price-discovery API.
- Socials: project X account + landing page at submission (see `docs/socials.md`).

## Links

- GitHub: `<repo url>`
- Demo video: `<youtube/loom url>`
- Live dashboard (if hosted): `<url>`
