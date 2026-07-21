# BUIDL page — paste-ready block

Copy the sections below onto the DoraHacks BUIDL page so it carries the contract
package hashes and sample Testnet transactions with descriptions, as required for
the final-round qualification review. All links point to Casper Testnet
(`testnet.cspr.live`).

---

## Deployer / operator account

`01dd710d5083920b20c706a92d742c7bf9162d09c96fa373bd0a67b0bf51d3f183`

<https://testnet.cspr.live/account/01dd710d5083920b20c706a92d742c7bf9162d09c96fa373bd0a67b0bf51d3f183>

## Contract package hashes (Casper Testnet)

| Contract | What it does | Package hash |
| --- | --- | --- |
| **ReceiptRegistry** | Anchors settled tool-call receipts on-chain; each carries its cascade `parent_id`. Makes it verifiable that a call was paid and how payments compose. | `hash-bdf8422b69d7bfb7581e7b2c63fbfb0fc8b23701181289411170bce5cf996f97` |
| **ReceiptRegistry (upgradable)** | Same registry with Casper native in-place upgrade; anchored state survives the upgrade. | `hash-764ed7190b69dafbc94a0148a07be85227f268a85424e7186be66cdb711b8222` |
| **RevenueSplit** | OpenZeppelin-style PaymentSplitter for CEP-18. Splits a server's earnings between payees by fixed weights, pull-based, enforced on-chain. | `hash-fa21efb406a8151d15a393bc366e51192a9ea15fd7fe23faffc54f021b32883c` |
| **CascadeController** | The budget-bounded cascade primitive: one deposit caps a whole call tree (enforced on-chain), with recursive revenue attribution up the tree. | `hash-624134336d1f63ce539ebef9c226e6c463f70a8e85b593bbc5d370520d797980` |
| **PaymentChannel** | Prepaid channels for high-frequency traffic: deposit once, authorize usage off-chain with signed vouchers, redeem/reclaim on-chain (Casper `verify_signature`). | `hash-53930d3982a5bea717ec919096cef407b71a1ce9022b241c1d94f19ca770ccb0` |
| **DemoToken (CEP-18, WCSPR-style)** | CasCet's own CEP-18 payment token used in the demos. | `hash-b3e9908b6cdbf5c565b686938994e3ac8e6749f41bcbe83615604321a0965d49` |
| **Cep18X402** *(third-party, deployed for interop)* | Reference `transfer_with_authorization` (EIP-3009) token from [make-software/casper-x402](https://github.com/make-software/casper-x402); lets the hosted facilitator settle real x402 payments. Not authored by CasCet (see `NOTICE`). | `hash-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3` |

## Sample Testnet transactions (with descriptions)

| # | Description | Transaction |
| --- | --- | --- |
| 1 | **Deploy ReceiptRegistry** on Testnet. | [`632a0d75…`](https://testnet.cspr.live/transaction/632a0d756c51c18ec0804b8bec338772691dca5a981835777c6512687afe1866) |
| 2 | **Anchor a receipt** — the running gateway records a settled tool-call receipt with its cascade `parent_id`. | [`0f796802…`](https://testnet.cspr.live/transaction/0f79680230269c43b31528d282dc094d1f5fea000087332f6193e29361b16e4d) |
| 3 | **Real x402 settlement** — agent pays a real CEP-18 `transfer_with_authorization`; the hosted CSPR.cloud facilitator verifies and settles (no mock). | [`9bc90044…`](https://testnet.cspr.live/transaction/9bc90044ac4053be6bd87fa1a09cec80ea24d509decfe747b001fc1bfc561fc2) |
| 4 | **RevenueSplit — fund** the splitter with 1000 WCSPR. | [`b7c7bbf5…`](https://testnet.cspr.live/transaction/b7c7bbf54f4dbe9375d536c50264b399191f362ce051e3a8ea2f08f86512390d) |
| 5 | **RevenueSplit — release 40%** to the second payee (400 WCSPR). | [`462b1daf…`](https://testnet.cspr.live/transaction/462b1dafa7968ad238f671fd44e6fb3e12a9ce5e9994f1a79330c1adc15a710c) |
| 6 | **RevenueSplit — release 60%** to the first payee (600 WCSPR). | [`6fc0195d…`](https://testnet.cspr.live/transaction/6fc0195ddfb9d6cd8a80eab240cf6d0f4a76c89afcea45679c0f883de9b87e3c) |
| 7 | **CascadeController — open a budget-capped cascade**; unspent budget (870) is returned. | [`9bea3ea7…`](https://testnet.cspr.live/transaction/9bea3ea79762d0b8a6fe3e44a593d5943bd03b2ba86dfbfab0043ca018cb28e0) |
| 8 | **CascadeController — attribution hop**: revenue attributed up the tree to the reselling tool. | [`eb96a049…`](https://testnet.cspr.live/transaction/eb96a049692b7918a949bb2cd84982980d643e23678f490f8b851b84f0815b68) |
| 9 | **CascadeController — over-budget step rejected** on-chain (the budget rule enforced). | [`d1df6c89…`](https://testnet.cspr.live/transaction/d1df6c898bbc8edc63fca9018dd4352f40afc6cea45a20666c91dbaf28887572) |
| 10 | **Upgradable ReceiptRegistry — in-place upgrade**; the package now carries two versions and all anchored state survived. | [`0202cc29…`](https://testnet.cspr.live/transaction/0202cc298c844cb771835612ac028df978c5d8fd0e442b724bdf995c17547e34) |
| 11 | **RevenueSplit — wallet-signed `release`** (the `/withdraw` UI): a payee pulls their weighted share on-chain. | [`f7cda49c…`](https://testnet.cspr.live/transaction/f7cda49c87e1e2f13a3b8f3bb0a75ef19f57e911bdf6238f529ae43489437c21) |

## Live pages

- App / dashboard: <https://cascet.vercel.app>
- Build a config (wizard): <https://cascet.vercel.app/build>
- Withdraw revenue (Casper Wallet): <https://cascet.vercel.app/withdraw>
- On-chain economy explorer: <https://cascet.vercel.app/explorer>
- Cascade playground: <https://cascet.vercel.app/playground>

## Links

- Code: <https://github.com/mericcintosun/CasCet>
- npm: <https://www.npmjs.com/package/@cascet/cli> (`npx @cascet/cli`)
- Socials: X [`@cascet_xyz`](https://x.com/cascet_xyz) · Discord [`discord.gg/fcjevk47k`](https://discord.gg/fcjevk47k)
- Testing playbook: [`docs/testing-playbook.md`](testing-playbook.md)
- x402-MCP spec: [`docs/x402-mcp-spec.md`](x402-mcp-spec.md)
