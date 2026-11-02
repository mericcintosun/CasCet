# Contributing to CasCet

Thanks for your interest in CasCet, the monetization layer for MCP on Casper.
This guide covers how to build the project, run the tests, and open a pull
request.

CasCet runs on Casper mainnet with real funds. Treat changes to the payment
path (`packages/client`, `packages/gateway`, `tools/e2e/src/real-facilitator.ts`,
`contracts/`) with extra care, and read [`SECURITY.md`](SECURITY.md) first.

## Prerequisites

- **Node.js** 22 or newer (Node 20 reached end of life on 2026-04-30). CI and
  the release workflow build and test on Node 24. On Node 22, `pnpm test` can
  fail a test file with "Unable to deserialize cloned data": Node 22's test
  runner misreads test output that starts with a multi-byte character such as
  an emoji. Run the tests again, or use Node 24.
- **pnpm** 10.20.0 (`corepack enable` provisions the version pinned in
  `package.json`)
- **Rust**, only for the smart contracts under [`contracts/`](contracts/): the
  toolchain is pinned by the toolchain file in `contracts/`, and rustup
  installs it on first use. Add the `rustfmt` and `clippy` components;
  [`cargo-odra`](https://odra.dev) is optional (`cargo test` works without it).
- **Python** 3 (CI uses 3.12), only for the Python client under `clients/python`

## Repository layout

This is a pnpm workspace monorepo:

| Path | What it is |
| --- | --- |
| `packages/core` | Shared types, config schema and helpers |
| `packages/gateway` | `cascet wrap` — puts an x402 paywall in front of an MCP server |
| `packages/client` | `cascet connect` — paying stdio bridge for MCP hosts |
| `packages/agent` | Autonomous LLM buyer that pays for tools under a budget |
| `packages/cli` | The `cascet` command-line entry point (`init`, `wrap`, `connect`, `account-hash`) |
| `clients/python` | Python paying client |
| `servers/*` | Example paid MCP servers (`casper-defi-data`, `portfolio-analyst`) |
| `apps/dashboard` | Next.js live dashboard, playground and landing page |
| `contracts` | Odra (Rust) smart contracts + deploy CLI |
| `tools/e2e` | Self-hosted x402 facilitator and the end-to-end demos |
| `tools/discord` | Optional one-command setup script for a CasCet Discord server (support runs on GitHub issues) |
| `examples` | Wrapping a third-party MCP server, end to end on testnet |
| `registry` | MCP Registry listing (`server.json`) |
| `docs` | Spec, on-chain addresses, testing playbook, submission pack |

## Getting started

```bash
pnpm install --frozen-lockfile   # fails if pnpm-lock.yaml is out of date
pnpm build                       # builds packages/* and servers/*
pnpm typecheck                   # typechecks the whole workspace
pnpm test                        # unit tests of every package that has them
```

To try the payment flow end to end with your own testnet keys, follow
[`examples/wrap-third-party`](examples/wrap-third-party/README.md). The demo
scripts in `tools/e2e` (`demo`, `demo-real`, `demo-real-wcspr`, `agent`,
`connect-demo`) sign with the maintainers' operator keys by default, which are
not in the repository, so they run on a maintainer's machine. `fund-token` and
`wrap-wcspr` default to the operator key too, but sign with your own testnet
key when you pass `--key /absolute/path/to/key.pem`.
[`docs/testing-playbook.md`](docs/testing-playbook.md) lists what each check
proves.

## Tests

TypeScript tests use Node's built-in test runner through `tsx`; no other test
framework is used. Put a test next to the code it covers as `*.test.ts`, and give
the package this script so `pnpm test` (`pnpm -r test`) picks it up:

```json
"test": "tsx --test \"src/**/*.test.ts\""
```

Python client tests use the standard library:

```bash
python3 -m pip install -r clients/python/requirements.txt
PYTHONPATH=clients/python python3 -m unittest discover -s clients/python/tests
```

## Smart contracts

```bash
cd contracts
cargo fmt --check
cargo clippy --all-targets
cargo test          # Odra unit tests in the mock VM (or: cargo odra test)
```

## What CI checks

Every pull request to `main` runs ([`.github/workflows`](.github/workflows)):

- `pnpm install --frozen-lockfile`, `pnpm build`, the dashboard's
  `next build`, `pnpm typecheck` and `pnpm test` on Node 24 (the release
  workflow builds and tests on Node 24 too);
- the Python client's unit tests;
- `pnpm audit --prod --audit-level=high`;
- `cargo fmt --check`, `cargo clippy --all-targets`, `cargo test` and
  `cargo audit` for the contracts;
- CodeQL for TypeScript/JavaScript, Python, Rust and the workflows.

## Dependencies

- Keep `pnpm-lock.yaml` in sync: run `pnpm install` after changing a
  `package.json` and commit the lockfile in the same pull request.
- Prefer no new dependency. When one is needed, say why in the pull request.
- Security overrides in `pnpm-workspace.yaml` are floors (`^x.y.z`), never exact
  pins. An advisory may only be accepted under `auditConfig` with a comment that
  says why and what change removes it.
- GitHub Actions are pinned to full commit SHAs with the version in a comment.

## Pull requests

1. Fork the repo and create a topic branch off `main`.
2. Keep the workspace green: everything listed under "What CI checks" must
   pass before you push.
3. Add tests for behaviour you change, especially on the payment path.
4. Write clear commit messages; keep unrelated changes in separate PRs.
5. Fill out the pull request template and link any related issue.
6. Never commit secrets, private keys or `.env` files. Keys made by
   `pnpm --filter @cascet/e2e gen-keys` are throwaway testnet keys; never fund
   them on mainnet.

## Releases

Maintainers release by pushing a `v*` tag whose version matches all four public
packages. The [publish workflow](.github/workflows/publish.yml) builds, tests and
publishes them with npm trusted publishing and provenance; no npm token is
involved.

## Reporting bugs, asking questions, requesting features

Use the issue templates under **New issue**; questions are welcome there too.
For security-sensitive reports, follow [`SECURITY.md`](SECURITY.md) instead of
opening a public issue.

## Code of Conduct

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
