# CasCet x402 client for Python

Let a Python program (an AI agent) pay an x402 v2 challenge on Casper. It signs
an EIP-712 `TransferWithAuthorization` with a Casper ed25519 key and pays the
way the TypeScript client does: the payment payload goes in the
`PAYMENT-SIGNATURE` request header, and its `accepted` field repeats the
payment requirements the 402 advertised.

The digest and signature are **byte-for-byte identical** to the TypeScript
client's (`@casper-ecosystem/casper-eip-712` with `@x402/casper` 2.29 and
`@x402/core` 2.29, and before them `@make-software/casper-x402` 1.0.0 and
`@x402/core` 2.17). So are the payload and the `PAYMENT-SIGNATURE` header, for
the same input JSON and the same validity window (see
[Validity window](#validity-window)). The one exception is a number written
with a fraction or an exponent: Python writes `300.0` where JavaScript writes
`300`. Both decode to the same value, and the gateway compares values. The
test vectors in [`tests/eip712_vectors.json`](tests/eip712_vectors.json) and
[`tests/x402_casper_2_29_vectors.json`](tests/x402_casper_2_29_vectors.json)
were produced by those packages, and [`tests/test_vectors.py`](tests/test_vectors.py)
checks that the Python output equals them. When the first file was generated,
the TypeScript facilitator's own `verify()` accepted its payload (the file
records the result as `facilitatorVerify`).

**Proven on-chain:** a Python-signed authorization settled via
`transfer_with_authorization` on both networks:
- Mainnet: <https://cspr.live/transaction/754224da36db9ecaef8399e720fc04fc2bc4605b383c63964788860db25533b7>
- Testnet: <https://testnet.cspr.live/transaction/04e54a95979152f653bcab15bd999fc7ef897e783f9cafd095ebad06353b6c76>

## Install

Python 3.10 or newer.

```bash
cd clients/python
python3 -m venv venv
./venv/bin/pip install --require-hashes -r requirements-lock.txt   # pinned, hash-checked
# or the newest compatible versions: ./venv/bin/pip install -r requirements.txt
```

## Two token styles

A CasCet gateway can sell in two kinds of x402 token, and a 402 may offer both:

| Style | Tokens | The facilitator settles with |
|---|---|---|
| `legacy-amount` | CasCet's own x402 token ("CasCet X402 Token", testnet `cb65a928…`, mainnet `8dd4f1aa…`) | `transfer_with_authorization(…, amount, …)`, through CasCet's self-hosted facilitator |
| `cep3009-value` | CEP-3009 tokens such as the official Wrapped CSPR (testnet `3d80df21…`) | `transfer_with_authorization(…, value, …)`, through the hosted CSPR.cloud facilitator |

Both styles verify the same EIP-712 message, so the client signs them the same
way: the only difference is the token's EIP-712 domain (its name and package
hash). The gateway names the style in each `accepts` entry as
`extra.authorizationStyle`. The client echoes it unchanged in `accepted`,
refuses an entry whose style it does not know (`build_payment_payload` raises
`ProtocolError`, a `ValueError`), and can prefer one style over the other
(`prefer_styles`). An entry without the field (a gateway from before it
existed) is still paid. Facilitators do not rely on the field. The hosted
facilitator always passes `value`, and CasCet's self-hosted facilitator passes
`amount` for now. A token sent to the facilitator of the other style reverts
(User error 64658) and still burns the whole gas limit of the settle.

## Pay a CasCet gateway

```python
from cascet_x402 import CasperKey, PayingClient, parse_payment_response

client = PayingClient(
    CasperKey.from_pem("agent.pem"),                # Casper ed25519 PKCS8 PEM
    networks=["casper:casper-test"],                # the default: testnet only
    allowed_pay_to=["00<seller account hash>"],     # pay only these sellers...
    allowed_assets=["hash-<CEP-18 package hash>"],  # ...in only these tokens
    prefer_styles=["cep3009-value"],                # optional: when a 402 offers both styles
    max_per_call_raw="1000000000",                  # raw token units
    max_session_raw="5000000000",                   # per asset, for the client's lifetime
)
resp = client.post(
    "https://gateway.example.com/mcp",
    json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
          "params": {"name": "get_cspr_market_data", "arguments": {}}},
)
print(resp.json()["result"])
print(parse_payment_response(resp))  # settlement: {success, transaction, network, payer}
```

