# cascet_contracts

CasCet's Odra smart contracts on Casper — the on-chain layer for paid MCP over
x402. Five contracts on Odra 2.9.1 with 54 unit tests, which run both in Odra's
mock VM and on the Casper execution engine against the built wasm. The two
tests whose names end in `_mockvm_only` need a test-only re-entrant token that
has no wasm; on the Casper engine they return early, so they only run in the
mock VM.

| Contract | Purpose |
| --- | --- |
| `ReceiptRegistry` | Anchors settled tool-call receipts on-chain, each with its cascade `parent_id`. Permissioned recorders, duplicate protection, two-step ownership, events. `total_volume` saturates instead of overflowing. |
| `RevenueSplit` | OpenZeppelin-style PaymentSplitter for CEP-18 — fixed weights, pull-based `release`, enforced on-chain. |
| `CascadeController` | Budget-bounded cascades: one deposit caps a whole call tree (over-budget hops rejected on-chain) with recursive revenue attribution up the tree. |
| `PaymentChannel` | Prepaid channels for high-frequency traffic — off-chain signed vouchers redeemed on-chain via Casper `verify_signature`. Signers: the voucher bytes are specified on `voucher_message` and the signature encoding on `redeem` in [`src/payment_channel.rs`](src/payment_channel.rs), whose tests hold golden Ed25519 and Secp256k1 vectors. |
| `DemoToken` | A deployable CEP-18 (WCSPR-style) payment token for the demos, built on odra-modules' CEP-18 (2.9.0 or later, see `Cargo.toml`). |

`Cep18X402` under [`external/`](external/) is **not** ours: it's the reference
`transfer_with_authorization` (EIP-3009) token from
[make-software/casper-x402](https://github.com/make-software/casper-x402), which
CasCet deploys as its x402 payment token (see [`../NOTICE`](../NOTICE)).
Deployed package hashes: [`../docs/buidl-page.md`](../docs/buidl-page.md) and
[`resources/`](resources/).

## Usage

Install [cargo-odra](https://github.com/odradev/cargo-odra) first
(`cargo install cargo-odra --version 0.1.7 --locked`).

```bash
cargo odra test            # run the 54 unit tests (mock VM) — or plain `cargo test`
cargo odra test -b casper  # build the wasm, run the tests on the Casper execution engine
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

The toolchain is pinned in `rust-toolchain.toml` (`nightly-2026-01-01`) and
`Cargo.lock` is tracked. The release profile builds with `overflow-checks = true`.
The wasm embeds no local paths, so two builds of the same commit are
byte-identical when they use the same toolchain, lock file, cargo-odra and
binaryen (`wasm-opt`) version. The builds described here used:

```bash
cargo install cargo-odra --version 0.1.7 --locked
# plus wasm-opt (binaryen) version 130 and wasm-strip (wabt) 1.0.41 on PATH
cargo odra build && shasum -a 256 wasm/*.wasm
```

### The July 22 artifacts

The wasm files built on 2026-07-22 at 16:29 UTC, seven minutes before the
deploy run last wrote `resources/casper-contracts.toml` (mainnet,
`last_updated = 2026-07-22T16:36:32Z`), can be rebuilt byte for byte: build
the sources of commit `4e00541` with the Odra 2.8.2 `Cargo.lock` committed in
`2047fb5` and the tools above (checked on 2026-11-01).

| Contract | Bytes | sha256 |
| --- | --- | --- |
| `CascadeController` | 293,188 | `d80fe21671ebeaaf40b158cca2069152e577df76218dc8f5cf85ad80e380c4f4` |
| `DemoToken` | 306,934 | `689255129468e4891f1ae5f95a491de95380822ef5d14a68154af6a58ecbcf5c` |
| `PaymentChannel` | 288,873 | `fe99ce653937c3eba00d092b98e98b5bd72da41f061b8f3504e11b1ef000eb53` |
| `ReceiptRegistry` | 282,028 | `a8a27c9e7eff8af66114d434fb5df9f32dbc2843b76f2074e07ba3d2bee52af6` |
| `RevenueSplit` | 281,195 | `a7363092f9b7d2f888803aa8737f3d0971cb7d3d53b2cfc9ac808ee9640204cf` |

That ties the sources to these files, not yet to the chain. A node does not
store the uploaded module as it is: the `ContractWasm` of the mainnet
ReceiptRegistry (`hash-f86bef35…`) is a preprocessed module of 228,664 bytes
(sha256 `9032eecb…`) that imports `env.gas` and `env.memory` and exports only
the 12 entry points. Showing which build a package runs needs the session wasm
of its install transaction, and the repo does not record the install
transaction hashes yet.
