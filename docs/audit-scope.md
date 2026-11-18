# CasCet smart contract audit: scope and specification

This document is for the auditors. It covers what is in scope, how the
contracts are meant to behave, who can do what, and where we would like you to
look hardest. It follows Safe Edges' audit-readiness guide for Casper Forward
teams.

Contact: Meriç Cintosun (solo builder), on Telegram.

**Status (2026-11-18): no audit is scheduled.** This document stays as the
specification for a future audit. Until one happens, mainnet opens on the x402
payment path only, and `RevenueSplit`, `CascadeController` and `PaymentChannel`
stay out of production.

## 1. What CasCet is, in one paragraph

CasCet is a paywall for MCP (Model Context Protocol) servers on Casper. A tool
owner wraps an MCP server with the CasCet gateway and sets a price per tool
call. An AI agent pays each call over x402: it signs a CEP-18
`transfer_with_authorization`, and a facilitator submits it on-chain. The
contracts in this scope sit beside that payment path. They anchor receipts,
split seller revenue, cap a whole tree of calls with one budget, and offer
prepaid channels for high-frequency traffic.

## 2. Code, build and tests

| Item | Value |
| --- | --- |
| Repository | https://github.com/mericcintosun/CasCet (public, Apache-2.0) |
| Frozen commit | the `main` commit named in our intake message |
| Directory | `contracts/` |
| Framework | Odra 2.9.1 (`odra`, `odra-modules`), casper-types 6.1.0 |
| Toolchain | `nightly-2026-01-01`, pinned in `contracts/rust-toolchain.toml` |
| Release profile | `overflow-checks = true`, `lto = true`, `codegen-units = 1` |

From a clean checkout:

```bash
cd contracts
cargo test          # 54 tests on the Odra mock VM (49 for in-scope contracts)
cargo odra build    # wasm, needs cargo-odra 0.1.7
```

CI runs `cargo fmt --check`, `cargo clippy`, `cargo test` and `cargo audit` on
every change (`.github/workflows/ci.yml`, job "Contracts").

## 3. Scope

Line counts exclude blank lines, comment lines and the `#[cfg(test)]` modules.

| File | Contract | Lines |
| --- | --- | --- |
| `contracts/src/receipt_registry.rs` | ReceiptRegistry | 209 |
| `contracts/src/cascade_controller.rs` | CascadeController | 214 |
| `contracts/src/payment_channel.rs` | PaymentChannel | 199 |
| `contracts/src/revenue_split.rs` | RevenueSplit | 117 |
| `contracts/src/math.rs` | shared `mul_div_floor` | 6 |
| **Total** | | **745** |

**Out of scope:**
- `contracts/src/demo_token.rs`, a CEP-18 used only in demos.
- `contracts/src/test_util.rs`, test helpers.
- `contracts/bin/`, the deploy and scenario CLI.
- `contracts/external/Cep18X402.wasm`, the x402 payment token, which is third-party code.
- The official Wrapped CSPR token.
- All off-chain code (TypeScript gateway, client, facilitator, dashboard). We would like a separate quote for an agent and off-chain review of the payment path.

## 4. Contracts

Every contract has no admin beyond what is listed here, no upgrade logic of its
own, and holds no CSPR (only CEP-18 tokens).

### 4.1 ReceiptRegistry

**Purpose.** It keeps a public, append-only log of paid tool calls. After a gateway
settles a payment, it records `payment_id`, `parent_id`, payer, payee, amount,
server, tool and the settlement `tx_hash`. Cascades can be rebuilt from the
`parent_id` links.

**Funds.** None. This contract never holds or moves tokens.

**Roles.**
- Owner: set at `init` to the deployer. Can `authorize` and `revoke` recorders. Ownership moves in two steps: `transfer_ownership` proposes, and `accept_ownership` completes it, after which the old owner loses its recorder right.
- Recorder: can call `record`. The owner is a recorder from `init`.
- Anyone: can read.

**Rules that must always hold.**
1. Only a recorder can add a receipt.
2. A `payment_id` is recorded at most once and never changes or disappears.
3. `payment_id` is never empty, and never equal to its own `parent_id`.
4. `count` and `total_volume` never overflow; they saturate, so `record` can never become impossible.
5. Only the pending owner can complete an ownership transfer.

**By design.**
- A receipt is what a recorder asserted. The contract does not check the `tx_hash` or the amounts.
- `parent_id` may point to a receipt that is not anchored yet, because children settle before parents. Longer cycles (A→B→A) are possible; readers must stop at a repeat.

### 4.2 RevenueSplit

**Purpose.** It splits the revenue of one paid server among fixed payees. A gateway
sets its x402 `payTo` to this contract; payees pull their share. The accounting
follows OpenZeppelin's PaymentSplitter.

**Fund flow.**
- Tokens arrive by plain CEP-18 transfers into the contract.
- `release(account)` sends `account` its share: `floor(total_received × shares / total_shares) − already released`.
- `total_received` is the contract's current token balance plus everything already released.

**Roles.**
- No owner, no admin.
- Token, payees and shares are fixed at `init` and can never change.
- Anyone can call `release`, but funds only go to the named payee.

**Rules that must always hold.**
1. A payee is never paid more than its share of everything received.
2. The sum of all releases never exceeds what the contract received.
3. `init` rejects: no payees, length mismatch, zero shares, duplicate payees, and shares whose total overflows `u32`.
4. `releasable` cannot overflow (it uses `mul_div_floor`).

**Known.** Rounding dust of at most `payee_count` base units stays in the contract (C5 in `docs/mainnet-readiness.md`).

