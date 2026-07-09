# Contributing to CasCet

Thanks for your interest in CasCet, the monetization layer for MCP on Casper.
This guide covers how to build the project, run the tests, and open a pull
request.

## Prerequisites

- **Node.js** >= 20
- **pnpm** 10.20.0 (`corepack enable` will provision the pinned version)
- **Rust** + [`cargo-odra`](https://odra.dev) — only needed to build or test the
  smart contracts under [`contracts/`](contracts/)

## Repository layout

This is a pnpm workspace monorepo:

| Path            | What it is                                                        |
| --------------- | ----------------------------------------------------------------- |
| `packages/core` | Shared types and helpers                                          |
| `packages/gateway` | `cascet wrap` — puts an x402 paywall in front of an MCP server |
| `packages/client`  | `cascet connect` — paying stdio bridge for MCP hosts          |
| `packages/agent`   | Autonomous LLM buyer that pays for tools under a budget       |
| `packages/cli`     | The `cascet` command-line entry point                         |
| `servers/*`        | Example paid MCP servers (`casper-defi-data`, `portfolio-analyst`) |
| `apps/dashboard`   | Next.js live dashboard, playground, and landing page          |
| `contracts`        | Odra (Rust) smart contracts + deploy CLI                      |
| `tools/e2e`        | End-to-end cascade + agent demos                              |
| `docs`             | Spec, submission pack, and the testing playbook               |

## Getting started

```bash
pnpm install
pnpm build       # builds packages/* and servers/*
pnpm typecheck   # typechecks the whole workspace
```

Run the end-to-end cascade against the mock facilitator (no chain access needed):

```bash
pnpm --filter @cascet/e2e demo
```

See [`docs/testing-playbook.md`](docs/testing-playbook.md) for step-by-step
instructions covering the agent demo, the live dashboard, and real on-chain
settlement.

## Smart contracts

```bash
cd contracts
cargo odra test   # runs the Odra unit tests in the mock VM
```

## Pull requests

1. Fork the repo and create a topic branch off `main`.
2. Keep the workspace in a **buildable, green state** — `pnpm build` and
   `pnpm typecheck` must pass before you push.
3. Write clear commit messages; keep unrelated changes in separate PRs.
4. Fill out the pull request template and link any related issue.
5. Never commit secrets, private keys, or `.env` files. The demo signing keys
   are test-only keys for Casper Testnet.

## Reporting bugs and requesting features

Use the issue templates under **New issue**. For security-sensitive reports, see
[`SECURITY.md`](SECURITY.md) instead of opening a public issue.

## Code of Conduct

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
