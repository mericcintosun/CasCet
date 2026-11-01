# cascet_contracts

CasCet's Odra smart contracts on Casper — the on-chain layer for paid MCP over
x402. Five contracts on Odra 2.9.1, with 49 unit tests in Odra's mock VM, run
against a real CEP-18 and a test-only re-entrant token.

| Contract | Purpose |
| --- | --- |
| `ReceiptRegistry` | Anchors settled tool-call receipts on-chain, each with its cascade `parent_id`. Permissioned recorders, duplicate protection, two-step ownership, events. `total_volume` saturates instead of overflowing. |
| `RevenueSplit` | OpenZeppelin-style PaymentSplitter for CEP-18 — fixed weights, pull-based `release`, enforced on-chain. |
| `CascadeController` | Budget-bounded cascades: one deposit caps a whole call tree (over-budget hops rejected on-chain) with recursive revenue attribution up the tree. |
| `PaymentChannel` | Prepaid channels for high-frequency traffic — off-chain signed vouchers redeemed on-chain via Casper `verify_signature`. |
| `DemoToken` | A deployable CEP-18 (WCSPR-style) payment token for the demos, built on odra-modules' CEP-18 (2.9.0 or later, see `Cargo.toml`). |

`Cep18X402` under [`external/`](external/) is **not** ours: it's the reference
`transfer_with_authorization` (EIP-3009) token from
[make-software/casper-x402](https://github.com/make-software/casper-x402), which
CasCet deploys as its x402 payment token (see [`../NOTICE`](../NOTICE)).
Deployed package hashes: [`../docs/buidl-page.md`](../docs/buidl-page.md) and
[`resources/`](resources/).

## Usage

Install [cargo-odra](https://github.com/odradev/cargo-odra) first.

```bash
cargo odra test            # run the 49 unit tests (mock VM) — or plain `cargo test`
cargo fmt --check          # formatting gate
cargo clippy --all-targets # lint gate (clean)
cargo odra build           # build optimized wasm into ./wasm
# deploy: fill .env from .env.sample, then
cargo run --bin cascet_contracts_cli -- deploy
```

The CLI deploys to whatever network `.env` names. Check
`ODRA_CASPER_LIVENET_CHAIN_NAME` (`casper-test` or `casper`) before you run it.
`.env.sample` targets testnet.

## Deployments and upgrades

All five contracts run on Casper Testnet and Mainnet. Installed packages keep
the code they were installed with. Every mainnet package is locked (not
upgradable). On testnet, every package listed in `resources/` is locked except
the demo upgradable ReceiptRegistry (`hash-764ed719…`), which was upgraded in
place from v1.1.0 to v1.2.0. Changes listed in [`CHANGELOG.md`](CHANGELOG.md)
under Unreleased reach a locked package only through a fresh install.

## Reproducible builds

The toolchain is pinned in `rust-toolchain` (`nightly-2026-01-01`) and
`Cargo.lock` is tracked. The release profile builds with `overflow-checks = true`.
The wasm embeds no local paths, so two builds of the same commit are
byte-identical when they use the same toolchain, lock file and binaryen
(`wasm-opt`) version. The current wasm was built with cargo-odra 0.1.7,
`wasm-opt` version 130 and `wasm-strip` (wabt) 1.0.41.
