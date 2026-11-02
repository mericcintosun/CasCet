# @cascet/gateway

Wrap any MCP server and charge x402 micropayments per tool call, settled on
Casper. The gateway speaks MCP (tools subset, JSON over Streamable HTTP) to
buyers on `POST /mcp` and forwards calls to the upstream MCP server it wraps.

```ts
import { cascetConfigSchema } from "@cascet/core";
import { startGateway } from "@cascet/gateway";

const gateway = await startGateway(cascetConfigSchema.parse(config));
// gateway.url → http://127.0.0.1:4402/mcp
```

Or from the command line: `npx @cascet/cli wrap cascet.config.json`.

## Configuration (gateway fields)

| Field | Default | Meaning |
|---|---|---|
| `payTo` | | The payee's **account hash**: `00` + 64 hex or `account-hash-<64 hex>`. Get it from a public key with `npx @cascet/cli account-hash <public-key>`. A contract-package payee (`01…`) is refused at startup: casper-x402 1.0.0 settles every payment to an account-hash key, so it could never settle. |
| `host` | `127.0.0.1` | Interface to listen on. Use `0.0.0.0` only for a deployment that must be reachable from other hosts. |
| `port` | `4402` | `0` picks a free port. |
| `cors.allowedOrigins` | `[]` | Exact origins (`https://app.example`) allowed to call the gateway from a browser. `*` and `null` are rejected. |
| `pricing.tools.<name>` | | `{ price: "$0.01", description?, settleBeforeExecute?: false, assets?: ["<asset id>", …] }` |
| `pricing.default` | none | Price for every upstream tool that is neither in `tools` nor in `freeTools` (also takes `assets`). |
| `pricing.freeTools` | `[]` | Upstream tools served free of charge. |
| `pricing.*.assets` | every asset | The assets a price accepts, by id. The 402 lists them in config order, not in the order of this list. |
| `asset` / `assets` | | One token (`asset`) or several (`assets`, in order of preference); set exactly one. See *Accepting several tokens*. |
| `asset.authorization` | from `packageHash` | The token's `transfer_with_authorization` ABI: `"legacy-amount"` (CasCet's own x402 token, takes `amount`) or `"cep3009-value"` (CEP-3009 tokens such as Wrapped CSPR, take `value`). CasCet's tokens default to the first, every other token to the second. Buyers see it as `extra.authorizationStyle`. A legacy-amount asset settled by the hosted facilitator is a config error. |
| `asset.id` | lower-cased `symbol` | Handle used by `pricing.*.assets`. Two assets with the same symbol need explicit ids. |
| `asset.facilitator` | `"default"` | The facilitator that verifies and settles this asset: a key of `facilitators`, or `"default"` (the top-level `facilitator`). |
| `facilitator` | the hosted facilitator | The `"default"` facilitator: `{ url, apiKey?, authScheme?, timeoutMs? }`. |
| `facilitators.<name>` | `{}` | More facilitators, same fields, for assets that name them. |
| `facilitator.authScheme` | `"raw"` | How `apiKey` is sent: `raw` (`Authorization: <key>`, what the hosted CSPR.cloud facilitator expects; `bearer` is refused for it) or `bearer` (`Authorization: Bearer <key>`). |
| `facilitator.timeoutMs` | none | Per-request timeout of this facilitator; replaces `timeouts.facilitatorMs` and `timeouts.settleMs` for its calls. |
| `timeouts.facilitatorMs` | `15000` | Facilitator `/verify` and `/supported`. |
| `timeouts.settleMs` | `90000` | Facilitator `/settle` (a Casper facilitator answers after the transfer executed). |
| `timeouts.upstreamMs` | `60000` | One upstream MCP request. |
| `settlement.nodeUrl` | `anchoring.nodeUrl` | Casper node used for read-only checks when a settlement fails. Without it the check is off. |
| `settlement.eventScanWindow` | `64` | Recent token events a check scans. |
| `settlement.acceptThirdPartySettlement` | `false` | See *Settlement preemption*. |
| `anchoring.gasMotes` | `2500000000` | Gas limit per anchor. Casper charges the whole limit. |
| `anchoring.chainName` | from `network` | `casper` for `casper:casper`, `casper-test` for `casper:casper-test`. |
| `anchoring.confirmTimeoutMs` | `120000` | How long to wait for an anchor to execute. |
| `anchoring.maxConsecutiveFailures` / `cooldownMs` | `3` / `600000` | Circuit breaker for anchoring. |
| `upstream.env` / `upstream.cwd` | | Environment and working directory of a stdio upstream. |

**An upstream tool that is neither priced nor listed in `pricing.freeTools` is
hidden from `tools/list` and refused on `tools/call`.** Nothing is served for
free by accident.

