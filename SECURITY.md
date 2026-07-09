# Security Policy

## Scope

CasCet is a research prototype built for the Casper Agentic Buildathon 2026. It
runs against **Casper Testnet only**. The payment tokens are test tokens with no
monetary value. Do not point CasCet at Mainnet or fund it with real assets.

## Supported versions

The `main` branch is the only supported version during the buildathon. Security
fixes land on `main`.

| Version | Supported |
| ------- | --------- |
| `main`  | Yes       |
| older commits | No  |

## Reporting a vulnerability

Please **do not open a public issue** for security-sensitive reports.

- Preferred: use GitHub's private **"Report a vulnerability"** flow under the
  repository's **Security** tab.
- Alternatively, email **mericcintosunn@gmail.com** with:
  - a description of the issue and its impact,
  - steps to reproduce (a proof of concept if possible),
  - the commit hash you tested against.

You can expect an acknowledgement within a few days. Please give us reasonable
time to investigate and ship a fix before any public disclosure.

## Handling of secrets

Never commit private keys, API tokens, or `.env` files. Signing keys used in the
demos are test-only keys for Casper Testnet. If you find a leaked secret in the
history, report it privately using the channels above.
