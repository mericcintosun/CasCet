# CasCet — Mainnet Readiness & Security Checklist

Casper **mainnet handles real money**. This page records where CasCet's security
review stands, what the code enforces, how the mainnet keys are set up today
(and how to split them), and what to do when a key leaks. Steps marked
*ops* are configuration and on-chain actions, not code.

## 1. Security review status

**Internal multi-agent review on 2026-10-20; no external audit yet.** Nothing in
this repository has been audited by a third party. Do not describe CasCet as
"audited" until an external report exists.

An earlier internal pre-mainnet pass (2026-07-22) covered the Odra contracts, the
off-chain x402 payment path, key hygiene, and the dashboard. Its fixes landed in
code:

| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| O1 | CRITICAL | Self-hosted facilitator `/settle` was open + unbounded → anyone could flood valid self-signed authorizations and burn the fee-sponsor's CSPR (gas is spent even on reverted deploys). | `real-facilitator.ts`: binds `127.0.0.1` by default, bearer-token auth, **payTo + asset allowlists** (reject before any deploy → no gas spent), rate limits, daily sponsored-gas cap. All demos pass an allowlist. Hardened further in §3. |
| O2 | HIGH | Paying client signed whatever `payTo`/`asset` a (discovered / MITM'd) server dictated; budget was asset-blind. | `paying-fetch.ts`: `allowedPayTo` / `allowedAssets` allowlists + **per-asset** budget. `cascet connect` refuses `http://` to non-local hosts and forwards `CASCET_ALLOWED_PAYTO/ASSETS`. |
| C1 | HIGH | PaymentChannel voucher (`channel_id‖cumulative`) had no domain separation → a testnet voucher could replay on the mainnet channel 0 (real-fund theft). | `payment_channel.rs`: voucher = `DOMAIN ‖ contract package hash ‖ channel_id ‖ cumulative`, binding it to one deployment. |
| C2 | MEDIUM | CascadeController `charge()` moved tokens before persisting `spent` (interaction-before-effect). | Reordered to checks-effects-interactions (state committed before transfers). |
| C4 | MEDIUM | Channel `expiration = block_time + duration_ms` could `u64`-overflow into the past; zero/dust durations. | `checked_add` + `MIN_CHANNEL_DURATION_MS`. |
| C6 | LOW | ReceiptRegistry had no ownership transfer → lost key freezes recorder mgmt. | Added `transfer_ownership`. |
| D1 | HIGH | `/api/ingest` was unauthenticated → anyone could poison the displayed economy and crash every viewer via `BigInt("x")`. | Bearer-token auth (loopback allowed in dev), strict receipt validation in `isCascetEvent` (`amountRaw` must match `^\d+$`), and safe `toBigIntSafe` on the client. |
| D2 | MEDIUM | `/api/revenue/submit` relayed any client tx. | Validates entry point is `release` and the tx targets the RevenueSplit package before broadcasting. |
| O5 | MEDIUM | `usdPriceToTokenUnits` used float math (precision loss / round-to-0 for high-decimal tokens). | Exact BigInt/decimal math; throws on a 0 result. |

As of that pass: no command injection or SSRF (stdio spawn is `shell:false`, all
URLs come from local config); no server-held signing key in the dashboard (wallet
signs, server relays); DemoToken & Cep18X402 have **no mint** (fixed supply);
`init` is once-only; U256 panics on overflow.

## 2. Keys — mainnet runs on ONE key today

The plan below was written before the mainnet launch: separate keys per role.
**It was not followed.** As of 2026-11-01 one hot key does everything on
mainnet (checked read-only against the mainnet RPC):

- Key: public key `01c3a787f115de28a0fff3a37d02d345f12f7c74a85408559052c4d36379242826`,
  account hash `b9a38c827771d6bc510dd5f1e24fee61acdd4f97f758f4d68fe1dea13a7a140d`.
- It **deployed all six mainnet packages** and holds their access tokens in its named
  keys. Five are locked; the **x402 token package (`8dd4f1aa…`) is unlocked**, so this
  key can upgrade the token contract that holds every payer's balance.
- It **owns ReceiptRegistry** (`f86bef35…`) and is an authorized recorder (the
  registry's `init` made the deployer both).
- It is the self-hosted facilitator's **fee payer** (it signed mainnet settles
  `2c66141c…` and `754224da…`).
- It is the demo gateway's **seller**: payments go to `payTo = 00b9a38c…`.
- The account has one associated key and thresholds of 1 (deployment and key
  management), so this single key alone can do all of the above.

One leak therefore means: fee-payer float drained, revenue redirected, fake
receipts anchored, and the payment token upgradable by the attacker.

What the code now does about it: the facilitator **refuses to start on
`casper:casper` when its fee-payer key is an owner account or one of the seller
accounts** it settles to (`CASCET_SELLER_ACCOUNT_HASH`). The owners are
`CASCET_OWNER_ACCOUNT_HASH` (a comma list, for example a new ReceiptRegistry
owner) **plus, always, the deployer above**, because it keeps the token package's
upgrade access whoever owns the registry. At mainnet start-up the facilitator
also reads the owner and seller accounts on-chain and refuses a fee-payer key
that is one of their **associated keys** (a hot key that can sign for them), or
any start-up where those accounts cannot be read. Mainnet settlement therefore
stays offline until a dedicated fee-payer key exists. The mainnet demo takes each
role's key from its own environment variable and never loads the deployer key; it
refuses an anchoring recorder (`CASCET_RECORDER_KEY`, the gateway's
`anchoring.keyPath`) that is the fee payer, an owner or a seller, compared by
account rather than by file, or an associated key of an owner or seller account.

### Role split plan (*ops*)

| Role | Key | Hot / cold | Holds |
|------|-----|------------|-------|
| Owner / deployer | existing deployer key | **cold, offline**; multi-key | contract ownership, token upgrade access |
| Seller / treasury | new | cold | revenue (`payTo`) and the token supply |
| Fee payer | new | hot | a **limited CSPR float** (about one day of gas) |
| Recorder | new | hot | nothing; `authorize`d on ReceiptRegistry |
| Facilitator token | `openssl rand -hex 32` | secret | shared by the facilitator and each gateway's `facilitator.apiKey` |

Generate the new keys offline and get the exact remaining steps printed:

```bash
pnpm --filter @cascet/e2e key-roles -- --out ~/cascet-keys/mainnet   # nothing is sent
```

The planner writes fresh ed25519 keys for the fee payer, recorder and seller
(secret keys mode 600, never printed, never overwritten) and prints, as text
only: fund the fee payer with a small float; `authorize` the new recorder on
ReceiptRegistry and `revoke` the old one; point `payTo` at the seller; move
registry ownership (`transfer_ownership`, then `revoke` the previous owner, which
stays a recorder) and/or add associated keys with higher action thresholds to the
deployer account, which also protects the unlocked token package. **Those
associated keys must be new keys kept offline, never the fee-payer, recorder or
seller keys**: a leak of such a hot key would then help sign for the owner
account, and comparing account hashes cannot see it. After moving registry
ownership, add the new owner to `CASCET_OWNER_ACCOUNT_HASH`. **Rehearse every step
on testnet first.** Never reuse a testnet key on mainnet. None of these keys are
committed (`.gitignore` covers `*.pem` + `keys/`).

## 3. Facilitator operations (mainnet)

The self-hosted facilitator is CasCet's settlement path: the hosted
`x402-facilitator.cspr.cloud` now sends the CEP-3009 arg `value`, while our x402
token (the earlier reference build) expects `amount`. It settles both styles side
by side: at start-up it reads every allowlisted token's ABI, `chain_name` and
`name` on-chain, refuses to start when they contradict the configuration, and pins
the style (`amount` or `value`), name and gas limit of each token.

```bash
CASCET_NETWORK=casper:casper \
CASCET_FACILITATOR_KEY=/secure/fee-payer_secret_key.pem \
CASCET_FACILITATOR_TOKEN=<64 hex chars> \
CASCET_SELLER_ACCOUNT_HASH=00<seller account hash> \
pnpm --filter @cascet/e2e facilitator
```

| Variable | Default | Notes |
|----------|---------|-------|
| `CASCET_NETWORK` (or legacy `CASCET_NET=mainnet`) | `casper:casper-test` | one network per facilitator |
| `CASCET_FACILITATOR_KEY` | testnet: deployer key | **required on mainnet**; the fee payer |
| `CASCET_FACILITATOR_KEY_ALGO` | `ed25519` | or `secp256k1` |
| `CASCET_FACILITATOR_TOKEN` | none | **required on mainnet**, at least 32 characters; accepted as `Authorization: <token>` or `Bearer <token>` |
| `CASCET_SELLER_ACCOUNT_HASH` | mainnet: deployer account | comma list of `payTo` accounts it settles to |
| `CASCET_OWNER_ACCOUNT_HASH` | none (mainnet: the deployer is always added) | comma list of owner accounts; the fee payer must be none of them, nor an associated key of an owner or seller account |
| `CASCET_ALLOWED_ASSETS` | the CasCet x402 token | comma list of package hashes; each is settled in the style its on-chain ABI shows |
| `CASCET_ASSET_STYLES` | none | optional `<package hash>=<legacy-amount\|cep3009-value>` list; the chain must agree (start-up and every payment) |
| `CASCET_ASSET_NAMES` | the names CasCet knows, else the on-chain name | optional `<package hash>=<EIP-712 name>` list of pinned domain names |
| `CASCET_SETTLE_PAYMENT_MOTES` | per style: `4000000000` (4 CSPR) for `amount` tokens, `3500000000` (3.5 CSPR) for `value` tokens | gas limit per settle of every asset without its own; at least 3 CSPR (`amount`) or 1.5 CSPR (`value`), at most 100 CSPR |
| `CASCET_SETTLE_PAYMENT_MOTES_BY_ASSET` | none | optional `<package hash>=<motes>` list of per-asset gas limits |
| `CASCET_DAILY_GAS_CAP_MOTES` | `500000000000` (500 CSPR) | sponsored gas per UTC day |
| `CASCET_SETTLE_WAIT_MS` | `60000` | how long `/settle` waits for execution before answering "pending"; keep it below the gateway's `timeouts.settleMs` (90 s) |
| `CASCET_PREFLIGHT` | `on` | on-chain ABI / nonce / balance / token-name checks; **required on mainnet**; `off` elsewhere needs every token's style and name pinned (`CASCET_ASSET_STYLES`, `CASCET_TOKEN_NAME` / `CASCET_ASSET_NAMES`; CasCet's token and testnet Wrapped CSPR are known) |
| `CASCET_PREFLIGHT_DEADLINE_MS` | `10000` | total time one request's preflight may take, retries included; keep it below the gateway's verify timeout (`timeouts.facilitatorMs`, 15 s) |
| `CASCET_TOKEN_VERSION` | `1` | pinned EIP-712 domain version |
| `CASCET_TOKEN_NAME` | `CasCet X402 Token` when only the CasCet token is allowlisted | pinned EIP-712 domain name of the single allowlisted asset, checked without RPC (and against the on-chain name when the preflight is on); with several assets use `CASCET_ASSET_NAMES` |
| `CASCET_RPC_URL` | the network's public endpoint, which is load-balanced (mainnet warns) | use **one** node you run or trust, so balance reads already include the settlements this facilitator observed; a lagging backend can overstate a balance right after a settle, and the next settle then reverts |
| `CASCET_FACILITATOR_HOST` / `PORT` | `127.0.0.1` / `4501` | a non-loopback host requires the token |