### 4.3 CascadeController

**Purpose.** One deposit caps a whole tree of paid calls. An owner opens a cascade
with a budget. An operator (the gateway) charges hops against it. A hop can name
a parent hop, and a share of its payment (`attribution_bps`) then goes up to the
parent hop's payee.

**Fund flow.**
1. `open(operator, token, budget)`: the owner has approved the contract; `transfer_from` pulls `budget`.
2. `charge(cascade_id, parent, payee, gross, attribution_bps)`: operator only. It pays `gross` out of the cascade budget: `floor(gross × bps / 10000)` to the parent hop's payee, the rest to `payee`. State is written before any transfer.
3. `close(cascade_id)`: owner only. It marks the cascade closed and refunds `budget − spent`.

**Roles.**
- Owner (caller of `open`): can close.
- Operator: can charge, choosing the payee, amount and attribution.
- No global admin.

**Rules that must always hold.**
1. `spent ≤ budget` for every cascade, at all times.
2. The total paid out by a cascade (hops plus refund) equals at most its budget. One cascade can never spend another cascade's tokens.
3. A closed cascade can never be charged or closed again.
4. `attribution_bps ≤ 10000`, and a hop's parent must exist in the same cascade.
5. No arithmetic traps on large values (`mul_div_floor`, remainder comparison).

**Accepted trust (F7, C3/F3 in `docs/mainnet-readiness.md`).** The operator is
trusted up to the whole budget. The owner can close at any time, including
just before a charge for work already done.

**Status.** It ran end to end on mainnet with DemoToken (open, two hops,
over-budget revert, close; transactions in `docs/onchain.md`). It is not yet
wired into the live payment flow.

### 4.4 PaymentChannel

**Purpose.** Prepaid channels for many small calls. A sender deposits once, then
signs off-chain vouchers for a growing cumulative amount. The payee redeems the
latest voucher on-chain. After expiry the sender reclaims the rest.

**Fund flow.**
1. `open(sender_public_key, payee, token, deposit, duration_ms)`: the key must match the caller, `duration_ms ≥ 1000`, and `transfer_from` pulls `deposit`.
2. `redeem(channel_id, cumulative, signature)`: anyone can call. It checks the signature over `DOMAIN ‖ contract hash ‖ channel_id ‖ cumulative`, and pays the payee `cumulative − redeemed`.
3. `close(channel_id)`: sender only, after expiry. It refunds `deposit − redeemed`.

**Rules that must always hold.**
1. `redeemed ≤ deposit`, and `redeemed` only grows.
2. Only a voucher signed by the sender's key, for this contract and this channel, can move funds.
3. A voucher for one deployment or network cannot be replayed on another.
4. The sender cannot close before expiry.
5. A closed channel can never pay again.

**By design.** Vouchers do not expire; the payee must redeem before the channel
expires, or the sender can reclaim the rest.

**Status.** Unit-tested with golden signature vectors (ed25519 and secp256k1).
It has not run on a live network yet.

## 5. Dependencies and trust boundaries

| Dependency | Used by | What we trust it for |
| --- | --- | --- |
| CEP-18 token chosen at `init` or `open` | RevenueSplit, CascadeController, PaymentChannel | standard `transfer`, `transfer_from`, `balance_of`, without fees, rebasing or callbacks |
| Gateway account | operator in CascadeController, recorder in ReceiptRegistry | charging honest hops, recording true receipts |
| Casper `verify_signature` (through Odra) | PaymentChannel | voucher signatures |
| Facilitator (off-chain) | none of these contracts | submits `transfer_with_authorization` on the payment token; out of scope here |

The payment tokens in use are CasCet's x402 token (`Cep18X402.wasm`, third party)
and the official Wrapped CSPR. DemoToken is only for demos.

## 6. Deployment status

- **Mainnet packages are installed and locked** (`docs/onchain.md`). They were installed before the October hardening, so they do not contain:
  - the two-step ownership and saturating counters in ReceiptRegistry;
  - Odra 2.9.1;
  - the `overflow-checks` profile.
- **After the audit** we will install fresh packages from the audited commit and point the gateway at them. No fix is applied to the locked packages.
- **Keys:** today one mainnet key holds every role. Splitting it into least-privilege keys comes before external sellers (`docs/mainnet-readiness.md` §2).

## 7. What worries us

Please look hardest at these:

1. **Shared token balances.**
   - CascadeController and PaymentChannel hold every cascade's and channel's tokens in one balance per token, and record the requested `budget` or `deposit`, not the amount received.
   - With a fee-on-transfer or otherwise non-standard token, one cascade or channel could pay out of another's funds.
   - Should `open` check the balance it actually received, or allowlist tokens?
2. **External call before state in `open`.** Both `open` functions call `transfer_from` before writing state. We believe a reentrant token cannot exploit this, but please check.
3. **`mul_div_floor`** in `math.rs`: its exactness and no-overflow argument, and its callers' guarantee that `numerator ≤ denominator`.
4. **Voucher format.**
   - The bytesrepr encoding of `cumulative`, and whether two different values can produce the same message bytes.
   - Whether `self_address()` is the package hash, so vouchers stay valid across an upgrade but not across deployments.
5. **The owner close race** in CascadeController (accepted today; is a settlement window worth adding?).
6. **Unbounded strings** in `ReceiptRegistry.record`. Storage cost falls on the recorder, but are there other limits we should set?

## 8. Timeline

- Target: open mainnet to outside sellers in January 2027.
- We will freeze the in-scope files from the audited commit until fixes are reviewed.
- Single contact for questions: Meriç, on Telegram.
