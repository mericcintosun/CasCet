# CasCet x402 client for Python

Let a Python program (an AI agent) pay an x402 v2 challenge on Casper. It signs
an EIP-712 `TransferWithAuthorization` with a Casper ed25519 key and pays the
way the TypeScript client does: the payment payload goes in the
`PAYMENT-SIGNATURE` request header, and its `accepted` field repeats the
payment requirements the 402 advertised.

The digest, signature and payload are **byte-for-byte identical** to the
TypeScript client's (`@casper-ecosystem/casper-eip-712`,
`@make-software/casper-x402`, `@x402/core`). So is the `PAYMENT-SIGNATURE`
header, for the same input JSON. The one exception is a number written with a
fraction or an exponent: Python writes `300.0` where JavaScript writes `300`.
Both decode to the same value, and the gateway compares values. The test
vectors in [`tests/eip712_vectors.json`](tests/eip712_vectors.json) were
produced by those packages, and [`tests/test_vectors.py`](tests/test_vectors.py)
checks that the Python output equals them. When the vectors were generated,
the TypeScript facilitator's own `verify()` accepted the vector payload (the
file records the result as `facilitatorVerify`).

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

## Pay a CasCet gateway

```python
from cascet_x402 import CasperKey, PayingClient, parse_payment_response

client = PayingClient(
    CasperKey.from_pem("agent.pem"),                # Casper ed25519 PKCS8 PEM
    networks=["casper:casper-test"],                # the default: testnet only
    allowed_pay_to=["00<seller account hash>"],     # pay only these sellers...
    allowed_assets=["hash-<CEP-18 package hash>"],  # ...in only these tokens
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
`PAYMENT-REQUIRED` header and picks the first `accepts` entry it is allowed to
pay. It signs that entry and retries once with `PAYMENT-SIGNATURE`. If the retry
is refused with another 402, that response comes back as is and nothing is
signed again. The gateway settles the payment through its facilitator, and the
settlement result arrives in the `PAYMENT-RESPONSE` header.

The client keeps the same guard rails as the TypeScript `createPayingFetch`.
Every refusal raises `PaymentAborted` before anything is signed.

| Guard | Setting | Behaviour |
|---|---|---|
| Network | `networks` (default `["casper:casper-test"]`) | Only pays on the listed networks. Each entry must be a CAIP-2 id such as `casper:casper`; wildcards like `casper:*` are refused. |
| Seller and token | `allowed_pay_to`, `allowed_assets` | Only pays these payees in these tokens. If either list is missing, the client logs an `InsecurePaymentConfigWarning`. |
| payTo format | — | Payees are accounts: allowlist entries are account hashes (`00…` or `account-hash-…`). A `01`-tagged payTo (a contract package, or a public key) is always refused, as in the TypeScript client, because no facilitator in use credits it correctly (`CONTRACT_PAYEE_REASON`). A public key or a contract package (`hash-…`) in the allowlist is a `ValueError`; for a public key the error gives the payTo to use instead. |
| Amount | — | A string of 1–40 ASCII digits, greater than 0. `-5`, `0x10`, `1e5` and ` 5` are all refused. |
| Budget | `max_per_call_raw`, `max_session_raw` | Per call, and per asset over the session, in raw units greater than 0. Spend is counted when an authorization is signed and is never refunded. |
| Validity | `max_authorization_seconds` (default 900) | `validAfter = now − 600`, `validBefore = now + maxTimeoutSeconds`. An entry without a positive whole `maxTimeoutSeconds`, or with one above the limit, is refused, as in the TS client. |
| Deadline | `timeout` (default 30 s) | One deadline for the whole call: the first request, the 402, signing, the paid retry and reading the response. Same as the TS client's `timeoutMs: 30000`. A gateway that trickles its headers or its body is cut off at the deadline, and nothing is signed after it. `None` disables it. A paid call that times out may still settle. |
| Transport | `allow_insecure_http` (default `False`) | Refuses to pay over plain `http://` unless the host is loopback. Never follows redirects: a 3xx comes back to the caller unpaid, so `PAYMENT-SIGNATURE`, the parent id and the request body never reach another origin. |
| Cascade | `parent_id` | Sent as `x-cascet-parent-id`, so downstream receipts join the chain. |
| Callback | `on_payment` | Called with `{amount_raw, pay_to, asset, network}` once a payment is signed. If it raises, the client issues a `RuntimeWarning` and still sends the payment. |

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
| `CASCET_ALLOWED_PAYTO`, `CASCET_ALLOWED_ASSETS` | Comma lists. Required unless `CASCET_ALLOW_ANY_SELLER` is `1`, `true` or `yes`. |
| `CASCET_MAX_PER_CALL`, `CASCET_MAX_SESSION` | Raw token units, greater than 0. Required unless `CASCET_ALLOW_UNLIMITED_BUDGET` is `1`, `true` or `yes`. |
| `CASCET_TIMEOUT_MS` | Deadline per call in milliseconds. Default: `30000`. |

