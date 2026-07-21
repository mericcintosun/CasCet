# Changelog

Changelog for `cascet_contracts` — CasCet's Odra smart contracts on Casper.

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
