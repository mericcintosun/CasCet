"""
Call a paid MCP tool on a CasCet gateway from Python and pay its x402 price.

    CASCET_KEY_PATH=tools/e2e/keys/agent.pem \\
    CASCET_ALLOWED_PAYTO=00<seller account hash> \\
    CASCET_ALLOWED_ASSETS=hash-<CEP-18 package hash> \\
    CASCET_MAX_PER_CALL=1000000000 CASCET_MAX_SESSION=5000000000 \\
    clients/python/venv/bin/python clients/python/example_gateway.py \\
        http://127.0.0.1:4402/mcp get_cspr_market_data '{}'

It reads the same environment variables as `npx @cascet/cli connect`:
CASCET_NETWORK (comma list, default casper:casper-test), CASCET_ALLOWED_PAYTO
and CASCET_ALLOWED_ASSETS (required unless CASCET_ALLOW_ANY_SELLER=1),
CASCET_MAX_PER_CALL and CASCET_MAX_SESSION in raw token units (required unless
CASCET_ALLOW_UNLIMITED_BUDGET=1) and CASCET_TIMEOUT_MS (deadline per call,
default 30000). The gateway runs the tool and settles the payment through its
facilitator; the settlement comes back in PAYMENT-RESPONSE.
"""
import json
import sys

import requests

from cascet_x402 import (
    HEADER_CASCET_PAYMENT_ID,
    PayingClient,
    PaymentAborted,
    ProtocolError,
    parse_payment_required,
    parse_payment_response,
)


def main(argv: list) -> int:
    if len(argv) < 3:
        print("usage: example_gateway.py <gateway-mcp-url> <tool> [json-arguments]", file=sys.stderr)
        return 2
    url, tool = argv[1], argv[2]
    try:
        arguments = json.loads(argv[3]) if len(argv) > 3 else {}
    except json.JSONDecodeError as exc:
        print(f"arguments must be JSON: {exc}", file=sys.stderr)
        return 2

    def on_payment(info: dict) -> None:
        print(f"[python] authorized {info['amount_raw']} raw units of {info['asset'][:10]}... "
              f"-> {info['pay_to'][:12]}... on {info['network']}", file=sys.stderr)

    try:
        client = PayingClient.from_env(on_payment=on_payment)
    except (ValueError, OSError, TypeError) as exc:  # TypeError: an encrypted PEM (no password given)
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2

    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": arguments}}
    with client:
        try:
            response = client.post(url, json=body, headers={"accept": "application/json"})
        except PaymentAborted as exc:
            print(exc, file=sys.stderr)
            return 1
        except ProtocolError as exc:
            print(f"the gateway sent an invalid x402 challenge: {exc}", file=sys.stderr)
            return 1
        except requests.exceptions.Timeout as exc:
            print(f"gateway at {url} did not answer in time: {exc}", file=sys.stderr)
            return 1
        except requests.exceptions.RequestException as exc:
            print(f"gateway unreachable at {url}: {exc}", file=sys.stderr)
            return 1

    if response.is_redirect:
        print(f"the gateway answered with a redirect to {response.headers.get('location')}; CasCet never follows "
              "redirects (the payment header must not reach another origin). Use the final gateway URL.",
              file=sys.stderr)
        return 1
    if response.status_code == 402:
        try:
            reason = parse_payment_required(response).get("error")
        except ProtocolError:
            reason = None
        print(f"payment rejected by the gateway: {reason or 'no reason given'}", file=sys.stderr)
        return 1
    try:
        settlement = parse_payment_response(response)
    except ProtocolError as exc:
        print(f"invalid PAYMENT-RESPONSE: {exc}", file=sys.stderr)
        return 1
    if settlement:
        print(f"[python] settled: tx={settlement.get('transaction')} payer={settlement.get('payer')} "
              f"payment-id={response.headers.get(HEADER_CASCET_PAYMENT_ID)}", file=sys.stderr)
    try:
        print(json.dumps(response.json(), indent=2))
    except ValueError:
        print(f"HTTP {response.status_code}: {response.text[:500]}")
        return 1
    return 0 if response.ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