When the gateway answers 402, the client reads the challenge from the
`PAYMENT-REQUIRED` header and picks an `accepts` entry it is allowed to pay:
the first one, or with `prefer_styles` the first one of the most preferred
style. It signs that entry and retries once with `PAYMENT-SIGNATURE`. If the
retry is refused with another 402, that response comes back as is and nothing
is signed again. The gateway settles the payment through its facilitator, and
the settlement result arrives in the `PAYMENT-RESPONSE` header.

The client keeps the same guard rails as the TypeScript `createPayingFetch`.
Every refusal raises `PaymentAborted` before anything is signed.

| Guard | Setting | Behaviour |
|---|---|---|
| Network | `networks` (default `["casper:casper-test"]`) | Only pays on the listed networks. Each entry must be a CAIP-2 id such as `casper:casper`; wildcards like `casper:*` are refused. |
| Seller and token | `allowed_pay_to`, `allowed_assets` | Only pays these payees in these tokens. If either list is missing, the client logs an `InsecurePaymentConfigWarning`. |
| payTo format | — | Payees are accounts: allowlist entries are account hashes (`00…` or `account-hash-…`). A `01`-tagged payTo (a contract package, or a public key) is always refused, as in the TypeScript client, because no facilitator in use credits it correctly (`CONTRACT_PAYEE_REASON`). A public key or a contract package (`hash-…`) in the allowlist is a `ValueError`; for a public key the error gives the payTo to use instead. |
| Token style | `prefer_styles` (optional) | An `extra.authorizationStyle` other than `legacy-amount` or `cep3009-value` is refused. `prefer_styles` orders the acceptable entries; it never makes an entry acceptable. |
| Amount | — | A string of 1–40 ASCII digits, greater than 0. `-5`, `0x10`, `1e5` and ` 5` are all refused. |
| Budget | `max_per_call_raw`, `max_session_raw` | Per call, and per asset over the session, in raw units greater than 0. Spend is counted when an authorization is signed and is never refunded. A preferred entry over budget gives way to the next acceptable one. |
| Validity | `max_authorization_seconds` (default 900) | `validBefore = now + maxTimeoutSeconds`. An entry without a positive whole `maxTimeoutSeconds`, or with one above the limit, is refused, as in the TS client. |
| Deadline | `timeout` (default 30 s) | One deadline for the whole call: the first request, the 402, signing, the paid retry and reading the response. Same as the TS client's `timeoutMs: 30000`. A gateway that trickles its headers or its body is cut off at the deadline, and nothing is signed after it. `None` disables it. A paid call that times out may still settle. |
| Transport | `allow_insecure_http` (default `False`) | Refuses to pay over plain `http://` unless the host is loopback. Never follows redirects: a 3xx comes back to the caller unpaid, so `PAYMENT-SIGNATURE`, the parent id and the request body never reach another origin. |
| Cascade | `parent_id` | Sent as `x-cascet-parent-id`, so downstream receipts join the chain. |
| Callback | `on_payment` | Called with `{amount_raw, pay_to, asset, network}` once a payment is signed, plus `authorization_style` when the 402 named one. If it raises, the client issues a `RuntimeWarning` and still sends the payment. |

Pass `stream=True` to `request()` to read a large body yourself; the deadline
then ends when the response headers arrive. The exact cut-off of a dripping
body uses `HTTPResponse.shutdown()` from urllib3 2.3, which `requirements.txt`
requires (`requirements-lock.txt` pins 2.8). In an environment with an older
urllib3 the deadline is only checked between chunks.

