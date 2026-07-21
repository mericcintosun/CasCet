# cascet

**Turn any MCP server into a paid service — per-tool [x402](https://www.x402.org)
micropayments settled on [Casper](https://casper.network), with cascading
agent-to-agent payment chains.**

The CLI for [CasCet](https://cascet.vercel.app) — *Stripe for MCP servers*. Wrap a
server so agents pay per tool call, or connect any MCP host to paid servers so it
answers `402` challenges automatically under a spending budget.

```bash
npx cascet init          # write a starter cascet.config.json
npx cascet wrap          # put a paywall in front of your MCP server (no code changes)
npx cascet connect <url> # stdio bridge: let any MCP host pay for paid servers
```

## Commands

### `cascet init [name]`
Writes a starter `cascet.config.json`. Fill in `payTo` (your Casper account or a
`RevenueSplit` contract), `asset.packageHash` (the CEP-18 payment token), the
facilitator API key, and a price per tool.

### `cascet wrap [config]`
Starts the paid gateway (default `./cascet.config.json`). It fronts your upstream
MCP server, advertises each tool's price in `tools/list`, runs the x402 flow on
`tools/call`, and **only settles payment if the tool call succeeds**. Also serves a
Bazaar-compatible catalog at `/.well-known/x402.json`.

### `cascet connect <gateway-mcp-url>`
A stdio ⇄ paid-HTTP bridge for MCP hosts (Claude Code, Claude Desktop, Cursor). It
forwards JSON-RPC to a CasCet gateway and pays every `402` transparently under a
budget.

```bash
CASCET_KEY_PATH=./agent.pem \
CASCET_MAX_SESSION=5000000000 \
npx cascet connect http://localhost:4402/mcp
```

**`connect` env vars:** `CASCET_KEY_PATH` (PEM private key, required) ·
`CASCET_KEY_ALGO` (`ed25519` | `secp256k1`, default `ed25519`) ·
`CASCET_MAX_PER_CALL` · `CASCET_MAX_SESSION` (budgets in raw token units).

## How it works

MCP speaks JSON-RPC over one HTTP endpoint, so the gateway maps each priced tool to
a synthetic x402 route. On `tools/call` it returns `402 Payment Required` with the
price; the wallet signs a CEP-18 `transfer_with_authorization` (EIP-712) and
retries; the gateway runs the tool and settles through the hosted Casper
facilitator. When a paid tool itself buys from other paid tools, CasCet links every
hop into a **cascade** — the whole payment chain reconstructs from receipts alone.

Network: **Casper Testnet** (`casper:casper-test`), CEP-18 payment token,
`casper-eip-712` signatures.

## Links

- Site + live dashboard: <https://cascet.vercel.app>
- Source & docs: <https://github.com/mericcintosun/CasCet>
- x402-MCP spec: <https://github.com/mericcintosun/CasCet/blob/main/docs/x402-mcp-spec.md>

Apache-2.0 · built for the Casper Agentic Buildathon 2026.
