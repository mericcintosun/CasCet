"""
End-to-end proof: a Python program signs an x402 authorization with a Casper
ed25519 key and settles it on-chain through the CasCet facilitator.

Start the facilitator first (testnet):
    pnpm --filter @cascet/e2e facilitator
Then:
    clients/python/venv/bin/python clients/python/example_settle.py
"""
import time
import requests
from cascet_x402 import CasperKey, build_payment_payload

FACILITATOR = "http://127.0.0.1:4501"
NETWORK = "casper:casper-test"
# The CasCet x402 token + seller on testnet.
TOKEN = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3"
SELLER = "00881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36"
AMOUNT = "500000000"  # 0.5 token (9 decimals)

# The payment requirements the CasCet gateway would advertise in its 402.
requirements = {
    "scheme": "exact",
    "network": NETWORK,
    "payTo": SELLER,
    "asset": TOKEN,
    "amount": AMOUNT,
    "extra": {"name": "CasCet X402 Token", "version": "1", "symbol": "WCSPR", "decimals": "9"},
}

key = CasperKey.from_pem("../../tools/e2e/keys/agent.pem")
print(f"[python] payer account-hash: {key.account_hash_hex()}")

now = int(time.time())
built = build_payment_payload(
    key=key, requirements=requirements,
    valid_after=now - 600, valid_before=now + 300,
)
print(f"[python] signed authorization for {AMOUNT} raw units -> {SELLER[:12]}...")

payment_payload = {
    "x402Version": 2,
    "accepted": {"scheme": "exact", "network": NETWORK},
    "payload": built["payload"],
}

resp = requests.post(
    f"{FACILITATOR}/settle",
    json={"paymentPayload": payment_payload, "paymentRequirements": requirements},
    timeout=90,
)
data = resp.json()
print(f"[python] facilitator response: {data}")
if data.get("success"):
    tx = data["transaction"]
    print(f"\n✅ Python-signed x402 payment settled on Casper testnet")
    print(f"   tx: {tx}")
    print(f"   https://testnet.cspr.live/transaction/{tx}")
else:
    print(f"\n❌ settle failed: {data.get('errorReason')} — {data.get('errorMessage')}")
