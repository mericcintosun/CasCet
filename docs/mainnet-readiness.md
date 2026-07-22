# CasCet — Mainnet Readiness & Security Checklist

Casper **mainnet handles real money**, so this is the gate before deploying. It
records the pre-mainnet security audit (2026-07-22), the fixes applied, and the
operational steps that are **config/ops, not code** — do them at deploy time.

## 1. Audit result (what was found + fixed)

A full adversarial audit covered the Odra contracts, the off-chain x402 payment
path, key hygiene, and the dashboard. Fixes landed in code:

| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| O1 | CRITICAL | Self-hosted facilitator `/settle` was open + unbounded → anyone could flood valid self-signed authorizations and burn the fee-sponsor's CSPR (gas is spent even on reverted deploys). | `real-facilitator.ts`: binds `127.0.0.1` by default, optional bearer-token auth, **payTo + asset allowlists** (reject before any deploy → no gas spent), per-minute rate limit, daily sponsored-gas cap. All demos now pass an allowlist. |
| O2 | HIGH | Paying client signed whatever `payTo`/`asset` a (discovered / MITM'd) server dictated; budget was asset-blind. | `paying-fetch.ts`: `allowedPayTo` / `allowedAssets` allowlists + **per-asset** budget. `cascet connect` refuses `http://` to non-local hosts and forwards `CASCET_ALLOWED_PAYTO/ASSETS`. |
| C1 | HIGH | PaymentChannel voucher (`channel_id‖cumulative`) had no domain separation → a testnet voucher could replay on the mainnet channel 0 (real-fund theft). | `payment_channel.rs`: voucher = `DOMAIN ‖ contract package hash ‖ channel_id ‖ cumulative`, binding it to one deployment. |
| C2 | MEDIUM | CascadeController `charge()` moved tokens before persisting `spent` (interaction-before-effect). | Reordered to checks-effects-interactions (state committed before transfers). |
| C4 | MEDIUM | Channel `expiration = block_time + duration_ms` could `u64`-overflow into the past; zero/dust durations. | `checked_add` + `MIN_CHANNEL_DURATION_MS`. |
| C6 | LOW | ReceiptRegistry had no ownership transfer → lost key freezes recorder mgmt. | Added `transfer_ownership`. |
| D1 | HIGH | `/api/ingest` was unauthenticated → anyone could poison the displayed economy and crash every viewer via `BigInt("x")`. | Bearer-token auth (loopback allowed in dev), strict receipt validation in `isCascetEvent` (`amountRaw` must match `^\d+$`), and safe `toBigIntSafe` on the client. |
| D2 | MEDIUM | `/api/revenue/submit` relayed any client tx. | Validates entry point is `release` and the tx targets the RevenueSplit package before broadcasting. |
| O5 | MEDIUM | `usdPriceToTokenUnits` used float math (precision loss / round-to-0 for high-decimal tokens). | Exact BigInt/decimal math; throws on a 0 result. |

**Clean / by-design:** no command injection or SSRF (stdio spawn is `shell:false`, all URLs come from local config); no server-held signing key in the dashboard (wallet signs, server relays); DemoToken & Cep18X402 have **no mint** (fixed supply); `init` is once-only; U256 panics on overflow. Verified: **13/13 contract tests, full typecheck + build, dashboard 12/12, real settlement regression pass.**

## 2. Key hygiene — split the "super-key" (DO before mainnet)

On testnet ONE key (the deployer) is the contract owner, the token treasury, the
facilitator fee-sponsor, AND the anchoring recorder. On mainnet that is a single
point of total loss. Use **separate, fresh mainnet keys** (never reuse a testnet
key), each least-privileged:

- **Deploy / owner key** — installs contracts, owns ReceiptRegistry. Keep cold; after deploy it's only needed for upgrades / `authorize` / `transfer_ownership`.
- **Token treasury key** — holds the payment-token supply, distributes to agents. Cold.
- **Facilitator fee-sponsor key** — HOT (signs every settle). Fund it with a **limited float only** (e.g. a day's expected gas), so a compromise or drain caps the loss. Top up as needed.
- **Anchoring recorder key** — HOT; `authorize` it on the registry. Rotatable via `transfer_ownership` / `revoke`.

None of these are committed (`.gitignore` covers `*.pem` + `keys/` — verified).

## 3. Facilitator operations (mainnet)

The self-hosted facilitator is the only working settlement path (the hosted
`x402-facilitator.cspr.cloud` reverts every settle — arg `value` vs `amount`).
When running it against mainnet:

- Set `authToken` (shared secret) and pair it with each gateway's `facilitator.apiKey`.
- Set `allowedPayTo` (your seller account-hashes) and `allowedAssets` (your CEP-18 package(s)).
- Keep it bound to `127.0.0.1` when co-located with the gateway; if it must be public, front it with TLS + the auth token and keep the rate limit + daily gas cap.
- Point `rpcUrl` at the mainnet node and `network: "casper:casper"`.

## 4. Dashboard / config (mainnet)

- Set **`CASCET_INGEST_TOKEN`** on the deployed dashboard AND on any gateway that pushes to it (the gateway forwards it automatically). Without it, public `/ingest` is closed (loopback-only).
- Client: set `CASCET_ALLOWED_PAYTO` + `CASCET_ALLOWED_ASSETS`; use `https://` gateway URLs.
- Redeploy the **fixed** contracts to mainnet — the testnet deployments predate these fixes.

## 5. Residual / accepted risk (documented, not blocking)

- **CascadeController operator is trusted up to the whole budget** (F7) and the owner can `close()` and reclaim unspent budget at any time (C3/F3). Mitigation: charge hops synchronously within the call that renders them (the gateway already does), and keep cascades short-lived. Document this in the trust model; a future settlement-window/expiry hardens it further.
- **O3** (no off-chain nonce/idempotency → a replayed authorization burns sponsor gas; a retried call can double-charge) and **O4** (upstream runs before settle → a zero-balance authorization gets free upstream execution; a 60s settle timeout can charge-but-record-failed). Mitigations: facilitator nonce cache + a gateway idempotency key; a balance pre-check before running upstream; treat settle timeouts as indeterminate. Low-to-medium; batch these before high-volume production.
- **D3** (add per-IP rate limiting / body caps on the dashboard) and **D4** (return generic error messages, log details server-side). Low.
- **C5** revenue-split floor-division dust (≤ payee_count base units) is stranded — negligible at 9 decimals.

## 6. Cost (see also the cost analysis)

At CSPR ≈ $0.0015, a mainnet deploy of the contracts + token is ~$3–8, and each
real settle is ~2.7–7 CSPR (~$0.004–0.011) — tunable down via the facilitator's
gas limit, and near-zero if Casper 2.0 fee-elimination is active. A minimal
"live settle on mainnet" proof is ~$1 (practical exchange-minimum buy ~$5–10).
