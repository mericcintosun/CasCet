# Changelog

Changelog for `cascet_contracts` — CasCet's Odra smart contracts on Casper.

## [Unreleased]

None of this is deployed yet. Installed packages keep the code they were
installed with. On 2026-11-01, a read-only RPC check found every mainnet
package locked (not upgradable), and every testnet package listed in
`resources/` except the demo upgradable ReceiptRegistry (`hash-764ed719…`).
A locked package picks up these changes only through a fresh install, after
which gateways and docs must point at the new hashes.

### Security
- **ReceiptRegistry: `record` can no longer be bricked (M17).** `total_volume`
  was summed with U256 `+`, which panics on overflow. A recorder could push it
  near `U256::MAX`, and every later `record` would then revert, with no way
  to patch a locked package. `count` and `total_volume` now saturate.
  `total_volume` is documented as saturating at `U256::MAX` and as an
  activity indicator: amounts are what recorders asserted, summed across tokens.
- **ReceiptRegistry: two-step ownership (L39).** This mirrors odra-modules
  `Ownable2Step`. `transfer_ownership` now only proposes a new owner, and the
  proposed account completes the transfer with `accept_ownership`. Accepting
  revokes the previous owner's recorder right and grants it to the new owner,
  so a rotated key can no longer write receipts. Added
  `cancel_ownership_transfer`, `pending_owner` and the events
  `OwnershipTransferStarted`, `OwnershipTransferred`, `RecorderAuthorized`
  and `RecorderRevoked`.
- **ReceiptRegistry: id checks (L46).** `record` rejects an empty `payment_id`
  (`EmptyPaymentId`, code 5) and a receipt that is its own parent
  (`SelfParent`, code 6). A `parent_id` that is not anchored yet is still
  accepted on purpose: a gateway settles the purchases a tool makes before the
  tool call itself, so children are anchored before their parent.
- **DemoToken: CEP-18 `transfer_from` allowance (M33).** It is now built on
  odra-modules 2.9.1. Up to 2.8.2, `transfer_from` wrote the reduced allowance
  to `(owner, recipient)` instead of `(owner, spender)`. The spender's
  allowance never shrank, and the recipient gained an allowance nobody had
  granted. Our own contracts always pull with spender == recipient, so they
  were not affected.
- **RevenueSplit: share total cannot wrap (L40).** The u32 sum of shares uses
  `checked_add` and reverts with `SharesOverflow` (code 7).
- **CascadeController: overflow-free budget check.** `charge` compares `gross`
  with `budget - spent`, so a huge `gross` reverts with `BudgetExceeded`
  instead of an opaque overflow trap.
- **Release wasm traps on integer overflow** (`overflow-checks = true`). It
  used to wrap silently while the tests panicked.
- **CLI: `anchor-demo` refuses to run on mainnet (L42).** It writes fixture
  receipts, and that already happened once on the mainnet registry.

### Changed
- Odra 2.8.2 → 2.9.1 for every `odra-*` crate, from crates.io. The odra git
  tag `2.9.0` points at the 2.8.2 commit, so do not build from git.
- `REGISTRY_VERSION` 1.2.0 → 2.0.0, because `transfer_ownership` changed meaning.
- `Cargo.lock` is tracked so builds are reproducible (L44). Updated in the lock:
  h2, rustls, rustls-webpki and tokio (host-side CLI only, RUSTSEC fixes) and
  spin 0.9.8 (yanked) → 0.9.9. Still open: RUSTSEC-2026-0387 in crypto-bigint
  0.5.5, which comes in through casper-types and needs an upstream release.
- Formatted with rustfmt; `cargo fmt --check` and
  `cargo clippy --all-targets` are clean.
- `rust-toolchain` (plain text) → `rust-toolchain.toml`. The channel is
  unchanged, the wasm target and rustfmt/clippy are added, and the wasm is
  byte-identical. The plain-text file is what Dependabot's cargo job failed on
  (L72, I03).

### Tests
- 13 → 49 unit tests. New coverage:
  - DemoToken, which had no tests (L130).
  - Regression tests for the July 2026 fixes: C1 voucher binding across
    deployments and channel ids, C2 checks-effects-interactions against a
    re-entrant token, and C4 channel durations.
  - Budget, attribution and revenue-split invariants over deterministic
    pseudo-random runs.
  - A golden vector for the voucher byte layout.
  - Every error code the five contracts define or re-expose.
- The tests now pay with `DemoToken`, the token that is actually deployed,
  instead of odra-modules' `Cep18`, and sign vouchers with the test
  environment's own account keys. As a result `cargo odra test -b casper`
  runs them on the Casper execution engine against the built wasm (with
  overflow checks). 47 of the 49 run there; the two reentrancy tests need a
  test-only token that has no wasm, so they run in the mock VM only.

## [0.1.0] - 2026-07
### Added
- **ReceiptRegistry** — anchors settled tool-call receipts on-chain, each carrying
  its cascade `parent_id`; permissioned recorders, duplicate protection, events,
  `total_volume`, and a Casper-native in-place upgrade (v1.1.0 → v1.2.0).
- **RevenueSplit** — OpenZeppelin-style PaymentSplitter for CEP-18; fixed weights,
  pull-based `release`, enforced on-chain.
- **CascadeController** — budget-bounded cascades: one deposit caps a whole call
  tree (over-budget hops rejected on-chain) with recursive revenue attribution.
- **PaymentChannel** — prepaid channels; off-chain signed vouchers redeemed on-chain
  via Casper `verify_signature`.
- **DemoToken** — a deployable CEP-18 (WCSPR-style) payment token for the demos.
- 13/13 unit tests against a real CEP-18 in Odra's mock VM (`cargo odra test`).

### Security (2026-07-22 internal review, before the mainnet install)
- **PaymentChannel (C1):** vouchers are now
  `DOMAIN || contract package hash || channel_id || cumulative`, so a voucher
  cannot be replayed on another deployment. This breaks the earlier
  `channel_id || cumulative` format: off-chain signers must use the new layout.
- **CascadeController (C2):** `charge` follows checks-effects-interactions.
- **PaymentChannel (C4):** `checked_add` expiration and a 1 s minimum duration.
- **ReceiptRegistry (C6):** added `transfer_ownership`. `REGISTRY_VERSION` was
  left at 1.2.0.
