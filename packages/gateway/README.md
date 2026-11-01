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

## Payment flow

1. A `tools/call` for a priced tool without `PAYMENT-SIGNATURE` gets HTTP 402
   with the x402 `PAYMENT-REQUIRED` header and a JSON-RPC error body
   (`code: -32002`, `data`: the decoded PaymentRequired object).
2. With a payment, the gateway first checks the authorization locally: payee,
   exact price, validity window, and that this `(payer, nonce)` was never
   presented before (replays are refused before the facilitator is asked,
   also across restarts). Then the facilitator verifies it.
3. Default mode: the tool runs, then the payment settles. Buyers pay only for
   successful calls. With `settleBeforeExecute: true` the payment settles
   first and the tool runs only once it is final; use it for tools with side
   effects or that buy from other paid tools. A tool that fails after
   settlement is not refunded (the receipt notes it).
4. Settlement outcomes:
   - settled: the result, with `_meta.cascet.paymentId` and the
     `X-CASCET-PAYMENT-ID` / `PAYMENT-RESPONSE` headers;
   - failed: HTTP 402, JSON-RPC `-32002`, no tool result;
   - unknown (facilitator timeout, broken connection, 5xx without verdict):
     JSON-RPC `-32003`, receipt status `unknown`. Do not pay again for that
     call; reconcile the receipt on-chain.

A priced tool without a matching payment route, or a verified payment whose
amount, payee, asset or network differs from the configuration, is refused
(fail closed).

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
- Nonce canceled or used by another authorization: failed.

## Operations

- `GET /health`: `ok`, `degraded` (anchoring paused) or `unavailable` (HTTP 503
  while the upstream is down). Includes upstream state, tool counts and
  anchoring circuit state.
- The upstream is supervised: when it exits the gateway answers 503 (no 402
  challenges for calls that cannot run), reports `server-offline`, and
  reconnects with backoff. If it cannot, `startGateway`'s `onFatal` runs
  (default: close and set exit code 1 so a supervisor restarts the process).
- Browser requests carrying an `Origin` that is not allowlisted get HTTP 403.
- `GET /receipts`, `GET /pricing`, `GET /.well-known/x402.json`.
- Receipts are appended to `.cascet/<name>.receipts.jsonl`; status is
  `settled`, `failed` or `unknown`, with the authorization nonce.
