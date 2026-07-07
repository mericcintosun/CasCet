# External reference contract

`Cep18X402.wasm` is the reference CEP-18 token from
[make-software/casper-x402](https://github.com/make-software/casper-x402)
(`infra/local/deployer/Cep18X402.wasm`). Unlike a plain CEP-18, it implements
`transfer_with_authorization` (EIP-3009 / casper-eip-712), which is what the
x402 "exact" scheme settles. CasCet deploys an instance of it as the real
payment token so the hosted CSPR.cloud facilitator can settle live payments.

Deploy with `tools/e2e/deploy-x402-token.mjs`.
