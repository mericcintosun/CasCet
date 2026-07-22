# CasCet x402 client for Python

Let a Python program (an AI agent) pay an x402 challenge on Casper. It signs an
EIP-712 `TransferWithAuthorization` with a Casper ed25519 key and produces the
exact payment payload the CasCet gateway and facilitator expect. The digest is
**byte-for-byte identical** to the TypeScript client
(`@casper-ecosystem/casper-eip-712` + `@make-software/casper-x402`), verified by
a cross-check, so the same authorization settles on-chain.

**Proven on-chain:** a Python-signed authorization settled via
`transfer_with_authorization` on both networks:
- Mainnet: <https://cspr.live/transaction/754224da36db9ecaef8399e720fc04fc2bc4605b383c63964788860db25533b7>
- Testnet: <https://testnet.cspr.live/transaction/04e54a95979152f653bcab15bd999fc7ef897e783f9cafd095ebad06353b6c76>

Run it against mainnet with `CASCET_NET=mainnet` (see below).

## Install

```bash
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

## Use

```python
from cascet_x402 import CasperKey, build_payment_payload

key = CasperKey.from_pem("agent.pem")            # Casper ed25519 PKCS8 PEM
payload = build_payment_payload(
    key=key,
    requirements=accepts_entry,                  # one entry from the 402 `accepts` list
    valid_after=now - 600,
    valid_before=now + 300,
)
# Send `payload` to the gateway (base64 in the X-PAYMENT header) or POST it to a
# facilitator /settle endpoint. See example_settle.py.
```

## End-to-end demo (settles a real payment on testnet)

```bash
# 1. start the CasCet facilitator (testnet, fee-sponsored)
pnpm --filter @cascet/e2e facilitator
# 2. sign + settle from Python
clients/python/venv/bin/python clients/python/example_settle.py
```

Only depends on `cryptography` (ed25519 PEM), `pycryptodome` (keccak-256) and
`requests`.