What it enforces:

- **Auth**: constant-time comparison of the shared token; required on mainnet and
  on any non-loopback bind. Keep it bound to `127.0.0.1` next to the gateway; if it
  must be public, front it with TLS.
- **Rate limits** (express-rate-limit): per client IP before authentication, then
  across all callers, per payer, and for settles.
- **Allowlists** (required on mainnet): only the configured sellers and tokens;
  payees and payers must be account-hash Keys (`00…`). Contract-package payees
  (`hash-…`, `01…`) are refused: this facilitator, like casper-x402 1.0.0, settles
  to account keys only, and paying a contract has not been rehearsed on testnet.
- **Settle window**: an authorization must stay valid for at least 20 s at
  `/verify` and at `/settle` (casper-x402 alone accepts 6 s, less than one 8 s
  block), checked again after the on-chain preflight, right before submission.
  The settlement transaction's TTL ends 2 s before `validBefore`, so a transfer
  that is not included in time is dropped by the node instead of executing after
  `validBefore`, reverting, and burning the gas limit.
- **Duplicate protection**: every authorization (network, asset, payer, nonce) is
  held in an in-flight ledger until it can no longer execute; a duplicate is
  refused with `duplicate_nonce` (a retried settle is pointed at the earlier
  transaction hash). A settle of the exact same payment after an answer of
  `settlement_pending` / `settlement_unknown` (x402 resource servers retry
  `settlement_pending` once) follows the earlier transaction and answers its
  outcome; nothing is ever submitted twice.
