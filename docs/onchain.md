# CasCet on-chain addresses

CasCet is live on **both Casper mainnet and testnet**, with paying clients in
TypeScript and Python. Every contract and settlement below is public and
verifiable on cspr.live.

## Mainnet (chain "casper")

Open any package at `https://cspr.live/contract-package/<hash>`.

| Contract | Package hash |
| --- | --- |
| Cep18X402 payment token | `8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41` |
| ReceiptRegistry | `f86bef35062e92d06b8171cf4131fdf557463589aca9112a348e5eb24159eb93` |
| RevenueSplit | `269afcceb147db41f68f5721df7b3957e5efeefb3bedbb9deba324c3a45d09c5` |
| CascadeController | `c7e56988214c62dc5eda20b14894a7514f7388560850b6db3094758363a62189` |
| PaymentChannel | `db2dc42b76f354e7716cafea8619ae6bc85fe50bc3e73979c2360dbba1458c57` |
| DemoToken (CEP-18) | `3da88daf3f276d915ea4f6734e0d4b3d4781358734c369b95de028a2c094fe74` |

Real x402 payments settled on mainnet (0.5 WCSPR via `transfer_with_authorization`, status Success):

- TypeScript client: <https://cspr.live/transaction/2c66141c324216f4966f2d565c64c55cb37047cfc86b9863717d08d1b60a3bd1>
- Python client: <https://cspr.live/transaction/754224da36db9ecaef8399e720fc04fc2bc4605b383c63964788860db25533b7>

### Cascade primitive, proven on mainnet

The `CascadeController` is not just deployed and unit-tested; its full lifecycle
ran on Casper mainnet against the DemoToken CEP-18, every step verifiable on
cspr.live. One cascade (id 0) opened with a 100-token budget, charged a root hop
and a child hop with 20% recursive attribution up to the parent payee, rejected
an over-budget hop by construction, and refunded the remainder on close.

| Step | On-chain effect | Transaction |
| --- | --- | --- |
| approve | allow `CascadeController` to pull the 100-token budget | [`dee851a6…`](https://cspr.live/transaction/dee851a696116407083d51b185acaf51310b128c9978fce7213a6d16cf762f5f) |
| open | deposit the 100-token budget, cascade id 0 | [`03c9b08b…`](https://cspr.live/transaction/03c9b08b50e9999612748853e958d2668583a16ea47ddc996b587de3d3cc4c76) |
| charge root | pay the analyst 40 (hop 1, no parent) | [`7b293e54…`](https://cspr.live/transaction/7b293e54fdbd73e3e959c529c4a465b4c6e2c5d12eff965ac89d1593ffe72321) |
| charge child | 20 gross: 16 to the data provider, 4 up to the analyst (20% attribution) | [`999396c4…`](https://cspr.live/transaction/999396c44ad6af738000e20928faff4c49978d63571ceaaa8ba9010602d68b9a) |
| charge (over budget) | 50 would exceed the 100 budget → reverts `BudgetExceeded` (User error 5) | [`abf67205…`](https://cspr.live/transaction/abf672055e5c2fe7c6407a3ebffa1954598583724871dd35b9fe0a08434c1a09) |
| close | refund the unspent 40 to the owner | [`2c1aa62c…`](https://cspr.live/transaction/2c1aa62c6114b436e9214ac1fdfa9efbaf77c1c0a406a893e592bb9a9565d406) |

After close, the `CascadeController` holds zero tokens (100 in = 40 + 4 + 16 paid
out + 40 refunded) and the analyst's balance is exactly 44 (40 from the root hop
plus the 4-token attribution from its child) — the recursive revenue split,
enforced on-chain rather than by trusting the gateway.

## Testnet (chain "casper-test")

Open any package at `https://testnet.cspr.live/contract-package/<hash>`.

| Contract | Package hash |
| --- | --- |
| Cep18X402 payment token | `cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3` |
| ReceiptRegistry | `bdf8422b69d7bfb7581e7b2c63fbfb0fc8b23701181289411170bce5cf996f97` |
| RevenueSplit | `fa21efb406a8151d15a393bc366e51192a9ea15fd7fe23faffc54f021b32883c` |
| CascadeController | `624134336d1f63ce539ebef9c226e6c463f70a8e85b593bbc5d370520d797980` |
| DemoToken (CEP-18) | `b3e9908b6cdbf5c565b686938994e3ac8e6749f41bcbe83615604321a0965d49` |

Python-signed x402 settle on testnet (status Success):

- <https://testnet.cspr.live/transaction/04e54a95979152f653bcab15bd999fc7ef897e783f9cafd095ebad06353b6c76>