`PayingClient.from_env()` reads the same environment variables as
`npx @cascet/cli connect`, and reports an invalid value with the name of its
variable:

| Variable | Meaning |
|---|---|
| `CASCET_KEY_PATH` | Path to the payer's PEM key. |
| `CASCET_KEY_ALGO` | Optional. Only `ed25519` is supported here; any other value is an error. |
| `CASCET_NETWORK` | Comma list of networks. Default: `casper:casper-test`. |
| `CASCET_ALLOWED_PAYTO`, `CASCET_ALLOWED_ASSETS` | Comma lists. Required unless `CASCET_ALLOW_ANY_SELLER` is `1`, `true` or `yes`. Payees are account hashes. |
| `CASCET_PREFER_STYLES` | Optional comma list of authorization styles in order of preference, e.g. `cep3009-value,legacy-amount`. |
| `CASCET_MAX_PER_CALL`, `CASCET_MAX_SESSION` | Raw token units, greater than 0. Required unless `CASCET_ALLOW_UNLIMITED_BUDGET` is `1`, `true` or `yes`. |
| `CASCET_TIMEOUT_MS` | Deadline per call in milliseconds. Default: `30000`. |

`CASCET_TOOL_PINS` and `--accept-tool-changes` belong to the stdio bridge of
`cascet connect` and do not apply here.

[`example_gateway.py`](example_gateway.py) uses `from_env()`. With
`--asset legacy` (the CasCet X402 Token) or `--asset wcspr` (the testnet
Wrapped CSPR) it pays in that token only, in place of `CASCET_ALLOWED_ASSETS`:

```bash
CASCET_KEY_PATH=tools/e2e/keys/agent.pem \
CASCET_ALLOWED_PAYTO=00<seller account hash> CASCET_ALLOWED_ASSETS=hash-<token package hash> \
CASCET_MAX_PER_CALL=1000000000 CASCET_MAX_SESSION=5000000000 \
clients/python/venv/bin/python clients/python/example_gateway.py \
    http://127.0.0.1:4402/mcp get_cspr_market_data '{}'
# or, paying in testnet Wrapped CSPR whatever CASCET_ALLOWED_ASSETS says:
#   clients/python/venv/bin/python clients/python/example_gateway.py --asset wcspr http://127.0.0.1:4402/mcp get_cspr_market_data
```

To get a seller's payTo from their public key, run
`clients/python/venv/bin/python clients/python/cascet_x402.py account-hash <public-key>`.
It prints the same value as `npx @cascet/cli account-hash`.

## Protocol building blocks (no budget)

These functions keep no budget. `select_requirement` applies the network,
payee and asset allowlists, the account-payee rule and the style preference;
check the amount and `maxTimeoutSeconds` yourself before you sign, and do not
let the paid request follow a redirect.

```python
import requests
from cascet_x402 import (CasperKey, build_payment_payload, parse_payment_required,
                         payment_signature_header, select_requirement)

key = CasperKey.from_pem("agent.pem")
resp = requests.post(url, json=body, timeout=30, allow_redirects=False)
if resp.status_code == 402:
    challenge = parse_payment_required(resp)   # the decoded PAYMENT-REQUIRED header
    requirements = select_requirement(         # PaymentAborted (with every reason) if none qualifies
        challenge["accepts"],
        allowed_assets=["hash-<CEP-18 package hash>"],  # None means any token
        allowed_pay_to=["00<seller account hash>"],     # None means any account
        networks=["casper:casper-test"],
        prefer_styles=["cep3009-value"],
    )                                          # check its amount and maxTimeoutSeconds
    payload = build_payment_payload(key=key, requirements=requirements,
                                    resource=challenge.get("resource"))
    resp = requests.post(url, json=body, timeout=30, allow_redirects=False,
                         headers={"PAYMENT-SIGNATURE": payment_signature_header(payload)})
```