**A stdio upstream does not inherit the gateway's environment.** It gets the
MCP SDK's minimal default set (HOME, LOGNAME, PATH, SHELL, TERM, USER on
POSIX) plus exactly `upstream.env`. Pass any secret the upstream needs there.

**Buyer timeouts must be longer than `facilitatorMs + upstreamMs + settleMs`**
(165 s with the defaults). In the default mode the gateway answers a paid call
only after the tool ran and the payment settled; a buyer that gives up earlier
may be charged without receiving the result. With several facilitators the
gateway sizes this with the slowest one. x402's automatic second settle call
for a settlement reported as pending stays within the same `settleMs`.

## Accepting several tokens

A gateway can sell in several tokens at once, for example CasCet's own x402
token (legacy-amount, settled by a self-hosted facilitator) next to the
official Wrapped CSPR (cep3009-value, settled by the hosted facilitator):

```json
{
  "assets": [
    { "id": "cascet", "packageHash": "hash-cb65a928…35c3", "name": "CasCet X402 Token", "symbol": "CASCET", "facilitator": "self" },
    { "id": "wcspr", "packageHash": "hash-3d80df21…7c1e", "name": "Wrapped CSPR", "symbol": "WCSPR", "decimals": 9, "tokensPerUsd": 20 }
  ],
  "facilitator": { "url": "https://x402-facilitator.cspr.cloud", "apiKey": "<CSPR.cloud access key>" },
  "facilitators": { "self": { "url": "http://127.0.0.1:4501", "apiKey": "<token>", "authScheme": "bearer" } },
  "pricing": { "tools": { "search": { "price": "$0.01" }, "report": { "price": "$0.05", "assets": ["wcspr"] } } }
}
```

- Every 402 lists one `accepts` entry per token the tool accepts, in config
  order, each with its amount (converted with that token's `tokensPerUsd` and
  `decimals`) and `extra` `{ name, version, symbol, decimals,
  authorizationStyle }`. x402 buyers take the first entry they can pay unless
  their policy prefers another.
- Verify and settle go to the facilitator of the token the buyer paid in
  (x402 itself would pick one facilitator per network). A payment in a token
  the tool does not accept is refused before any facilitator is asked.
- Startup fails when a facilitator does not answer `/supported` or does not
  support x402 v2 `exact` payments on the gateway's network, and when a price
  rounds to zero units of one of its tokens.
- The hosted facilitator gets the raw access key, and requirements without
  CasCet's own `extra.authorizationStyle` (no facilitator needs it; buyers
  still see it).
- Receipts, `_meta.cascet` (`asset`, `assetSymbol`, `amountRaw`) and the
  on-chain settlement check use the token and amount of each payment's matched
  requirements; `GET /pricing` and the discovery document list every token of
  every tool.
- Give every asset its own `symbol`: receipts, `_meta.cascet` and the payment
  graph label amounts by `assetSymbol`, so two tokens with one symbol (CasCet's
  token and the official Wrapped CSPR both called "WCSPR", say) would be told
  apart only by the package hash in `asset`. The gateway warns at startup when
  two assets share a symbol.

## Payment flow

1. A `tools/call` for a priced tool without `PAYMENT-SIGNATURE` gets HTTP 402
   with the x402 `PAYMENT-REQUIRED` header and a JSON-RPC error body
   (`code: -32002`, `data`: the decoded PaymentRequired object).
2. With a payment, the gateway first checks the authorization locally, before
   the facilitator is asked:
   - the token (`accepted.asset`) is one the tool accepts;
   - payee and exact price in that token;
   - the payer is an account (`00` tag), the signature's algorithm tag equals
     the public key's, and the public key belongs to the payer (casper-x402
     1.0.0 verifies authorizations that break these rules, but they always
     revert on-chain);
   - it stays valid long enough: `facilitatorMs` + `upstreamMs` (not with
     `settleBeforeExecute`) + 30 s for the settle transaction;
   - this `(payer, nonce)` was never presented before, in any of the
     gateway's tokens. Replays are refused, also across restarts.

   Then the facilitator of that token verifies it, and the gateway appends a
   write-ahead record of the authorization (with its token) to the receipt
   log before anything runs. If that write fails the call is refused (503,
   nothing charged).
3. Default mode: the tool runs, then the payment settles. Buyers pay only for
   successful calls. With `settleBeforeExecute: true` the payment settles
   first and the tool runs only once it is final; use it for tools with side
   effects or that buy from other paid tools. A tool that fails after
   settlement is not refunded (the receipt notes it). x402's own
   settle-before-handler flows (`extra.paymentFlow` `upfront` or `escrow`)
   are refused, whether a route or a facilitator's `/supported` extensions ask
   for them: x402 would settle before the gateway's checks and write-ahead
   record. Use `settleBeforeExecute` instead.
