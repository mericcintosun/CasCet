# @cascet/cli

**Turn any MCP server into a paid service — per-tool [x402](https://www.x402.org)
micropayments settled on [Casper](https://casper.network), with cascading
agent-to-agent payment chains.**

The CLI for [CasCet](https://cascet.vercel.app) — *Stripe for MCP servers*. Wrap a
server so agents pay per tool call, or connect any MCP host to paid servers so it
answers `402` challenges automatically, within spending limits you set.

```bash
npx @cascet/cli init                       # write a starter cascet.config.json
npx @cascet/cli account-hash <public-key>  # the payTo value for a Casper public key
npx @cascet/cli wrap                       # put a paywall in front of your MCP server (no code changes)
npx @cascet/cli connect <url>              # stdio bridge: let any MCP host pay for paid servers
```

> Installing globally (`npm i -g @cascet/cli`) exposes the command as `cascet`.

## Commands

### `cascet init [name]`
Writes a starter `cascet.config.json` for Casper Testnet and prints the next steps:

- **`payTo`** is the payee's **account hash** (`"00"` + 64 hex, or `account-hash-<hex>`).
  It is **not** a public key: a public key passes x402's address check, but the
  payment would be credited to an account nobody controls. Get the value with
  `cascet account-hash <public-key>`. `cascet wrap` refuses a public key or the
  template placeholder.
- **Do not use a contract package** (`hash-<hex>`, e.g. a RevenueSplit) as `payTo`
  yet. The config accepts it, but every facilitator that exists today
  (`@make-software/casper-x402` 1.0.0, hosted or self-hosted) settles a payTo as an
  account hash, so that revenue would be credited to an account nobody controls,
  and CasCet buyers refuse to pay a contract-package payee. `cascet wrap` warns
  about it.
- **`facilitator.url`** points at CasCet's **self-hosted facilitator**
  (`http://127.0.0.1:4501`), and `asset` at CasCet's testnet x402 token. Start the
  facilitator from a CasCet checkout:
  ```bash
  pnpm install && pnpm build
  CASCET_FACILITATOR_KEY=/absolute/path/fee-payer.pem CASCET_SELLER_ACCOUNT_HASH=<your payTo> \
    pnpm --filter @cascet/e2e facilitator
  ```
  The fee-payer key pays the CSPR gas of every settlement; keep it separate from
  your `payTo` account.

**Which facilitator settles which token.** The hosted facilitator
(`https://x402-facilitator.cspr.cloud`, needs a CSPR.cloud access token in
`facilitator.apiKey`) only settles CEP-3009 tokens whose `transfer_with_authorization`
takes `value`, such as the official Wrapped CSPR (testnet
`hash-3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e`, mainnet
`hash-8df5d26790e18cf0404502c62ce5dc9025800ad6975c97466e20506c39c505b6`). CasCet's own
x402 token takes `amount`, so it only settles through the self-hosted facilitator.
`cascet wrap` warns when the hosted facilitator is paired with a token that is not
known to be CEP-3009.

### `cascet account-hash <public-key>`
Prints the `payTo` value (`"00"` + account hash) for an ed25519 (`01…`) or secp256k1
(`02…`) public key. Only the value goes to stdout, so it can be captured in a script.
Sellers put it in `payTo`; buyers put the seller's value in `CASCET_ALLOWED_PAYTO`.

### `cascet wrap [config]`
Validates the config (default `./cascet.config.json`) and starts the paid gateway. It
fronts your upstream MCP server, advertises each tool's price in `tools/list` and runs
the x402 flow on `tools/call`. Also serves a Bazaar-compatible catalog at
`/.well-known/x402.json`. Config errors are reported per field, without a stack trace
(`CASCET_DEBUG=1` shows it), and a contract-package `payTo` or a hosted facilitator
paired with a token it cannot settle prints a warning.

### `cascet connect <gateway-mcp-url>`
A stdio ⇄ paid-HTTP bridge for MCP hosts (Claude Code, Claude Desktop, Cursor). It
forwards JSON-RPC to a CasCet gateway and pays each `tools/call` challenge within
the limits below. Nothing else is ever paid for.

**Spending controls are mandatory.** `connect` refuses to start unless you pin the
sellers and tokens you intend to pay and set both budgets:

```bash
CASCET_KEY_PATH=/absolute/path/agent.pem \
CASCET_ALLOWED_PAYTO=00<seller account hash> \
CASCET_ALLOWED_ASSETS=hash-<token package hash> \
CASCET_MAX_PER_CALL=1000000000 \
CASCET_MAX_SESSION=5000000000 \
npx @cascet/cli connect http://localhost:4402/mcp
```

The same in an MCP host config:

```json
{
  "mcpServers": {
    "cascet": {
      "command": "npx",
      "args": ["@cascet/cli", "connect", "https://gateway.example.com/mcp"],
      "env": {
        "CASCET_KEY_PATH": "/absolute/path/agent.pem",
        "CASCET_ALLOWED_PAYTO": "00<seller account hash>",
        "CASCET_ALLOWED_ASSETS": "hash-<token package hash>",
        "CASCET_MAX_PER_CALL": "1000000000",
        "CASCET_MAX_SESSION": "5000000000"
      }
    }
  }
}
```

| Env var | Meaning |
|---|---|
| `CASCET_KEY_PATH` | PEM private key of the paying wallet (required). Use an absolute path: MCP hosts start the bridge from an unpredictable working directory. |
| `CASCET_KEY_ALGO` | `ed25519` (default) or `secp256k1`. |
| `CASCET_NETWORK` | Comma-separated CAIP-2 networks to pay on. Default `casper:casper-test`; add `casper:casper` to pay on mainnet. A `402` for any other network is refused. |
| `CASCET_ALLOWED_PAYTO` | Comma-separated payees to pay: account hashes (`00…` or `account-hash-…`). A contract package (`hash-…`) is rejected: no facilitator can settle one today. Required unless `--allow-any-seller`. |
| `CASCET_ALLOWED_ASSETS` | Comma-separated CEP-18 package hashes to pay in. Required unless `--allow-any-seller`. |
| `CASCET_MAX_PER_CALL` | Largest single payment, in raw token units. Required unless `--allow-unlimited-budget`. |
| `CASCET_MAX_SESSION` | Total per token for this bridge session, in raw token units. Required unless `--allow-unlimited-budget`. |
| `CASCET_PREFER_STYLES` | Optional. Comma-separated authorization styles in order of preference, used when a gateway offers several tokens: `cep3009-value` (CEP-3009 tokens such as Wrapped CSPR) and `legacy-amount` (CasCet's own x402 token). It only orders the options your allowlists and budgets accept, never makes another one payable. Without it the gateway's order decides. CasCet's x402 tokens and Wrapped CSPR rank by the style they are known to have, whatever the gateway labels them. |
| `CASCET_TIMEOUT_MS` | Deadline per call in ms, default `200000`. A paid call includes the on-chain settlement, which can take a minute or more, and a call that times out after its payment was sent may still settle, so keep this above the gateway's own tool and settlement timeouts. |
| `CASCET_TOOL_PINS` | Tool pin file, default `~/.cascet/tool-pins.json`. |
| `CASCET_ALLOW_ANY_SELLER=1` | Same as `--allow-any-seller`. |
| `CASCET_ALLOW_UNLIMITED_BUDGET=1` | Same as `--allow-unlimited-budget`. |

| Flag | Meaning |
|---|---|
| `--allow-any-seller` | Start without the payee/token allowlists. Not recommended: a hostile or MITM'd gateway can then name any payee or token. |
| `--allow-unlimited-budget` | Start without the per-call/session limits. Not recommended. |
| `--accept-tool-changes=<sha256>[,<sha256>...]` | Pin the reviewed tool definitions (or gateway instructions) with these digests, as printed in the quarantine warning (see below). Every other change stays quarantined. A bare `--accept-tool-changes` is refused. |

Amounts are whole numbers of raw token units (`1000000000` = 1 token with 9
decimals). The session limit applies per token and counts signed authorizations,
and it resets when the bridge restarts. Every `402` is also checked field by field
(strict amounts, an authorization window of at most 15 minutes, account-hash payees,
a known authorization style, the token's EIP-712 name and version), redirects are
never followed, and oversized responses (a `402` body over 64 KiB, any other over
16 MiB) are refused. Plain `http://` is only accepted on loopback. When a gateway
offers several tokens, the bridge pays the first one these checks accept (or the
first of your `CASCET_PREFER_STYLES`), and refuses, naming each reason, when none
passes.

**Tool pinning (tool-poisoning defense).** On first contact with a gateway, the
bridge records a sha256 of every tool definition it serves (name, title,
description, schemas, annotations) and of the gateway's `initialize` instructions in
the pin file. If a tool later changes, or a new tool appears, the bridge prints the
full new definition and its sha256 to stderr, withholds it from the model, and
refuses to call or pay for it; changed or new instructions are withheld the same
way. The model is only told to ask you to review the `cascet connect` log.

To accept a change, read the full text in the log, then restart `connect` with the
exact flag the warning prints, e.g. `--accept-tool-changes=3f2a…` (several digests are
comma-separated). Only the definitions with those digests are pinned. Any other
change, including a later change to the same tool, stays quarantined even while the
flag is still in your MCP host config, so you can remove the flag once the new pins
are saved. `connect` refuses to start when the pin file cannot be read or its
directory cannot be written.

## How it works

MCP speaks JSON-RPC over one HTTP endpoint, so the gateway maps each priced tool to
a synthetic x402 route. On `tools/call` it returns `402 Payment Required` with the
price; the wallet signs a CEP-18 `transfer_with_authorization` (EIP-712) and
retries; the gateway runs the tool and settles through its facilitator. When a paid
tool itself buys from other paid tools, CasCet links every hop into a **cascade** —
the whole payment chain reconstructs from receipts alone.

Networks: Casper Testnet (`casper:casper-test`) by default, Casper Mainnet
(`casper:casper`) when listed. CEP-18 payment token, `casper-eip-712` signatures.

## Links

- Site + live dashboard: <https://cascet.vercel.app>
- Source & docs: <https://github.com/mericcintosun/CasCet>
- x402-MCP spec: <https://github.com/mericcintosun/CasCet/blob/main/docs/x402-mcp-spec.md>

Apache-2.0 · built for the Casper Agentic Buildathon 2026.
