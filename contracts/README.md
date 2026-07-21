# cascet_contracts

CasCet's Odra smart contracts on Casper — the on-chain layer for paid MCP over
x402. Five contracts, 13/13 unit tests against a real CEP-18 in Odra's mock VM.

| Contract | Purpose |
| --- | --- |
| `ReceiptRegistry` | Anchors settled tool-call receipts on-chain, each with its cascade `parent_id`. Permissioned recorders, duplicate protection, `total_volume`, events; Casper-native in-place upgrade. |
| `RevenueSplit` | OpenZeppelin-style PaymentSplitter for CEP-18 — fixed weights, pull-based `release`, enforced on-chain. |
| `CascadeController` | Budget-bounded cascades: one deposit caps a whole call tree (over-budget hops rejected on-chain) with recursive revenue attribution up the tree. |
| `PaymentChannel` | Prepaid channels for high-frequency traffic — off-chain signed vouchers redeemed on-chain via Casper `verify_signature`. |
| `DemoToken` | A deployable CEP-18 (WCSPR-style) payment token for the demos. |

`Cep18X402` under [`external/`](external/) is **not** ours: it's the reference
`transfer_with_authorization` (EIP-3009) token from
[make-software/casper-x402](https://github.com/make-software/casper-x402), deployed
to testnet so the hosted facilitator can settle real x402 payments (see
[`../NOTICE`](../NOTICE)). Deployed package hashes: [`../docs/buidl-page.md`](../docs/buidl-page.md).

## Usage

Install [cargo-odra](https://github.com/odradev/cargo-odra) first.

```bash
cargo odra test            # run the 13 unit tests (mock VM) — or plain `cargo test`
cargo odra build           # build optimized wasm into ./wasm
# deploy to testnet: fill .env from .env.sample, then
cargo run --bin cascet_contracts_cli -- deploy
```

Network: **Casper Testnet** (`casper:casper-test`), CEP-18 payment token,
`casper-eip-712` signatures. Toolchain pinned in `rust-toolchain`.
