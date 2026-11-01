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
CASCET_PREFER_STYLES (optional: legacy-amount, cep3009-value in order of
preference), CASCET_MAX_PER_CALL and CASCET_MAX_SESSION in raw token units
(required unless CASCET_ALLOW_UNLIMITED_BUDGET=1) and CASCET_TIMEOUT_MS
(deadline per call, default 30000). The gateway runs the tool and settles the
payment through its facilitator; the settlement comes back in PAYMENT-RESPONSE.

To pay in one of the two tokens a CasCet gateway may offer, name it instead of
its package hash: `--asset legacy` (the CasCet X402 Token, on testnet or
mainnet) or `--asset wcspr` (the official Wrapped CSPR, testnet only). It
replaces CASCET_ALLOWED_ASSETS (CASCET_ASSET does the same), so the client pays
in that token or not at all:

    CASCET_KEY_PATH=tools/e2e/keys/agent.pem CASCET_ALLOWED_PAYTO=00<seller account hash> \\
    CASCET_MAX_PER_CALL=1000000000 CASCET_MAX_SESSION=5000000000 \\
    clients/python/venv/bin/python clients/python/example_gateway.py --asset wcspr \\
        http://127.0.0.1:4402/mcp get_cspr_market_data '{}'
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Dict, List, Mapping, Optional, Sequence

import requests

from cascet_x402 import (
    DEFAULT_NETWORKS,
    HEADER_CASCET_PAYMENT_ID,
    NETWORK_CASPER_MAINNET,
    NETWORK_CASPER_TESTNET,
    PayingClient,
    PaymentAborted,
    ProtocolError,
    parse_payment_required,
    parse_payment_response,
)

#: Package hashes of the tokens --asset names, by network.
ASSETS: Dict[str, Dict[str, str]] = {
    "legacy": {  # CasCet X402 Token (legacy-amount)
        NETWORK_CASPER_TESTNET: "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3",
        NETWORK_CASPER_MAINNET: "8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41",
    },
    "wcspr": {  # official Wrapped CSPR (cep3009-value); its mainnet token is not verified for x402 yet
        NETWORK_CASPER_TESTNET: "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e",
    },
}


def allowed_assets_for(asset: str, network_list: Optional[str]) -> List[str]:
    """The CASCET_ALLOWED_ASSETS entries for `asset` (legacy or wcspr) on the networks of `network_list` (CASCET_NETWORK)."""
    name = asset.strip().lower()
    if name not in ASSETS:
        raise ValueError(f"asset must be one of {', '.join(ASSETS)}, got {asset!r}")
    networks = [n.strip() for n in (network_list or "").split(",") if n.strip()] or list(DEFAULT_NETWORKS)
    hashes = [ASSETS[name][network] for network in dict.fromkeys(networks) if network in ASSETS[name]]
    if not hashes:
        raise ValueError(
            f"asset {name} is only set up on {', '.join(ASSETS[name])}, and CASCET_NETWORK is {', '.join(networks)}"
        )
    return [f"hash-{package_hash}" for package_hash in hashes]


def client_environment(asset: Optional[str], env: Mapping[str, str]) -> Dict[str, str]:
    """The environment for PayingClient.from_env, with CASCET_ALLOWED_ASSETS set from `asset` when one is named."""
    out = dict(env)
    asset = asset or (env.get("CASCET_ASSET") or "").strip() or None
    if asset is not None:
        out["CASCET_ALLOWED_ASSETS"] = ",".join(allowed_assets_for(asset, env.get("CASCET_NETWORK")))
    return out


def on_payment(info: Dict[str, str]) -> None:
    style = f" ({info['authorization_style']})" if "authorization_style" in info else ""
    print(f"[python] authorized {info['amount_raw']} raw units of {info['asset'][:10]}...{style} "
          f"-> {info['pay_to'][:12]}... on {info['network']}", file=sys.stderr)


def main(argv: Optional[Sequence[str]] = None, env: Optional[Mapping[str, str]] = None) -> int:
    env = os.environ if env is None else env
    parser = argparse.ArgumentParser(prog="example_gateway.py", description="Call a paid MCP tool and pay its x402 price.")
    parser.add_argument("url", help="the gateway's MCP endpoint, e.g. http://127.0.0.1:4402/mcp")
    parser.add_argument("tool", help="the tool to call")
    parser.add_argument("arguments", nargs="?", default="{}", help="the tool's arguments as JSON (default {})")
    parser.add_argument("--asset", help="pay only in this token: legacy or wcspr (replaces CASCET_ALLOWED_ASSETS)")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:  # argparse already printed the usage
        return 2 if exc.code else 0
    try:
        arguments = json.loads(args.arguments)
    except json.JSONDecodeError as exc:
        print(f"arguments must be JSON: {exc}", file=sys.stderr)
        return 2

    try:
        client = PayingClient.from_env(client_environment(args.asset, env), on_payment=on_payment)
    except (ValueError, OSError, TypeError) as exc:  # TypeError: an encrypted PEM (no password given)
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2

    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": args.tool, "arguments": arguments}}
    with client:
        try:
            response = client.post(args.url, json=body, headers={"accept": "application/json"})
        except PaymentAborted as exc:
            print(exc, file=sys.stderr)
            return 1
        except ProtocolError as exc:
            print(f"the gateway sent an invalid x402 challenge: {exc}", file=sys.stderr)
            return 1
        except requests.exceptions.Timeout as exc:
            print(f"gateway at {args.url} did not answer in time: {exc}", file=sys.stderr)
            return 1
        except requests.exceptions.RequestException as exc:
            print(f"gateway unreachable at {args.url}: {exc}", file=sys.stderr)
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
    sys.exit(main())