- **Authorization styles**: every request reads the token's ABI again (cached for
  5 minutes) and refuses the payment (`authorization_style_mismatch`) when it no
  longer matches the style pinned at start-up, for example after an upgrade of
  the token; the requirements' `extra.authorizationStyle` is never trusted.
- **HTTP statuses**: every verdict about a payment (allowlists, duplicates, used
  nonces, domain, style, funds) answers HTTP 200 with `isValid: false` /
  `success: false`; 503 means retry later (token state unreadable, ledger full,
  daily gas cap reached, shutting down).
- **On-chain preflight** (required on mainnet), at `/verify` and again at
  `/settle`: the nonce is unused (`used_nonces` dictionary), the payer's balance
  (`balances` dictionary) covers the value plus everything already in flight, and
  the EIP-712 domain name equals the token's on-chain name (the name is also pinned,
  `CASCET_TOKEN_NAME`, and checked without RPC). One deadline bounds all reads of a
  request (`CASCET_PREFLIGHT_DEADLINE_MS`, 10 s): a read that times out or fails in
  transit is retried once if the deadline allows it; if the node still cannot be
  read, the request fails with 503 instead of guessing.
  Checked live (read-only) on 2026-11-01 against both networks: the nonces of
  settled transactions `04e54a95…` (testnet) and `2c66141c…` (mainnet) read as
  used, fresh nonces as unused, and an account without an entry reads as balance 0.
