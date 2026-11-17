# External reference contract

`Cep18X402.wasm` is the reference CEP-18 token from
[make-software/casper-x402](https://github.com/make-software/casper-x402)
(`infra/local/deployer/Cep18X402.wasm`). Unlike a plain CEP-18, it implements
`transfer_with_authorization` (EIP-3009 / casper-eip-712), which is what the
x402 "exact" scheme settles. CasCet deploys an instance of it as the real
payment token.

This build takes the settled amount as `amount`. The hosted CSPR.cloud
facilitator now sends CEP-3009's `value`, so CasCet settles through its own
facilitator (`tools/e2e/src/real-facilitator.ts`); see
[`../../docs/onchain.md`](../../docs/onchain.md). There is no deploy script for
this token in the repository.
