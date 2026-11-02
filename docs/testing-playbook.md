# CasCet — Testing Playbook

Step-by-step instructions to verify CasCet works. No marketing. Each step lists
the command, what it needs, and what you should observe.

CasCet is live on Casper mainnet with real funds and has not been externally
audited yet (internal multi-agent review on 2026-10-20; external audit planned;
see [`SECURITY.md`](../SECURITY.md)). Everything below runs on testnet or
without a chain, except where it says mainnet.

## Option A — Try it without installing (2 minutes)

1. Open the live app: <https://cascet.vercel.app>
2. Open the interactive playground: <https://cascet.vercel.app/playground>
   - Move the budget and price sliders. The cascade tree redraws and shows which
     calls are affordable. Lower the deposit below the tree cost and the tree
     enters a "budget exceeded" state (the rule the `CascadeController` contract
     enforces).
3. Watch the demo video (linked on the BUIDL page and in the README) for a full
   run: the agent prices tools, buys, pays, and settles on Casper.

## Option B — Build and test locally (no keys, no chain; 10 minutes)

### Prerequisites

- Node.js 22 or newer (CI uses Node 24; on Node 22 a test file can fail with
  "Unable to deserialize cloned data", a Node 22 test-runner bug: run the tests
  again, or use Node 24)
- pnpm 10.20.0 (`corepack enable`)
- (Contracts only) Rust; rustup installs the toolchain pinned by the
  toolchain file in `contracts/`
- (Python client only) Python 3

### 1. Install, build, typecheck

```bash
git clone https://github.com/mericcintosun/CasCet.git
cd CasCet
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
```

Expected: the install uses the committed lockfile unchanged, and every workspace
package builds and typechecks with no errors.

### 2. Unit tests

```bash
pnpm test
```

Expected: every package that has tests runs them with Node's built-in test
runner, and all pass.

Python client (when `clients/python/tests` exists):

```bash
python3 -m pip install -r clients/python/requirements.txt
PYTHONPATH=clients/python python3 -m unittest discover -s clients/python/tests
```

### 3. Smart contract tests

```bash
cd contracts
cargo fmt --check
cargo clippy --all-targets
cargo test        # or: cargo odra test
```

Expected: formatting and clippy are clean, and the Odra unit tests pass in the
mock VM against a real CEP-18.

### 4. Dashboard

```bash
pnpm --filter @cascet/dashboard dev      # http://localhost:3939
```

Expected: the landing page, `/playground` and `/build` work. The on-chain views
need a CSPR.cloud access token in `CSPR_CLOUD_TOKEN`; without it they stay empty.

## Option C — A real paid call on testnet, with your own keys

Follow [`examples/wrap-third-party`](../examples/wrap-third-party/README.md). It
runs the CLI of your checkout (`node packages/cli/dist/cli.js`, after
`pnpm build`), never the unsupported npm 0.1.0. In short:

1. Make three testnet keys (seller, facilitator fee payer, buyer), fund the fee
   payer from the faucet, and ask for test tokens for the buyer in a GitHub
   issue.
2. `node packages/cli/dist/cli.js account-hash <seller public key>` gives the
   `payTo`.
3. Start the self-hosted facilitator
   (`CASCET_FACILITATOR_KEY=… CASCET_SELLER_ACCOUNT_HASH=… pnpm --filter @cascet/e2e facilitator`),
   then the gateway
   (`node packages/cli/dist/cli.js wrap examples/wrap-third-party/cascet.config.json`).
4. Connect an MCP host with `node packages/cli/dist/cli.js connect` and the
   allowlist, network, budget and timeout variables shown in the example.

Expected:

- `curl http://127.0.0.1:4410/.well-known/x402.json` lists exactly three priced
  tools (`echo`, `get-sum`, `trigger-long-running-operation`).
- `tools/list` through the bridge shows those three plus the free
  `get-tiny-image`; `get-env` and the other unlisted tools do not appear, and a
  direct call to them is rejected.