4. Settlement outcomes:
   - settled: the result, with `_meta.cascet.paymentId` and the
     `X-CASCET-PAYMENT-ID` / `PAYMENT-RESPONSE` headers;
   - failed: HTTP 402, JSON-RPC `-32002`, no tool result;
   - unknown (facilitator timeout, broken connection, 5xx without verdict,
     casper-x402 losing track of a submitted transfer, or a failure answer
     that carries a transaction hash): JSON-RPC `-32003`, receipt status
     `unknown`. Do not pay again for that call; reconcile the receipt
     on-chain.

   x402 settles a second time when the facilitator reports the settlement as
   pending (`settlement_pending` with a transaction hash: broadcast, not seen
   executing yet), and keeps only the second answer. If that retry gets no
   verdict naming a transaction (rate limited, shutting down, a proxy error,
   a timeout), the gateway keeps the first answer's hash: the receipt is
   `unknown` with that `txHash`, never `failed`. Both settle calls together
   get one `settleMs` (the facilitator's `timeoutMs` when set).

A priced tool without a matching payment route, or a verified payment whose
amount, payee, asset or network differs from the configuration (or whose
token differs from the one the gateway checked locally), is refused (fail
closed). Every 402 carries the `PAYMENT-REQUIRED` header and the decoded
challenge in `error.data`. When verified work ends before settlement (the
tool threw or returned an error, the gateway refused the verified payment,
or the upstream was gone before a settle-first call), the gateway tells x402
through its cancellation dispatcher; the `exact` scheme moves nothing then.

## Settlement preemption

Anyone can submit a signed authorization. If someone else executes it before
the gateway's facilitator does, the facilitator's settle fails although the
seller was paid. When `settlement.nodeUrl` (or `anchoring.nodeUrl`) is set,
the gateway then reads the events of the token the payment was in and looks
for `AuthorizationUsed(payer, nonce)` directly followed by
`Transfer(payer → payTo, price)`. A used nonce alone is never taken as
payment: the payer can cancel it or spend it on another authorization. Both
token styles write this pair (checked on CasCet's token and on testnet
Wrapped CSPR).

- Exact authorization found: delivered as settled by a third party when
  `acceptThirdPartySettlement` is on, otherwise recorded as `unknown`.
  Leave it off when several gateways share this `payTo` without sharing one
  facilitator nonce cache: a buyer could present one authorization to each.
- Nonce canceled by the payer: failed.
- Nonce used without the matching transfer right after it: noted on the
  receipt, but an `unknown` outcome stays `unknown`. That reading depends on
  the token's event layout; a token upgrade that reordered the events would
  otherwise turn the facilitator's own transfer into a "failure" and invite
  the buyer to pay twice.

## Operations

- `GET /health`: `ok`, `degraded` (anchoring paused) or `unavailable` (HTTP 503
  while the upstream is down). Includes upstream state, tool counts and
  anchoring circuit state.
- The upstream is supervised: when it exits, or stops answering (it is pinged
  every 30 s, and 3 connection-level failures of pings or tool calls in a row
  count as lost, which also covers a remote http upstream), the gateway answers
  503 (no 402 challenges for calls that cannot run), reports
  `server-offline`, and reconnects with backoff. If it cannot,
  `startGateway`'s `onFatal` runs (default: close and set exit code 1 so a
  supervisor restarts the process).
- Shutdown (`close()`, SIGINT/SIGTERM): new calls get 503 and calls in flight
  may finish settling, for at most `facilitatorMs + upstreamMs + settleMs`.
  Give the process supervisor a stop timeout at least that long. A second
  signal exits at once.
- Browser requests carrying an `Origin` that is not allowlisted get HTTP 403.
- `GET /receipts`, `GET /pricing` (`assets`, and per tool its `accepts`:
  token id, symbol, package hash, raw amount, authorization style). As on
  single-token gateways, the top-level `asset` is the preferred (first) token
  and each tool's `amountRaw` is in that token; a tool that does not accept
  it has no `amountRaw` (its amounts are in `accepts`).
  `GET /.well-known/x402.json` (one `accepts` entry per token, with its
  `extra`).
- Receipts are appended to `.cascet/<name>.receipts.jsonl`; status is
  `settled`, `failed` or `unknown`, with the verified payer and the
  authorization nonce. The same log holds the write-ahead authorization
  records (`"kind": "authorization"`). If a receipt cannot be written after
  the payment settled, the buyer still gets the result and the receipt is
  kept in memory (`GET /receipts`); the error is logged.
