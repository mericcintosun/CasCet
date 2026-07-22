# CasCet

Turn any MCP server into a paid service. Per-tool x402 micropayments, with cascading agent-to-agent payment chains, settled on Casper. Live on mainnet.

Casper Agentic Buildathon 2026, Casper Innovation Track (finalist).

## The problem

AI agents reach the outside world through MCP servers: small tools that fetch a price, run an analysis, or query a chain. Developers ship thousands of them, and almost all are free, because there is no clean way to charge an autonomous agent per call. An agent cannot fill in a card form or manage a subscription.

x402 (HTTP 402, Payment Required) fixes paying for a single request. But every x402 tool today is a point-to-point vending machine, and real agent work composes. A paid portfolio-analysis tool internally needs a paid price feed and a paid RWA feed, each a paid service of its own. Nobody settles those payment chains. CasCet does.

## What CasCet does

CasCet is the monetization layer for MCP on Casper, plus the piece no one else has shipped: composable, multi-hop (cascading) payments.

Wrap. One command puts a paywall in front of any existing MCP server. Set a price per tool, agents pay per call in a CEP-18 token over x402, and your tool code stays unchanged.

Connect. A bridge lets any MCP host (Claude Code, Claude Desktop, Cursor) call paid servers, answering 402 challenges automatically under a spending budget you set.

Cascade. When a paid tool buys from other paid tools, CasCet composes the payments into a chain, links every hop to its parent on-chain, and enforces revenue splits at the contract level.

See it. A live dashboard shows revenue, receipts with cspr.live settlement links, and the cascading payment graph in real time.

## The primitive: budget-bounded cascades with recursive attribution

CasCet's headline is a machine-to-machine primitive that only makes sense once payments compose into trees. The CascadeController contract turns a cascade into a programmable supply chain.

On-chain budget tree. An agent opens a cascade with one deposit that caps the whole call tree. Every hop is paid from it, and the contract refuses any hop that would exceed the budget. The cap is enforced by construction, not by trusting the gateway. A plain agent wallet only caps per-call spend; this caps the entire tree.

Recursive attribution. A configurable share of a child hop's earnings flows up to the parent hop's payee, so the service that composed a tool earns a margin on what it resells. The payment graph becomes the revenue-sharing graph.

For high-frequency traffic, a PaymentChannel contract lets an agent open a channel with one deposit, authorize thousands of calls off-chain with signed vouchers, and settle with two on-chain writes.

## The autonomous buyer

The seller side turns MCP tools into paid services. The buyer makes that economy self-driving. Given a DeFi or RWA goal, a real Claude agent discovers the paid tools a gateway advertises together with their x402 prices, decides which are worth buying, pays each call per x402 out of a fixed budget, adapts when the paywall rejects an over-budget call, and writes a recommendation grounded in the data it actually purchased. There is no hardcoded tool list and no fixed sequence: the model reads prices and chooses.

You can run it for free with real Claude on a Max or Pro plan through the connect bridge, with no paid API key. Tool discovery, x402 pricing, per-call payment, budget enforcement, cascade receipts, and settlement are all real.

## Two clients: TypeScript and Python

Agents are written in both languages, so CasCet ships a paying client for each. The Python client builds the same EIP-712 authorization digest as the TypeScript one, checked byte-for-byte, and signs it with a Casper key. Both have settled real payments on-chain, on mainnet and testnet.

## Live on Casper mainnet

CasCet is not a testnet demo. The full contract set is deployed on Casper mainnet, and a real x402 payment has settled there from both clients.

Mainnet, chain "casper" (open at cspr.live/contract-package/HASH):

- Cep18X402 payment token: 8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41
- ReceiptRegistry: f86bef35062e92d06b8171cf4131fdf557463589aca9112a348e5eb24159eb93
- RevenueSplit: 269afcceb147db41f68f5721df7b3957e5efeefb3bedbb9deba324c3a45d09c5
- CascadeController: c7e56988214c62dc5eda20b14894a7514f7388560850b6db3094758363a62189
- PaymentChannel: db2dc42b76f354e7716cafea8619ae6bc85fe50bc3e73979c2360dbba1458c57
- DemoToken (CEP-18): 3da88daf3f276d915ea4f6734e0d4b3d4781358734c369b95de028a2c094fe74

Real x402 settlements on mainnet (0.5 WCSPR via transfer_with_authorization, status Success):

- TypeScript client: https://cspr.live/transaction/2c66141c324216f4966f2d565c64c55cb37047cfc86b9863717d08d1b60a3bd1
- Python client: https://cspr.live/transaction/754224da36db9ecaef8399e720fc04fc2bc4605b383c63964788860db25533b7

Everything is also live on testnet. The full address list for both networks is in the repo: https://github.com/mericcintosun/CasCet/blob/main/docs/onchain.md

## Security

Because real value now flows through it, CasCet went through an adversarial security review before mainnet, across the Odra contracts, the payment path, and the dashboard. Findings were fixed and verified. The facilitator refuses to sponsor any payment outside an allowlist, the paying client pins the recipient and asset it will pay, payment-channel vouchers are bound to their contract and chain so they cannot be replayed across deployments, and the fund-moving contracts follow checks-effects-interactions. The contracts have no admin drain and no mint path, and no secrets are committed to the repo. All 13 contract tests pass, and the contracts were redeployed to mainnet with the fixes.

One finding is worth naming, because it is why CasCet self-hosts its facilitator. The public hosted x402 facilitator sends the CEP-18 settle argument under the name "value", while the reference token's entry point expects "amount", so every settlement it attempts reverts on-chain. CasCet runs its own facilitator, fee-sponsored, that sends the correct argument. That is what makes real settlement work end to end.

## SDK on npm

The toolchain is published: @cascet/core, @cascet/client, @cascet/gateway, and @cascet/cli. A developer runs npx @cascet/cli init, wrap, or connect to price a server or to pay one.

## Also built

Every gateway serves an x402 Bazaar catalog at /.well-known/x402.json, so any x402 agent can discover CasCet-monetized tools. A live on-chain explorer rebuilds the whole economy from the ReceiptRegistry and links each receipt to cspr.live. There is also a proposed reusable spec for paid MCP over x402 with cascade attribution (docs/x402-mcp-spec.md).

## Why Casper

Instant deterministic finality. A three-hop payment chain would stall waiting on probabilistic finality; on Casper each hop settles in seconds, with certainty. On-chain revenue splits run through an Odra contract, enforced at the contract level rather than by trusting an off-chain ledger. Fees are predictable, so agents can budget their spending.

## Links

- Live site: https://cascet.vercel.app
- Demo video (2:43): https://youtu.be/ZwHakuOdfiw
- Code: https://github.com/mericcintosun/CasCet
- On-chain addresses (mainnet + testnet): https://github.com/mericcintosun/CasCet/blob/main/docs/onchain.md
- npm: https://www.npmjs.com/package/@cascet/cli