- **Gas cap** per UTC day, reserved only right before submission, given back when
  nothing was submitted, and counted with the real on-chain cost (cost − refund)
  when known.
- **No false failures**: when RPC errors or a slow node hide the outcome, `/settle`
  keeps polling with backoff for up to `CASCET_SETTLE_WAIT_MS` and then answers
  `settlement_pending` / `settlement_unknown` **with the transaction hash**
  (`extra.settlementStatus`), never a failure with an empty hash. Reconcile such
  payments by hash (`info_get_transaction`) before treating them as failed. Blocks
  come every 8 s and recorded settles were included 4–10 s after submission, so the
  60 s default answers almost every settle with a final result.
- **Settle statuses** (`extra.settlementStatus`): `not_submitted` means this
  request submitted nothing and the facilitator holds no transaction for the
  authorization. `duplicate_nonce` and `nonce_already_used` answer
  `duplicate`: nothing was submitted for this request, but an earlier transaction
  (its hash is included when this facilitator sent it) may have charged the payer.
  An internal error on `/settle` answers `settlement_unknown` / `unknown`, never
  `not_submitted`. `success` and `failed` are final; `pending` and `unknown` need
  reconciling.
- **Shutdown**: on SIGINT or SIGTERM the facilitator stops accepting work (new
  requests get 503), lets running `/verify` and `/settle` requests finish and
  answer, and then exits; it waits at most `CASCET_SETTLE_WAIT_MS` + the preflight
  deadline + two RPC timeouts (about 86 s by default). A second signal exits at
  once. Give the process manager about 90 s to stop it.