`CASCET_TOOL_PINS` and `--accept-tool-changes` belong to the stdio bridge of
`cascet connect` and do not apply here.

[`example_gateway.py`](example_gateway.py) uses `from_env()`:

```bash
CASCET_KEY_PATH=tools/e2e/keys/agent.pem \
CASCET_ALLOWED_PAYTO=00<seller account hash> CASCET_ALLOWED_ASSETS=hash-<token package hash> \
CASCET_MAX_PER_CALL=1000000000 CASCET_MAX_SESSION=5000000000 \
clients/python/venv/bin/python clients/python/example_gateway.py \
    http://127.0.0.1:4402/mcp get_cspr_market_data '{}'
```

To get a seller's payTo from their public key, run
`clients/python/venv/bin/python clients/python/cascet_x402.py account-hash <public-key>`.
It prints the same value as `npx @cascet/cli account-hash`.

## Protocol building blocks (no policy)

These functions apply no allowlist or budget. Check `payTo`, `asset`,
`network`, `amount` and `maxTimeoutSeconds` yourself before you sign, and do
not let the paid request follow a redirect.

```python
import requests
from cascet_x402 import CasperKey, build_payment_payload, parse_payment_required, payment_signature_header

key = CasperKey.from_pem("agent.pem")
resp = requests.post(url, json=body, timeout=30, allow_redirects=False)
if resp.status_code == 402:
    challenge = parse_payment_required(resp)   # the decoded PAYMENT-REQUIRED header
    requirements = challenge["accepts"][0]     # check payTo, asset, network and amount first
    payload = build_payment_payload(key=key, requirements=requirements,
                                    resource=challenge.get("resource"))
    resp = requests.post(url, json=body, timeout=30, allow_redirects=False,
                         headers={"PAYMENT-SIGNATURE": payment_signature_header(payload)})
```

`build_payment_payload` returns
`{"x402Version": 2, "payload": {"signature", "publicKey", "authorization"}, "resource", "accepted"}`.
`accepted` is an unchanged copy of the requirements, including
`maxTimeoutSeconds` and `extra`. The gateway accepts a payment only when this
matches one of its `accepts` entries. A facilitator takes the same payload as
`{"paymentPayload": payload, "paymentRequirements": requirements}` on
`/verify` or `/settle`.

## End-to-end demo: settle through the self-hosted facilitator

Run from the repo root (the script finds its files from any directory):

```bash
# 1. start the CasCet facilitator (testnet, fee-sponsored)
pnpm --filter @cascet/e2e facilitator
# 2. sign + settle from Python
clients/python/venv/bin/python clients/python/example_settle.py
```

This moves 0.5 of the CasCet x402 token on testnet. `CASCET_NET=mainnet` moves
real funds on mainnet, and there it has no defaults: the script stops unless
`CASCET_KEY_PATH` and `CASCET_SELLER_ACCOUNT_HASH` are set. (The repo's demo
key is a throwaway key, and the old demo payee was the account of the single
hot deployer key.) Other settings:

| Variable | Meaning |
|---|---|
| `CASCET_KEY_PATH` | Payer key. Testnet default: `tools/e2e/keys/agent.pem`. Required on mainnet. |
| `FACILITATOR` | Facilitator base URL. Default: `http://127.0.0.1:4501`. |
| `CASCET_FACILITATOR_TOKEN` | Sent as `Authorization: Bearer …`. The facilitator requires it on mainnet. |
| `CASCET_SELLER_ACCOUNT_HASH` | The payee. Testnet default: the demo seller. Required on mainnet. |

## Tests

```bash
clients/python/venv/bin/python -m unittest discover -s clients/python/tests
```

The suite uses the standard library's `unittest`. It needs no external network
access and no funds. The redirect and deadline tests start small HTTP servers
on `127.0.0.1` and take a few seconds.

[`tests/eip712_vectors.json`](tests/eip712_vectors.json) was generated by
throwaway node scripts. They ran the TypeScript packages listed in the file's
`generator` field from this repo's `node_modules`, with a public test key
(`seed = sha256(label)`, never funded) and a pinned `Date.now` and nonce. The
header cases, including one with lone UTF-16 surrogates, come from
`@x402/core`'s `encodePaymentSignatureHeader`. To check against a newer
TypeScript stack, regenerate the file the same way; the tests show any
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
