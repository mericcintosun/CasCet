# Security Policy

CasCet runs on **Casper mainnet with real funds**. Please report security
problems privately, as described below, and never in a public issue, pull
request or discussion.

## Review status

CasCet has **not** had an external security audit. An internal multi-agent
review of the whole repository took place on 2026-10-20, and its findings are
being fixed; an external audit is planned. Until a report from that audit is
published, nothing in this repository or on the website should be read as
"audited".

## Scope

### Mainnet (highest priority)

The six contract packages CasCet operates on Casper mainnet (chain `casper`).
Open any of them at `https://cspr.live/contract-package/<hash>`.

| Contract | Package hash |
| --- | --- |
| Cep18X402 payment token ("CasCet X402 Token") | `8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41` |
| ReceiptRegistry | `f86bef35062e92d06b8171cf4131fdf557463589aca9112a348e5eb24159eb93` |
| RevenueSplit | `269afcceb147db41f68f5721df7b3957e5efeefb3bedbb9deba324c3a45d09c5` |
| CascadeController | `c7e56988214c62dc5eda20b14894a7514f7388560850b6db3094758363a62189` |
| PaymentChannel | `db2dc42b76f354e7716cafea8619ae6bc85fe50bc3e73979c2360dbba1458c57` |
| DemoToken (CEP-18) | `3da88daf3f276d915ea4f6734e0d4b3d4781358734c369b95de028a2c094fe74` |

The payment token is an instance of the reference `transfer_with_authorization`
token from [make-software/casper-x402](https://github.com/make-software/casper-x402)
(see [`NOTICE`](NOTICE)). Its deployment is in scope; if the bug is in the
upstream code itself, we will help you report it there as well.

Also in this tier:

- The npm packages `@cascet/core`, `@cascet/client`, `@cascet/gateway` and
  `@cascet/cli`, **version 0.1.1 and later**.
- The self-hosted x402 facilitator
  ([`tools/e2e/src/real-facilitator.ts`](tools/e2e/src/real-facilitator.ts),
  started by `pnpm --filter @cascet/e2e facilitator`), which signs and pays for
  settlement transactions.

### Also in scope

- The `main` branch of this repository, including the Python client
  (`clients/python`) and the dashboard at <https://cascet.vercel.app>.
- The Casper testnet deployments listed in [`docs/onchain.md`](docs/onchain.md).
  Testnet tokens have no value, but please report problems there the same way:
  the same code runs on mainnet.

### Out of scope

- The Casper network itself, the hosted CSPR.cloud facilitator and other
  third-party services. Report those to their maintainers (tell us too if
  CasCet is affected).
- Vulnerabilities in dependencies that CasCet cannot reach. If a dependency
  advisory is reachable through CasCet, it is in scope.
- Volumetric denial of service, spam, social engineering and physical attacks.

## Supported versions

| Version | Supported |
| --- | --- |
| `@cascet/*` 0.1.1 and later | Yes |
| `@cascet/*` 0.1.0 | **No.** It predates the payment-path fixes (no payTo or asset allowlist, no TLS guard). Upgrade to 0.1.1 or later. |
| `main` branch | Yes. Fixes land here first. |
| Mainnet contracts listed above | Yes |

## Reporting a vulnerability

1. **Preferred:** GitHub private vulnerability reporting. Open the repository's
   **Security** tab and choose **Report a vulnerability**, or go to
   <https://github.com/mericcintosun/CasCet/security/advisories/new>. If GitHub
   does not show a **Report a vulnerability** button, use the email below.
2. **Alternatively:** email **mericcintosunn@gmail.com** with "CasCet security"
   in the subject. This inbox is monitored.

Please include:

- a description of the issue and its impact (which component, which network);
- steps to reproduce, ideally a proof of concept against **testnet**;
- the commit hash, package version or contract package hash you tested;
- whether you want to be credited, and under which name.

Do not move, freeze or burn funds you do not own, do not access other people's
data, and do not degrade the mainnet gateway, facilitator or dashboard for
others. Testing that follows these rules is welcome, and we will not take
action against it.

There is no paid bug bounty at this time.

## Coordinated disclosure (90 days)

- We acknowledge your report within **3 business days**.
- We confirm or reject the issue, with a severity estimate, within
  **10 business days**.
- We aim to release a fix within **90 days** of your report, and sooner for
  anything that puts mainnet funds at risk. If funds are at immediate risk, we
  may first take the affected gateway or facilitator offline.
- We publish a GitHub security advisory when the fix is released, crediting
  you unless you prefer otherwise.
- Please keep the details private until the fix is released or 90 days have
  passed, whichever comes first. If we need more time we will ask you, explain
  why, and agree on a new date with you.

## Key handling

- Private keys, access tokens and `.env` files are never committed.
  `.gitignore` and `.vercelignore` exclude `*.pem`, `keys/` directories and
  `.env` files, so neither git nor a Vercel deployment picks them up.
- Mainnet keys are never committed and are not available to CI. The release
  workflow publishes the npm packages with npm trusted publishing (OIDC) and
  needs no stored npm token; only its publish job, which runs no dependency
  code, can request the OIDC token.
- Keys made by `pnpm --filter @cascet/e2e gen-keys` are throwaway testnet keys.
  Never fund them on mainnet.
- The maintainer demo `pnpm --filter @cascet/e2e demo-real-mainnet` pays from
  `tools/e2e/keys/agent.pem`, the path `gen-keys` writes to. On mainnet that
  file must be a dedicated payer key, created and stored separately (never a
  `gen-keys` output) and funded with a small float only.
- If you find a key, token or other secret in this repository, its history, a
  published package or a deployment, report it privately as described above.
  We rotate it and tell you when that is done.