**Gas limit.** Measured consumption of a settle is 2.68 CSPR on mainnet (tx
`2c66141c…`) and 2.71 CSPR on testnet (tx `04e54a95…`). Mainnet refunds 75 % of the
unused limit and burns the rest, so a settle costs about **3.0 CSPR at the 4 CSPR
default** versus 3.76 CSPR at the old 7 CSPR limit. A limit of 5 CSPR or less also
puts settles in wasm lane 5 (40 transactions per block) instead of lane 4 (2 per
block). Never set the limit below the measured consumption: a settle that runs out
of gas reverts and **burns the whole limit**. The facilitator refuses limits below
3 CSPR for `amount` tokens. CEP-3009 (`value`) tokens such as Wrapped CSPR default
to 3.5 CSPR until CasCet's own settles are measured on testnet (the hosted
facilitator's Wrapped CSPR settle consumed 1.13 CSPR), and are refused below
1.5 CSPR; every asset can have its own limit
(`CASCET_SETTLE_PAYMENT_MOTES_BY_ASSET`), and the daily cap counts each settle at
its own asset's limit.

## 4. Key compromise runbook (*ops*)

The owner-key holder (the project maintainer) runs this. Act in this order:
contain, then rotate, then review what was signed. The ReceiptRegistry is
`hash-f86bef35062e92d06b8171cf4131fdf557463589aca9112a348e5eb24159eb93`; its
`authorize`, `revoke` and `transfer_ownership` entry points take one `Key` argument
(`account-hash-…`) and must be signed by the current owner.

- **Fee payer leaked**
  1. Stop the facilitator.
  2. Drain the float: a native CSPR transfer of the remaining balance from the
     fee-payer account to the treasury, signed with the fee-payer key (the attacker
     can race you; the float is kept small for exactly this reason).
  3. Generate a new fee-payer key (`key-roles`), fund a new float, set
     `CASCET_FACILITATOR_KEY`. Rotate `CASCET_FACILITATOR_TOKEN` too (same host) and
     update every gateway's `facilitator.apiKey`. Restart.
- **Recorder leaked**
  1. Owner calls `revoke(<old recorder>)` on ReceiptRegistry.
  2. Generate a new recorder key, owner calls `authorize(<new recorder>)`, point the
     gateway's `anchoring.keyPath` at it.
  3. Anchored receipts cannot be deleted: list the receipts anchored in the exposure
     window and mark them as untrusted wherever they are displayed.
- **Seller leaked**: move the token balance to a new seller account (CEP-18
  transfer), switch `payTo` and `CASCET_SELLER_ACCOUNT_HASH`, restart.
- **Facilitator token leaked**: rotate it on the facilitator and every gateway. The
  allowlists, rate limits and gas cap bound what a token holder can do meanwhile.
- **Owner / deployer key leaked** (today: all of the above at once)
  1. Stop the facilitator and the gateways.
  2. Owner calls `transfer_ownership(<fresh cold key>)` on ReceiptRegistry; the new
     owner then calls `revoke(<old owner>)`, because the previous owner stays a
     recorder.
  3. If associated keys were added in advance, use them to remove the leaked key from
     the deployer account.
  4. The x402 token package is unlocked and upgradable by this key: announce the
     incident, remove the token from every allowlist (`CASCET_ALLOWED_ASSETS`, gateway
     `asset`, client `CASCET_ALLOWED_ASSETS`) and migrate to a fresh token (the
     CEP-3009 `value` migration / official Wrapped CSPR on the roadmap).
  5. Move any CSPR and tokens held by the deployer account to a fresh account.

## 5. Dashboard / config (mainnet)

- Set **`CASCET_INGEST_TOKEN`** on the deployed dashboard AND on any gateway that pushes to it (the gateway forwards it automatically). Without it, public `/ingest` is closed (loopback-only).
- Client: set `CASCET_ALLOWED_PAYTO` + `CASCET_ALLOWED_ASSETS`; use `https://` gateway URLs.