`build_payment_payload` returns
`{"x402Version": 2, "payload": {"signature", "publicKey", "authorization"}, "resource", "accepted"}`.
`accepted` is an unchanged copy of the requirements, including
`maxTimeoutSeconds` and all of `extra` (`extra.authorizationStyle` too). The
gateway accepts a payment only when this matches one of its `accepts` entries.
A facilitator takes the same payload as
`{"x402Version": 2, "paymentPayload": payload, "paymentRequirements": requirements}`
on `/verify` or `/settle`.

Other helpers: `authorization_style(requirements)` (the advertised style, or
`None`), `default_authorization_style(package_hash)` (`legacy-amount` for
CasCet's own tokens, listed in `LEGACY_AMOUNT_TOKENS`, otherwise
`cep3009-value`, as in `@cascet/core`) and `is_hosted_facilitator_url(url)`.

### Validity window

The authorization is valid until `now + maxTimeoutSeconds`, capped at
`max_validity_seconds` (900 by default). By default `build_payment_payload`
back-dates `validAfter` to `now - 600` to tolerate clock skew, as
`@make-software/casper-x402` did. `valid_after` may be 0: that is what
`@x402/casper` 2.29's client, and so the TypeScript client since the 2.29
migration, signs. Pass `valid_after=0` to get its payload byte for byte. The
CasCet gateway and facilitator, and `@x402/casper`'s facilitator, accept both.

## End-to-end demo: settle through a facilitator

Run from the repo root (the script finds its files from any directory):

```bash
# CasCet X402 Token on testnet, through CasCet's self-hosted facilitator
pnpm --filter @cascet/e2e facilitator     # in one terminal (fee-sponsored)
clients/python/venv/bin/python clients/python/example_settle.py

# Wrapped CSPR on testnet, through the hosted CSPR.cloud facilitator (its default)
CSPR_CLOUD_TOKEN=<CSPR.cloud access key> \
clients/python/venv/bin/python clients/python/example_settle.py --asset wcspr
```

This moves 0.5 of the chosen token. The script builds the payment requirements
a CasCet gateway would advertise (with `extra.authorizationStyle`), signs them
and posts them to the facilitator's `/settle`. For the hosted facilitator it
leaves `extra.authorizationStyle` out, as a CasCet gateway does before it
calls that facilitator: whether the hosted service accepts fields it does not
know is untested, and no signature covers the field. Each token goes to the
facilitator that settles its style, and the script refuses the other pairing
before signing anything, because that settle would revert (User error 64658)
and still burn the whole gas limit:

| Token | Settled by | Refused |
|---|---|---|
| `legacy` (CasCet X402 Token, `legacy-amount`) | CasCet's self-hosted facilitator (the default) | the hosted facilitator, which passes `value` |
| `wcspr` (Wrapped CSPR, `cep3009-value`) | the hosted facilitator (the default) | CasCet's self-hosted facilitator, which passes `amount` for now (`SELF_HOSTED_SETTLE_STYLES`) |

Any facilitator URL other than the hosted one is taken for CasCet's
self-hosted facilitator. A Wrapped CSPR payment needs a WCSPR balance on the
payer's account (wrap some testnet CSPR first). On 2026-11-01 the hosted
facilitator's testnet fee payer held less CSPR than a settle needs, so hosted
testnet settles fail until it is refilled.

`CASCET_NET=mainnet` moves real funds on mainnet, with the CasCet X402 Token
only, and there it has no defaults: the script stops unless `CASCET_KEY_PATH`
and `CASCET_SELLER_ACCOUNT_HASH` are set. (The repo's demo key is a throwaway
key, and the old demo payee was the account of the single hot deployer key.)
Settings:

| Option / variable | Meaning |
|---|---|
| `--asset`, `CASCET_ASSET` | `legacy` (default: the CasCet X402 Token) or `wcspr` (the official Wrapped CSPR, testnet only). |
| `--facilitator`, `FACILITATOR` | Facilitator base URL (without a query or a fragment), or `self` (`http://127.0.0.1:4501`, the default for `legacy`) or `hosted` (`https://x402-facilitator.cspr.cloud`, the default for `wcspr`). |
| `CSPR_CLOUD_TOKEN` | CSPR.cloud access key for the hosted facilitator. Sent raw as `Authorization: <key>` (never `Bearer`), and to the hosted facilitator only. |
| `CASCET_FACILITATOR_TOKEN` | Token of any other facilitator, sent as `Authorization: Bearer …`. The self-hosted facilitator requires it on mainnet. Never sent to the hosted facilitator. |
| `CASCET_KEY_PATH` | Payer key. Testnet default: `tools/e2e/keys/agent.pem`. Required on mainnet. |
| `CASCET_SELLER_ACCOUNT_HASH` | The payee. Testnet default: the demo seller. Required on mainnet. |

The script never sends a key over plain `http://` to a host other than this
machine, and never follows a redirect. Each key must be one line of 1–256
printable ASCII characters without spaces (surrounding whitespace, such as the
newline of a key read from a file, is dropped). An error about a key names its
variable and never shows the value.

| Exit status | Meaning |
|---|---|
| `0` | Settled. The script prints the transaction and its explorer link. |
| `1` | Not settled: a setting or a refusal (before anything is signed), a facilitator that could not be reached, or a settle the facilitator reports failed (see below for a hosted failure without a transaction hash). |
| `2` | Invalid options. |
| `3` | Outcome unknown. The request may have reached the facilitator but no answer came back (a read timeout, a dropped connection), or the facilitator could not confirm the transfer (`settlement_pending`, `settlement_unknown`, or a server error such as a proxy's 504 that does not say what happened). |

After an unknown outcome the settle may still execute. Check the payer's token
balance and the explorer before you run the script again: a re-run signs a new
authorization and can pay twice. The script prints the payer's account hash,
the transaction when the facilitator named one, the authorization's nonce, and
the time after which the authorization can no longer execute. The hosted
facilitator answers any failure after the broadcast (for example when it stops
waiting for the transaction) without a transaction hash, so after a hosted
failure without one the script prints the same caution.

## Tests

```bash
clients/python/venv/bin/python -m unittest discover -s clients/python/tests
```

The suite uses the standard library's `unittest`. It needs no external network
access and no funds. The redirect and deadline tests start small HTTP servers
on `127.0.0.1` and take a few seconds; the example tests replace the network
calls with fakes, or with such a server for the transport failures of a
settle (a hang-up, a read timeout, a closed port).

The vector files were generated by throwaway node scripts that ran the
TypeScript packages listed in each file's `generator` field from this repo's
`node_modules`, with a public test key (`seed = sha256(label)`, never funded)
and a pinned `Date.now` and nonce.
[`tests/eip712_vectors.json`](tests/eip712_vectors.json) holds digests,
headers and a payment from the 2.17 stack; its header cases, including one with
lone UTF-16 surrogates, come from `@x402/core`'s `encodePaymentSignatureHeader`.
[`tests/x402_casper_2_29_vectors.json`](tests/x402_casper_2_29_vectors.json),
generated offline, holds the digests of one authorization under each token
style's domain (the 2.29 migration design's vectors, checked against both
`casper-eip-712` and `@x402/casper`) and a 402 offering both tokens with the
payload `@x402/core` 2.29's `x402Client` built for each, through
`@cascet/client`'s scheme wrapper and signer. To check against a newer
TypeScript stack, regenerate the files the same way; the tests show any
difference.

## Dependencies

| Package | Used for |
|---|---|
| `cryptography` | ed25519 PEM keys and signing. |
| `pycryptodome` | keccak-256. |
| `requests` | `PayingClient` and the examples. The signing functions don't need it. |
| `urllib3` 2.3 or newer | Installed with `requests`. `PayingClient` calls its `HTTPResponse.shutdown()` to cut off a body read at the deadline. |

The Python client signs with ed25519 keys only. secp256k1 payer keys are
supported by the TypeScript client.
