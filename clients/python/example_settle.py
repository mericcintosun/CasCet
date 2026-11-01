"""
End-to-end proof: a Python program signs an x402 authorization with a Casper
ed25519 key and settles it on-chain through the self-hosted CasCet facilitator.
It moves real tokens (0.5 of the CasCet x402 token): testnet by default,
mainnet with CASCET_NET=mainnet.

Testnet (run from the repo root; the script finds its files from any directory):
    pnpm --filter @cascet/e2e facilitator
    clients/python/venv/bin/python clients/python/example_settle.py

Mainnet:
    CASCET_NET=mainnet pnpm --filter @cascet/e2e facilitator
    CASCET_NET=mainnet clients/python/venv/bin/python clients/python/example_settle.py

Environment:
    CASCET_NET=mainnet           settle on Casper mainnet instead of testnet
    CASCET_KEY_PATH              payer PEM (default: tools/e2e/keys/agent.pem in this repo)
    FACILITATOR                  facilitator base URL (default http://127.0.0.1:4501)
    CASCET_FACILITATOR_TOKEN     sent as "Authorization: Bearer <token>" when set
                                 (the facilitator requires it on mainnet)
    CASCET_SELLER_ACCOUNT_HASH   payee account hash (64 hex, 00 + 64 hex or
                                 account-hash-<hex>); default: the demo seller
"""
import os
import sys
from pathlib import Path

import requests

from cascet_x402 import CasperKey, build_payment_payload, normalize_pay_to

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
MAINNET = os.environ.get("CASCET_NET") == "mainnet"
FACILITATOR = os.environ.get("FACILITATOR", "http://127.0.0.1:4501").rstrip("/")

if MAINNET:
    NETWORK = "casper:casper"
    TOKEN = "8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41"
    DEFAULT_SELLER = "00b9a38c827771d6bc510dd5f1e24fee61acdd4f97f758f4d68fe1dea13a7a140d"
    EXPLORER = "https://cspr.live/transaction/"
else:
    NETWORK = "casper:casper-test"
    TOKEN = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3"
    DEFAULT_SELLER = "00881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36"
    EXPLORER = "https://testnet.cspr.live/transaction/"

AMOUNT = "500000000"  # 0.5 token (9 decimals)


def seller_pay_to() -> str:
    value = os.environ.get("CASCET_SELLER_ACCOUNT_HASH", "").strip()
    if not value:
        return DEFAULT_SELLER
    if len(value) == 64:  # a bare account hash
        value = "00" + value
    try:
        pay_to = normalize_pay_to(value)
    except ValueError as exc:
        raise SystemExit(f"CASCET_SELLER_ACCOUNT_HASH: {exc}") from None
    if not pay_to.startswith("00"):
        raise SystemExit(f"CASCET_SELLER_ACCOUNT_HASH must be an account hash, got {value!r}")
    return pay_to


def main() -> int:
    seller = seller_pay_to()
    # The payment requirements a CasCet gateway would advertise in its 402 (`accepts[0]`).
    requirements = {
        "scheme": "exact",
        "network": NETWORK,
        "amount": AMOUNT,
        "asset": TOKEN,
        "payTo": seller,
        "maxTimeoutSeconds": 300,
        "extra": {"name": "CasCet X402 Token", "symbol": "WCSPR", "version": "1", "decimals": "9"},
    }

    key_path = Path(os.environ.get("CASCET_KEY_PATH") or REPO_ROOT / "tools" / "e2e" / "keys" / "agent.pem")
    if not key_path.is_file():
        print(f"payer key not found: {key_path}\nset CASCET_KEY_PATH or run `pnpm --filter @cascet/e2e gen-keys`",
              file=sys.stderr)
        return 1
    key = CasperKey.from_pem(key_path)
    print(f"[python] network: {NETWORK}")
    print(f"[python] payer account-hash: {key.account_hash_hex()}")

    # Signs the EIP-712 authorization; the payload carries `accepted` (the full requirements).
    payment_payload = build_payment_payload(key=key, requirements=requirements)
    print(f"[python] signed authorization for {AMOUNT} raw units -> {seller[:12]}...")

    headers = {}
    token = os.environ.get("CASCET_FACILITATOR_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        resp = requests.post(
            f"{FACILITATOR}/settle",
            json={"paymentPayload": payment_payload, "paymentRequirements": requirements},
            headers=headers,
            timeout=120,  # the facilitator waits for the deploy to execute
        )
    except requests.RequestException as exc:
        print(f"\n❌ facilitator unreachable at {FACILITATOR}: {exc}")
        return 1

    try:
        data = resp.json()
    except ValueError:
        data = None
    if not isinstance(data, dict):
        print(f"\n❌ facilitator answered HTTP {resp.status_code} with a non-JSON body: {resp.text[:300]!r}")
        return 1
    print(f"[python] facilitator response (HTTP {resp.status_code}): {data}")

    if resp.status_code != 200:
        # Policy rejections (401 auth, 403 allowlist, 429 rate limit, 503 gas cap) carry {"error": ...}.
        reason = data.get("error") or data.get("errorReason") or "unknown error"
        print(f"\n❌ facilitator refused the settle (HTTP {resp.status_code}): {reason}")
        return 1
    if data.get("success"):
        tx = data["transaction"]
        net_label = "MAINNET" if MAINNET else "testnet"
        print(f"\n✅ Python-signed x402 payment settled on Casper {net_label}")
        print(f"   tx: {tx}")
        print(f"   {EXPLORER}{tx}")
        return 0
    print(f"\n❌ settle failed: {data.get('errorReason')} — {data.get('errorMessage') or ''}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