- A paid call returns its result, the facilitator logs `settled tx=…`, and the
  transaction is visible on `testnet.cspr.live`.
- `connect` refuses to start if you leave out an allowlist or a budget.

## Option D — Maintainer demos (need the CasCet operator keys)

These scripts sign with the operator keys in `contracts/keys/`, which are not in
the repository, so they only run on a maintainer's machine. They produced the
transactions linked in the README and in [`buidl-page.md`](buidl-page.md).

### Full cascade, real settlement on testnet

```bash
pnpm --filter @cascet/e2e gen-keys
# fund the analyst wallet once with 300 CasCet X402 Token (a dry run without --send)
pnpm --filter @cascet/e2e fund-token cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3 <analyst-account-hash> 300 --send
pnpm --filter @cascet/e2e demo
```

Expected: an agent pays `$0.10` for `analyze_portfolio`, which autonomously
spends `$0.07` buying four data tools underneath. The script asserts at the end
that every downstream payment is linked to the root cascade id, and prints the
reconstructed payment tree. With the dashboard running (Option B, step 4), the
revenue ticks up, receipts stream in, and the payment graph branches (agent to
analyst to data server) in real time.

### Autonomous buyer

```bash
ANTHROPIC_API_KEY=<your-key> pnpm --filter @cascet/e2e agent
```

Expected: real Claude (via the Anthropic API) reads the three priced DeFi/RWA
tools, decides which to buy, pays x402 per call under a fixed budget enforced by
the paying client, and returns a recommendation citing the purchased data. Ends
with `AGENT PASS`. Without `ANTHROPIC_API_KEY` the script points you to
`connect-demo`.

### Real Claude through `cascet connect`

If the `claude` CLI is logged in on a Claude Pro/Max plan (no API key needed),
this drives a **real** Claude that discovers the priced tools and buys them
through `cascet connect`, paying each x402 for real:

```bash
pnpm --filter @cascet/e2e connect-demo
```

Expected: Claude Code reads the priced DeFi/RWA tools, buys the ones it judges
worth it (typically market data + gold + treasury + yields), the connect bridge
pays each 402 under budget, and it prints a grounded allocation citing the numbers
it paid for. Ends with `CONNECT DEMO PASS — Claude bought N paid tool call(s)`.

`get_defi_yields` returns its labeled snapshot unless the data server has a
cspr.cloud access token. The gateway gives the server it wraps none of its own
environment, so the token has to reach the data server through `upstream.env`
in the gateway config (`"env": { "CSPR_CLOUD_TOKEN": "…" }`). The demo scripts
put `CSPR_CLOUD_TOKEN` there for you when it is set in their environment.

### Single-hop settlement: testnet and mainnet

```bash
pnpm --filter @cascet/e2e demo-real            # testnet
pnpm --filter @cascet/e2e demo-real-mainnet    # MAINNET, real funds
```

`demo-real-mainnet` pays from `tools/e2e/keys/agent.pem`, the path `gen-keys`
writes to. On mainnet that file must be a dedicated payer key, created and
stored separately (never a `gen-keys` output) and funded with a small float
only. Read [`mainnet-readiness.md`](mainnet-readiness.md) for the facilitator's
keys, limits and state file (`CASCET_FACILITATOR_STATE_FILE`, required on
mainnet) before the mainnet run.

Expected: the agent pays from its on-chain balance of the x402 token; the
self-hosted facilitator verifies and settles; the receipt is anchored on-chain.
The script prints the transaction link (e.g. testnet `0218ff4c…`, mainnet
`2c66141c…`). The testnet demo then waits for the anchor (up to 150 s) and reads
both transactions back with read-only RPC: it prints the gas limit, consumed
gas, refund and net cost of the settle and of the anchor, and a limit suggested
from the measurement (ceil(1.3 × consumed)) next to the configured one.

### Two token styles on testnet: CasCet X402 Token and Wrapped CSPR

Casper x402 tokens come in two styles. Buyers sign the same EIP-712
`TransferWithAuthorization` for both; only the argument the facilitator passes
to the token's `transfer_with_authorization` entry point differs:

| Style | Settle argument | Testnet token | Settled by |
| --- | --- | --- | --- |
| `legacy-amount` | `amount` | CasCet X402 Token, `hash-cb65a928…` | the self-hosted facilitator |
| `cep3009-value` | `value` | official Wrapped CSPR (WCSPR), `hash-3d80df21…`, 9 decimals, version `1` | the self-hosted facilitator, or the hosted CSPR.cloud facilitator |

A facilitator that sends the wrong argument makes the settle revert with
`User error: 64658` and burns its gas limit, so the demos refuse those
pairings before anyone signs. The gateway advertises the style in each
`accepts` entry (`extra.authorizationStyle`); no facilitator trusts that field.
The hosted facilitator sends `value`; the self-hosted one reads each
allowlisted token's ABI and sends `amount` or `value` to match.

`wrap-wcspr` and `fund-token` are dry runs unless you add `--send`: a dry run
reads the chain (read-only), checks the token, the accounts and the balances,
prints what it would sign and what it costs, and exits non-zero when something
would fail; with `--send` they refuse to sign while a check fails. They run on
testnet only: they refuse `CASCET_NETWORK=casper:casper`, `CASCET_NET=mainnet`,
and any node (`CASCET_RPC_URL`) that does not serve `casper-test`. They sign
with `contracts/keys/deployer_secret_key.pem` unless you pass
`--key /absolute/path.pem`.

1. Wrap testnet CSPR into WCSPR (the signer receives it):

   ```bash
   pnpm --filter @cascet/e2e wrap-wcspr 10           # dry run: plan and expected cost
   pnpm --filter @cascet/e2e wrap-wcspr 10 --send    # sign and submit
   ```

   It calls WCSPR's payable `deposit` through Odra's proxy session
   (`proxy_caller_with_return.wasm` of `odra-casper-rpc-client` 2.9.1, pinned by
   SHA-256; `cargo fetch` in `contracts/` downloads it). The default gas limit
   is 10 CSPR, charged up front, with 75% of the unused part refunded on
   success: an account's first wrap also creates its cargo purse (2.5 CSPR of
   `create_purse`), so expect about 5.6 CSPR of gas for the first wrap and less
   afterwards. `--gas-cspr` sets the limit; it refuses a limit below 1.3 × the
   estimated consumption (5.45 CSPR for a first wrap) and below 2.5 CSPR, since
   a wrap that runs out of gas burns its whole limit. After `--send` it prints
   the measured gas and the new WCSPR balance.

2. Give the buyer (`tools/e2e/keys/agent.pem`) some WCSPR:

   ```bash
   pnpm --filter @cascet/e2e fund-token 3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e <agent-account-hash> 5 --send
   ```

   `fund-token <token> <recipient account hash> <amount>` works for any CEP-18
   token with `transfer(recipient, amount)`; the amount is in whole tokens at
   the token's on-chain decimals (`--raw` for raw units). It refuses to send
   when the signer's token balance is short or cannot be read (a short balance
   reverts the transfer and burns its gas limit); for a token without an Odra
   `balances` dictionary, `--skip-balance-check` sends without that check.

