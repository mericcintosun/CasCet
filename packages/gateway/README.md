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
| `pricing.tools.<name>` | | `{ price: "$0.01", description?, settleBeforeExecute?: false }` |
| `pricing.default` | none | Price for every upstream tool that is neither in `tools` nor in `freeTools`. |
| `pricing.freeTools` | `[]` | Upstream tools served free of charge. |
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
may be charged without receiving the result.

## Payment flow

1. A `tools/call` for a priced tool without `PAYMENT-SIGNATURE` gets HTTP 402
   with the x402 `PAYMENT-REQUIRED` header and a JSON-RPC error body
   (`code: -32002`, `data`: the decoded PaymentRequired object).
2. With a payment, the gateway first checks the authorization locally, before
   the facilitator is asked:
   - payee and exact price;
   - the payer is an account (`00` tag), the signature's algorithm tag equals
     the public key's, and the public key belongs to the payer (casper-x402
     1.0.0 verifies authorizations that break these rules, but they always
     revert on-chain);
   - it stays valid long enough: `facilitatorMs` + `upstreamMs` (not with
     `settleBeforeExecute`) + 30 s for the settle transaction;
   - this `(payer, nonce)` was never presented before. Replays are refused,
     also across restarts.

   Then the facilitator verifies it, and the gateway appends a write-ahead
   record of the authorization to the receipt log before anything runs. If
   that write fails the call is refused (503, nothing charged).
3. Default mode: the tool runs, then the payment settles. Buyers pay only for
   successful calls. With `settleBeforeExecute: true` the payment settles
   first and the tool runs only once it is final; use it for tools with side
   effects or that buy from other paid tools. A tool that fails after
   settlement is not refunded (the receipt notes it).
4. Settlement outcomes:
   - settled: the result, with `_meta.cascet.paymentId` and the
     `X-CASCET-PAYMENT-ID` / `PAYMENT-RESPONSE` headers;
   - failed: HTTP 402, JSON-RPC `-32002`, no tool result;
   - unknown (facilitator timeout, broken connection, 5xx without verdict,
     casper-x402 losing track of a submitted transfer, or a failure answer
     that carries a transaction hash): JSON-RPC `-32003`, receipt status
     `unknown`. Do not pay again for that call; reconcile the receipt
     on-chain.

A priced tool without a matching payment route, or a verified payment whose
amount, payee, asset or network differs from the configuration, is refused
(fail closed). Every 402 carries the `PAYMENT-REQUIRED` header and the decoded
challenge in `error.data`.

## Settlement preemption

Anyone can submit a signed authorization. If someone else executes it before
the gateway's facilitator does, the facilitator's settle fails although the
seller was paid. When `settlement.nodeUrl` (or `anchoring.nodeUrl`) is set,
the gateway then reads the token's events and looks for
`AuthorizationUsed(payer, nonce)` directly followed by
`Transfer(payer → payTo, price)`. A used nonce alone is never taken as
payment: the payer can cancel it or spend it on another authorization.

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
- `GET /receipts`, `GET /pricing`, `GET /.well-known/x402.json`.
- Receipts are appended to `.cascet/<name>.receipts.jsonl`; status is
  `settled`, `failed` or `unknown`, with the verified payer and the
  authorization nonce. The same log holds the write-ahead authorization
  records (`"kind": "authorization"`). If a receipt cannot be written after
  the payment settled, the buyer still gets the result and the receipt is
  kept in memory (`GET /receipts`); the error is logged.
