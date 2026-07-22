"""
CasCet x402 client for Python.

A small, dependency-light client that lets a Python program (an AI agent) pay an
x402 challenge on Casper: it signs an EIP-712 `TransferWithAuthorization` with a
Casper ed25519 key and produces the exact payment payload the CasCet gateway and
facilitator expect. The digest is byte-for-byte compatible with the TypeScript
client (`@casper-ecosystem/casper-eip-712` + `@make-software/casper-x402`).

Deps: cryptography (ed25519 PEM), pycryptodome (keccak-256), requests.
"""
from __future__ import annotations
import hashlib
import secrets
from dataclasses import dataclass
from Crypto.Hash import keccak as _keccak
from cryptography.hazmat.primitives.serialization import load_pem_private_key
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def keccak256(data: bytes) -> bytes:
    return _keccak.new(digest_bits=256).update(data).digest()


def _from_hex(h: str) -> bytes:
    return bytes.fromhex(h[2:] if h.startswith(("0x", "0X")) else h)


# ---- EIP-712 field encoders (mirror @casper-ecosystem/casper-eip-712) ----
def _encode_address(hex_str: str) -> bytes:
    b = _from_hex(hex_str)
    if len(b) == 20:
        return b"\x00" * 12 + b
    if len(b) == 33:          # Casper "00"/"01" tag + 32-byte hash
        return keccak256(b)
    raise ValueError(f"address must be 20 or 33 bytes, got {len(b)}")


def _encode_uint256(value: int) -> bytes:
    return int(value).to_bytes(32, "big")


def _encode_bytes32(hex_str: str) -> bytes:
    b = _from_hex(hex_str)
    if len(b) != 32:
        raise ValueError(f"bytes32 must be 32 bytes, got {len(b)}")
    return b


def _encode_string(value: str) -> bytes:
    return keccak256(value.encode("utf-8"))


DOMAIN_TYPE = b"EIP712Domain(string name,string version,string chain_name,bytes32 contract_package_hash)"
STRUCT_TYPE = b"TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"


def _hash_domain(name: str, version: str, chain_name: str, contract_package_hash_hex: str) -> bytes:
    parts = [
        keccak256(DOMAIN_TYPE),
        _encode_string(name),
        _encode_string(version),
        _encode_string(chain_name),
        _encode_bytes32(contract_package_hash_hex),
    ]
    return keccak256(b"".join(parts))


def _hash_struct(frm: str, to: str, value: int, valid_after: int, valid_before: int, nonce_hex: str) -> bytes:
    parts = [
        keccak256(STRUCT_TYPE),
        _encode_address(frm),
        _encode_address(to),
        _encode_uint256(value),
        _encode_uint256(valid_after),
        _encode_uint256(valid_before),
        _encode_bytes32(nonce_hex),
    ]
    return keccak256(b"".join(parts))


def transfer_with_auth_digest(*, name, version, chain_name, asset, frm, to, value, valid_after, valid_before, nonce_hex) -> bytes:
    """The 32-byte EIP-712 digest for a TransferWithAuthorization, matching the TS client."""
    domain_hash = _hash_domain(name, version, chain_name, "0x" + asset)
    struct_hash = _hash_struct(frm, to, value, valid_after, valid_before, nonce_hex)
    return keccak256(b"\x19\x01" + domain_hash + struct_hash)


@dataclass
class CasperKey:
    """A Casper ed25519 key loaded from a PKCS8 PEM (the format cascet keys use)."""
    _sk: Ed25519PrivateKey
    public_key_bytes: bytes  # raw 32-byte ed25519 public key

    @classmethod
    def from_pem(cls, path: str) -> "CasperKey":
        with open(path, "rb") as f:
            sk = load_pem_private_key(f.read(), password=None)
        if not isinstance(sk, Ed25519PrivateKey):
            raise ValueError("expected an ed25519 key")
        from cryptography.hazmat.primitives import serialization
        pub = sk.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
        return cls(sk, pub)

    def public_key_hex(self) -> str:
        return "01" + self.public_key_bytes.hex()          # 01 = ed25519 tag

    def account_hash(self) -> bytes:
        # Casper: blake2b-256( b"ed25519" + 0x00 + public_key_bytes )
        h = hashlib.blake2b(digest_size=32)
        h.update(b"ed25519" + b"\x00" + self.public_key_bytes)
        return h.digest()

    def account_hash_hex(self) -> str:
        return self.account_hash().hex()

    def account_address(self) -> str:
        return "00" + self.account_hash_hex()               # 00 tag + 32-byte hash

    def sign(self, digest: bytes) -> bytes:
        # ed25519 signs the message directly; Casper prepends the algo tag (0x01).
        return b"\x01" + self._sk.sign(digest)


def build_payment_payload(*, key: CasperKey, requirements: dict, valid_after: int, valid_before: int, nonce: bytes | None = None) -> dict:
    """
    Build the x402 payment payload for a CasCet gateway 402 challenge.

    `requirements` is one entry from the 402 response `accepts` list (has
    payTo, asset, amount, network, extra.name, extra.version).
    """
    if nonce is None:
        nonce = secrets.token_bytes(32)
    nonce_hex = nonce.hex()
    frm = "0x" + key.account_address()
    to = "0x" + requirements["payTo"]
    digest = transfer_with_auth_digest(
        name=requirements["extra"]["name"],
        version=requirements["extra"]["version"],
        chain_name=requirements["network"],
        asset=requirements["asset"],
        frm=frm, to=to,
        value=int(requirements["amount"]),
        valid_after=valid_after, valid_before=valid_before,
        nonce_hex=nonce_hex,
    )
    signature = key.sign(digest)
    return {
        "x402Version": 2,
        "payload": {
            "signature": signature.hex(),
            "publicKey": key.public_key_hex(),
            "authorization": {
                "from": key.account_address(),
                "to": requirements["payTo"],
                "value": str(requirements["amount"]),
                "validAfter": str(valid_after),
                "validBefore": str(valid_before),
                "nonce": nonce_hex,
            },
        },
    }