3. Pay in WCSPR:

   ```bash
   CASCET_FACILITATOR=hosted CSPR_CLOUD_TOKEN=<CSPR.cloud access key> \
   pnpm --filter @cascet/e2e demo-real-wcspr
   ```

   `demo-real` has no dry run: after its read-only checks (the token's ABI,
   name and chain, the buyer's balance, and for the hosted facilitator its fee
   payer) it signs the buyer's authorization and pays, always on testnet.
   It takes `CASCET_ASSET=legacy|wcspr` and `CASCET_FACILITATOR=self|hosted`
   (`demo-real-wcspr` is `demo-real --asset wcspr`):

   | | `self` (default) | `hosted` |
   | --- | --- | --- |
   | `legacy` (default) | the original demo | refused: the hosted facilitator sends `value` |
   | `wcspr` | settles through the self-hosted facilitator, which sends `value` | needs `CSPR_CLOUD_TOKEN` |

   The gateway sends `CSPR_CLOUD_TOKEN` to the hosted facilitator raw in the
   `Authorization` header (`facilitator.authScheme: "raw"`, never `Bearer`).

   **Known blocker:** the hosted facilitator's TESTNET fee payer
   (`account-hash-81d557c9…`) held 2.145 CSPR on 2026-11-01, less than the 2.5
   CSPR a settle needs (Casper's minimum initiator balance, and the hosted
   facilitator's gas limit per settle), so every hosted testnet settle fails
   until MAKE refills it. `demo-real` reads the fee payer from the hosted
   facilitator's `/supported` and its balance (read-only) before anyone signs,
   and stops when the balance is short or when either cannot be read. The
   mainnet fee payer is funded.

4. Measure the settle gas. `demo-real` prints the measured gas of every run; to
   set the `cep3009-value` limit (`DEFAULT_SETTLE_PAYMENT_MOTES_BY_STYLE`, 3.5
   CSPR until measured), collect 3 to 5 settle hashes and run:

   ```bash
   pnpm --filter @cascet/e2e settle-report <tx-hash> <tx-hash> <tx-hash>
   ```

   It reads the transactions (read-only, `--network casper:casper` for mainnet
   ones), prints limit, consumed, refund and net cost per transaction, and per
   kind (settle per style, anchor, wrap, transfer) suggests ceil(1.3 × max
   consumed). A suggestion below 2.5 CSPR is a valid limit: Casper's 2.5 CSPR
   (`baseline_motes_amount`) is the minimum balance of the account that submits
   a transaction, not a minimum gas limit, and the report says so next to such
   a suggestion. Never use `@x402/casper`'s 2.5 CSPR default for the legacy
   token: its settles consume about 2.7 CSPR.

### Python client

```bash
pnpm --filter @cascet/e2e facilitator     # in one terminal (variables: see the README)
clients/python/venv/bin/python clients/python/example_settle.py
```

Expected: a Python-signed authorization settles through the facilitator; see
[`clients/python/README.md`](../clients/python/README.md) for setup and the
mainnet switch.

## Verify the on-chain artifacts directly

Every contract and sample transaction is listed in
[`buidl-page.md`](buidl-page.md) and [`onchain.md`](onchain.md), on mainnet
(`cspr.live`) and testnet (`testnet.cspr.live`). Open any of them to confirm the
deploys and settlements are real.

## Monetize your own MCP server (the product surface)

```bash
npx "@cascet/cli@^0.1.1" init                                 # writes cascet.config.json
npx "@cascet/cli@^0.1.1" account-hash <your-public-key-hex>   # your payTo ("00" + account hash)
# edit cascet.config.json: upstream, payTo, asset, facilitator.url, prices,
# pricing.freeTools and settleBeforeExecute where needed
npx "@cascet/cli@^0.1.1" wrap                                 # your MCP server is now paid
```

The quoted range never resolves to the unsupported 0.1.0: until 0.1.1 is on
npm, `npx` stops with `ETARGET`. In a clone, `node packages/cli/dist/cli.js`
runs the same commands from your checkout.

Point an agent at it (all of these limits are required by `connect`):

```bash
CASCET_KEY_PATH=./agent.pem \
CASCET_NETWORK=casper:casper-test \
CASCET_ALLOWED_PAYTO=00<seller account hash> \
CASCET_ALLOWED_ASSETS=hash-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3 \
CASCET_MAX_PER_CALL=1000000000 \
CASCET_MAX_SESSION=5000000000 \
npx "@cascet/cli@^0.1.1" connect http://127.0.0.1:4402/mcp
```

The README sections
[Monetize your own MCP server](../README.md#monetize-your-own-mcp-server) and
[Point an agent at it](../README.md#point-an-agent-at-it) explain every field and
variable, and which facilitator can settle which token.