## 6. Residual / accepted risk (documented, not blocking)

- **CascadeController operator is trusted up to the whole budget** (F7) and the owner can `close()` and reclaim unspent budget at any time (C3/F3). Mitigation: charge hops synchronously within the call that renders them (the gateway already does), and keep cascades short-lived. Document this in the trust model; a future settlement-window/expiry hardens it further.
- **O3 / O4 — execute-before-settle.** The facilitator side is now covered (duplicate
  ledger with 409, on-chain nonce and balance preflight at `/verify` and `/settle`,
  pending/unknown results with the hash). What remains is inherent to running the
  tool before settling: a payer can still move their balance or use the nonce from
  their own key between `/verify` and `/settle`; the gateway's settle-before-execute
  option closes that for side-effectful tools.
- **The in-flight ledger is in memory and per process.** A restart forgets
  unsettled entries; the on-chain preflight still rejects nonces that were used.
  Run one facilitator per fee-payer key.
- **Pending settles are not reconciled by the facilitator.** When `/settle` answers
  `settlement_pending` or `settlement_unknown`, the gas cap keeps the full limit
  and the payer's value stays counted as in flight until the transaction can no
  longer execute: the end of its TTL, which is never later than `validBefore`
  (plus a 60 s grace). Payers with a tight balance may see `insufficient_funds`
  during that time. The gateway records such receipts as unknown; reconcile them
  by transaction hash (`info_get_transaction`) or by the authorization nonce
  (`used_nonces`).
- **Verified hold.** A successful `/verify` keeps the payer's value counted as in
  flight for up to 180 s (less if `validBefore` comes first), so a concurrent
  replay cannot pass. If the gateway never settles (an upstream failure, its own
  timeout), the hold simply expires; until then a buyer with a tight balance who
  retries with a new authorization may get `insufficient_funds`. The preflight
  deadline keeps `/verify` within the gateway's timeout, so the gateway rarely gives
  up on a verify that then succeeds.
- **Balance reads on a load-balanced endpoint can lag.** Right after a settle, a
  lagging backend can still show the old balance, so a second payment from a tight
  balance may pass the preflight and revert on-chain. Set `CASCET_RPC_URL` to a
  single node (mainnet warns when it is not set).
- **Preflight depends on the token layout**: CEP-18 `balances` and CEP-3009
  `used_nonces` named dictionaries (verified for the CasCet token on testnet and
  mainnet, and for testnet Wrapped CSPR). The facilitator refuses to start with a
  token that lacks them or whose `transfer_with_authorization` takes neither
  `amount` nor `value`. The preflight cannot be turned off on mainnet; on testnet
  `CASCET_PREFLIGHT=off` (with every token's style and name pinned) leaves only
  the in-memory ledger and the pins.
- **Settlement builder**: the transaction is now built with casper-js-sdk 5.3.0
  instead of casper-x402 1.0.0's internal copy, in the token's style; offline,
  its payload hash matches settled testnet tx `04e54a95…` (`amount`) and the
  hosted facilitator's testnet tx `9fe35eed…` (`value`) byte for byte, and the
  signature check uses @x402/casper's EIP-712 digest. Rehearse one testnet settle
  before the next mainnet one, and a few testnet Wrapped CSPR settles (none has
  been run by CasCet yet) to measure the `value` style's gas before lowering its
  3.5 CSPR default.
- **D3** (add per-IP rate limiting / body caps on the dashboard) and **D4** (return generic error messages, log details server-side). Low.
- **C5** revenue-split floor-division dust (≤ payee_count base units) is stranded — negligible at 9 decimals.

## 7. Cost

Mainnet currently charges gas (`fee_handling = burn`, 75 % of the unused limit
refunded; there is no fee elimination). A settle costs about 3.0 CSPR at the
default 4 CSPR limit (2.68 CSPR consumed plus 25 % of the unused 1.32 CSPR). At
CSPR ≈ $0.0015 (July 2026) a mainnet deploy of the contracts + token was ~$3–8 and a
settle is well under one cent.
