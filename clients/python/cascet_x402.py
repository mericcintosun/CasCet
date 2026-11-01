"""
CasCet x402 client for Python.

Lets a Python program (an AI agent) pay an x402 v2 challenge on Casper. It signs
an EIP-712 `TransferWithAuthorization` with a Casper ed25519 key and builds the
payment payload that a CasCet gateway (in the `PAYMENT-SIGNATURE` request
header) or a facilitator (`/verify`, `/settle`) expects.

The digest, signature, payload and header encoding match the TypeScript client
(`@casper-ecosystem/casper-eip-712` + `@make-software/casper-x402` +
`@x402/core`) byte for byte. `tests/eip712_vectors.json` holds vectors produced
by those packages and `tests/test_vectors.py` checks this module against them.

Protocol helpers: `parse_payment_required` (reads the 402's `PAYMENT-REQUIRED`
header), `build_payment_payload` (signs one `accepts` entry and echoes it as
`accepted`), `payment_signature_header`. They apply no spending policy.

Deps: cryptography (ed25519 PEM), pycryptodome (keccak-256).
"""
from __future__ import annotations

import argparse
import base64
import binascii
import copy
import hashlib
import json
import os
import re
import secrets
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional, Sequence, Union

from Crypto.Hash import keccak as _keccak
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import load_pem_private_key

__all__ = [
    "X402_VERSION",
    "SCHEME_EXACT",
    "NETWORK_CASPER_MAINNET",
    "NETWORK_CASPER_TESTNET",
    "MAX_VALIDITY_SECONDS",
    "HEADER_PAYMENT_SIGNATURE",
    "HEADER_PAYMENT_REQUIRED",
    "HEADER_PAYMENT_RESPONSE",
    "HEADER_CASCET_PARENT_ID",
    "HEADER_CASCET_PAYMENT_ID",
    "X402Error",
    "ProtocolError",
    "keccak256",
    "transfer_with_auth_digest",
    "CasperKey",
    "account_hash_from_public_key",
    "pay_to_from_public_key",
    "normalize_pay_to",
    "normalize_asset",
    "parse_amount",
    "validate_requirements",
    "build_payment_payload",
    "payment_signature_header",
    "decode_payment_signature_header",
    "decode_payment_required_header",
    "parse_payment_required",
    "parse_payment_response",
]

# ---- protocol constants (same values as @cascet/core and @x402/core) ----
X402_VERSION = 2
SCHEME_EXACT = "exact"
NETWORK_CASPER_MAINNET = "casper:casper"
NETWORK_CASPER_TESTNET = "casper:casper-test"
HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE"
HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED"
HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE"
HEADER_CASCET_PARENT_ID = "x-cascet-parent-id"
HEADER_CASCET_PAYMENT_ID = "x-cascet-payment-id"

#: validAfter is back-dated by this much to tolerate clock skew (same as the TS scheme).
VALID_AFTER_SKEW_SECONDS = 600
#: Upper bound on how long a signed authorization stays valid, whatever
#: `maxTimeoutSeconds` a server asks for (a hostile 402 could ask for years).
MAX_VALIDITY_SECONDS = 3600

_U64_MAX = 2**64 - 1
_U256_LIMIT = 2**256
_HEX64_RE = re.compile(r"[0-9a-fA-F]{64}")
_KEY_RE = re.compile(r"(?:00|01)[0-9a-fA-F]{64}")  # serialized Casper Key: tag + 32 bytes
_DIGITS_RE = re.compile(r"[0-9]{1,40}")  # ASCII digits only; used with fullmatch
_BASE64_RE = re.compile(r"[A-Za-z0-9+/]*={0,2}")


# ---- errors ----
class X402Error(Exception):
    """Base class for the errors this module raises."""


class ProtocolError(X402Error, ValueError):
    """A 402 challenge, x402 header or payment requirement is malformed."""


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
    value = int(value)
    if not 0 <= value < _U256_LIMIT:
        raise ValueError(f"uint256 out of range: {value}")
    return value.to_bytes(32, "big")


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
    """The 32-byte EIP-712 digest for a TransferWithAuthorization, matching the TS client.

    `chain_name` is the CAIP-2 network as it appears in the 402 (for example
    "casper:casper-test"): the TS scheme puts the whole string in the domain.
    """
    domain_hash = _hash_domain(name, version, chain_name, "0x" + asset)
    struct_hash = _hash_struct(frm, to, value, valid_after, valid_before, nonce_hex)
    return keccak256(b"\x19\x01" + domain_hash + struct_hash)


# ---- keys ----
def account_hash_from_public_key(public_key_hex: str) -> str:
    """Casper account hash (64 hex) of a public key: "01"+64 hex (ed25519) or "02"+66 hex (secp256k1).

    blake2b-256(algorithm name + 0x00 + raw public key), as casper-js-sdk
    `PublicKey.accountHash()` computes it.
    """
    try:
        raw = _from_hex(public_key_hex.strip())
    except (AttributeError, ValueError):
        raw = b""
    if len(raw) == 33 and raw[0] == 0x01:
        algorithm = b"ed25519"
    elif len(raw) == 34 and raw[0] == 0x02:
        algorithm = b"secp256k1"
    else:
        raise ValueError(
            f"expected a Casper public key ('01' + 64 hex for ed25519, '02' + 66 hex for secp256k1), got {public_key_hex!r}"
        )
    return hashlib.blake2b(algorithm + b"\x00" + raw[1:], digest_size=32).hexdigest()


def pay_to_from_public_key(public_key_hex: str) -> str:
    """The payTo for a public key: "00" + its account hash (what `cascet account-hash` prints)."""
    return "00" + account_hash_from_public_key(public_key_hex)


@dataclass(eq=False)
class CasperKey:
    """A Casper ed25519 key loaded from a PKCS8 PEM (the format cascet keys use)."""
    _sk: Ed25519PrivateKey = field(repr=False)
    public_key_bytes: bytes  # raw 32-byte ed25519 public key

    @classmethod
    def from_private_key(cls, sk: Ed25519PrivateKey) -> CasperKey:
        if not isinstance(sk, Ed25519PrivateKey):
            raise ValueError("expected an ed25519 key (the Python client does not support secp256k1 keys)")
        pub = sk.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        return cls(sk, pub)

    @classmethod
    def from_pem_bytes(cls, data: bytes, password: Optional[bytes] = None) -> CasperKey:
        return cls.from_private_key(load_pem_private_key(data, password=password))

    @classmethod
    def from_pem(cls, path: Union[str, os.PathLike[str]], password: Optional[bytes] = None) -> CasperKey:
        with open(path, "rb") as f:
            return cls.from_pem_bytes(f.read(), password=password)

    @classmethod
    def from_seed(cls, seed: bytes) -> CasperKey:
        """Build a key from a raw 32-byte ed25519 private key (seed)."""
        if not isinstance(seed, (bytes, bytearray)) or len(seed) != 32:
            raise ValueError("an ed25519 seed is exactly 32 bytes")
        return cls.from_private_key(Ed25519PrivateKey.from_private_bytes(bytes(seed)))

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
        if len(digest) != 32:
            raise ValueError(f"expected a 32-byte digest, got {len(digest)} bytes")
        return b"\x01" + self._sk.sign(digest)


# ---- validation and normalization ----
def parse_amount(value: Any, *, what: str = "amount") -> int:
    """Strictly parse a raw token amount from a 402: a string of 1-40 ASCII digits, greater than zero.

    `int()` would accept "-5", " 5", "5_000" and non-ASCII digits; a negative
    amount once let a hostile 402 lower the TS client's session total (M32).
    """
    if not isinstance(value, str) or not _DIGITS_RE.fullmatch(value):
        raise ProtocolError(f"{what} must be a string of 1-40 ASCII digits, got {value!r}")
    amount = int(value)
    if amount <= 0:
        raise ProtocolError(f"{what} must be greater than zero, got {value!r}")
    return amount


def normalize_pay_to(value: str) -> str:
    """Canonical lowercase form of a payTo allowlist entry: a serialized Casper Key in hex.

    * "00" + 64 hex, or "account-hash-<64 hex>"  -> "00" + hex (an account)
    * "hash-<64 hex>" or "package-hash-<64 hex>" -> "01" + hex (a contract package payee)

    A bare "01" + 64 hex or "02" + 66 hex string is refused: that is a public
    key, and paying it as a payTo sends funds to an account nobody controls.
    """
    if not isinstance(value, str):
        raise ValueError(f"payTo must be a string, got {value!r}")
    low = value.strip().lower()
    for prefix, tag in (("account-hash-", "00"), ("package-hash-", "01"), ("hash-", "01")):
        if low.startswith(prefix):
            body = low[len(prefix):]
            if _HEX64_RE.fullmatch(body):
                return tag + body
            raise ValueError(f"{value!r}: expected {prefix}<64 hex>")
    if low.startswith("0x"):
        low = low[2:]
    if len(low) == 66 and low.startswith("00") and _HEX64_RE.fullmatch(low[2:]):
        return low
    if (len(low) == 66 and low.startswith("01")) or (len(low) == 68 and low.startswith("02")):
        try:
            hint = f" Its account-hash payTo is {pay_to_from_public_key(low)}."
        except ValueError:
            hint = ""
        raise ValueError(
            f"{value!r} is a Casper public key, not a payTo.{hint} Run `npx @cascet/cli account-hash <public-key>` "
            "(or `python cascet_x402.py account-hash <public-key>`) to get the payTo; "
            "write a contract-package payee as hash-<64 hex>."
        )
    raise ValueError(
        f"{value!r} is not a payTo: expected '00' + 64 hex, account-hash-<64 hex>, hash-<64 hex> or package-hash-<64 hex>"
    )


def normalize_asset(value: str) -> str:
    """Canonical lowercase 64-hex CEP-18 contract package hash (strips hash-, package-hash-, 0x...)."""
    if not isinstance(value, str):
        raise ValueError(f"asset must be a string, got {value!r}")
    low = value.strip().lower()
    for prefix in ("hash-", "package-hash-", "contract-package-", "package-", "0x"):
        if low.startswith(prefix):
            low = low[len(prefix):]
            break
    if not _HEX64_RE.fullmatch(low):
        raise ValueError(f"{value!r} is not a CEP-18 contract package hash (64 hex, optionally hash-<64 hex>)")
    return low


def _nonempty_str(value: Any) -> bool:
    return isinstance(value, str) and value != ""


def _max_timeout_seconds(value: Any) -> int:
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ProtocolError(f"maxTimeoutSeconds must be a positive integer, got {value!r}")
    return value


def validate_requirements(requirements: Mapping[str, Any]) -> None:
    """Check that one `accepts` entry is a well-formed Casper `exact` requirement.

    Raises ProtocolError naming the bad field. These are the checks the TS
    scheme and the facilitator apply, done before anything is signed.
    """
    if not isinstance(requirements, Mapping):
        raise ProtocolError("payment requirements must be a JSON object")
    scheme = requirements.get("scheme")
    if scheme != SCHEME_EXACT:
        raise ProtocolError(f"unsupported scheme {scheme!r} (only 'exact' is implemented)")
    network = requirements.get("network")
    if not isinstance(network, str) or not network.startswith("casper:") or len(network) == len("casper:"):
        raise ProtocolError(f"network must be a Casper CAIP-2 id such as 'casper:casper-test', got {network!r}")
    pay_to = requirements.get("payTo")
    if not isinstance(pay_to, str) or not _KEY_RE.fullmatch(pay_to):
        raise ProtocolError(
            f"payTo must be a serialized Casper Key ('00' + 64 hex account hash, or '01' + 64 hex), got {pay_to!r}"
        )
    asset = requirements.get("asset")
    if not isinstance(asset, str) or not _HEX64_RE.fullmatch(asset):
        hint = ""
        if isinstance(asset, str) and asset.lower().startswith(("hash-", "0x")):
            hint = " without the 'hash-'/'0x' prefix"
        raise ProtocolError(f"asset must be the 64-hex CEP-18 contract package hash{hint}, got {asset!r}")
    parse_amount(requirements.get("amount"))
    extra = requirements.get("extra")
    if not isinstance(extra, Mapping) or not _nonempty_str(extra.get("name")) or not _nonempty_str(extra.get("version")):
        raise ProtocolError("extra.name and extra.version (the token's EIP-712 domain) must be non-empty strings")
    if "maxTimeoutSeconds" in requirements:
        _max_timeout_seconds(requirements["maxTimeoutSeconds"])


def _check_u64(value: Any, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= _U64_MAX:
        raise ValueError(f"{what} must be an integer unix time between 0 and 2^64 - 1, got {value!r}")
    return value


# ---- payment payload ----
def build_payment_payload(
    *,
    key: CasperKey,
    requirements: Mapping[str, Any],
    valid_after: Optional[int] = None,
    valid_before: Optional[int] = None,
    nonce: Optional[bytes] = None,
    resource: Optional[Mapping[str, Any]] = None,
    extensions: Optional[Mapping[str, Any]] = None,
    now: Optional[int] = None,
) -> dict:
    """
    Build the x402 v2 payment payload for one entry of a 402's `accepts` list.

    The result is what the TypeScript client sends: `x402Version`, the signed
    `payload`, the 402's `resource` (and `extensions`) when given, and
    `accepted`, a copy of `requirements` exactly as advertised (including
    `maxTimeoutSeconds` and `extra`). A CasCet gateway only accepts a payment
    whose `accepted` equals one of its `accepts` entries, and the facilitator
    reads `accepted.scheme` / `accepted.network`.

    Pass `requirements` unchanged from the 402. Without `valid_after` /
    `valid_before` the window is the TS client's: from `now - 600` to `now +
    maxTimeoutSeconds` (capped at MAX_VALIDITY_SECONDS).

    This applies no spending policy: check payTo, asset, network and amount first.
    """
    validate_requirements(requirements)
    if resource is not None and not isinstance(resource, Mapping):
        raise ProtocolError("resource must be a JSON object")
    if extensions is not None and not isinstance(extensions, Mapping):
        raise ProtocolError("extensions must be a JSON object")
    if nonce is None:
        nonce = secrets.token_bytes(32)
    if not isinstance(nonce, (bytes, bytearray)) or len(nonce) != 32:
        raise ValueError("nonce must be 32 bytes")
    if now is None:
        now = int(time.time())
    now = _check_u64(now, "now")
    if valid_after is None:
        valid_after = max(0, now - VALID_AFTER_SKEW_SECONDS)
    if valid_before is None:
        if "maxTimeoutSeconds" not in requirements:
            raise ProtocolError("requirements have no maxTimeoutSeconds: pass valid_before explicitly")
        valid_before = now + min(_max_timeout_seconds(requirements["maxTimeoutSeconds"]), MAX_VALIDITY_SECONDS)
    valid_after = _check_u64(valid_after, "valid_after")
    valid_before = _check_u64(valid_before, "valid_before")
    if valid_before <= valid_after:
        raise ValueError(f"valid_before ({valid_before}) must be later than valid_after ({valid_after})")

    nonce_hex = bytes(nonce).hex()
    frm = key.account_address()
    to = requirements["payTo"]
    amount = requirements["amount"]
    extra = requirements["extra"]
    digest = transfer_with_auth_digest(
        name=extra["name"],
        version=extra["version"],
        chain_name=requirements["network"],
        asset=requirements["asset"],
        frm="0x" + frm, to="0x" + to,
        value=int(amount),
        valid_after=valid_after, valid_before=valid_before,
        nonce_hex=nonce_hex,
    )
    signature = key.sign(digest)
    # Same key order as the TS x402Client: x402Version, payload, extensions, resource, accepted.
    result: Dict[str, Any] = {
        "x402Version": X402_VERSION,
        "payload": {
            "signature": signature.hex(),
            "publicKey": key.public_key_hex(),
            "authorization": {
                "from": frm,
                "to": to,
                "value": amount,
                "validAfter": str(valid_after),
                "validBefore": str(valid_before),
                "nonce": nonce_hex,
            },
        },
    }
    if extensions is not None:
        result["extensions"] = copy.deepcopy(dict(extensions))
    if resource is not None:
        result["resource"] = copy.deepcopy(dict(resource))
    result["accepted"] = copy.deepcopy(dict(requirements))
    return result


# ---- x402 HTTP headers (base64 of compact UTF-8 JSON, like @x402/core) ----
def _reject_json_constant(name: str) -> Any:
    raise ValueError(f"invalid JSON constant {name}")


def _b64_json_encode(obj: Any) -> str:
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def _b64_json_decode(value: Any, what: str) -> Any:
    if not isinstance(value, str):
        raise ProtocolError(f"{what} header must be a string")
    value = value.strip()
    if not _BASE64_RE.fullmatch(value):
        raise ProtocolError(f"{what} header is not base64")
    try:
        raw = base64.b64decode(value + "=" * (-len(value) % 4), validate=True)
        return json.loads(raw.decode("utf-8"), parse_constant=_reject_json_constant)
    except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
        raise ProtocolError(f"{what} header is not base64-encoded JSON: {exc}") from exc


def payment_signature_header(payload: Mapping[str, Any]) -> str:
    """Value for the `PAYMENT-SIGNATURE` request header: base64 of the payload's JSON."""
    if not isinstance(payload, Mapping):
        raise TypeError("payload must be a mapping")
    return _b64_json_encode(payload)


def decode_payment_signature_header(value: str) -> dict:
    """Inverse of payment_signature_header (handy for servers and tests)."""
    decoded = _b64_json_decode(value, HEADER_PAYMENT_SIGNATURE)
    if not isinstance(decoded, dict):
        raise ProtocolError(f"{HEADER_PAYMENT_SIGNATURE} must decode to a JSON object")
    return decoded


def decode_payment_required_header(value: str) -> dict:
    """Decode a `PAYMENT-REQUIRED` header value into the x402 v2 PaymentRequired object."""
    decoded = _b64_json_decode(value, HEADER_PAYMENT_REQUIRED)
    if not isinstance(decoded, dict):
        raise ProtocolError(f"{HEADER_PAYMENT_REQUIRED} must decode to a JSON object")
    version = decoded.get("x402Version")
    if isinstance(version, bool) or version != X402_VERSION:
        raise ProtocolError(f"unsupported x402Version {version!r} (this client speaks x402 v2)")
    if not isinstance(decoded.get("accepts"), list):
        raise ProtocolError(f"{HEADER_PAYMENT_REQUIRED} has no `accepts` list")
    return decoded


def _get_header(headers: Any, name: str) -> Optional[str]:
    getter = getattr(headers, "get", None)
    value = getter(name) if callable(getter) else None
    if value is None and isinstance(headers, Mapping):
        wanted = name.lower()
        for header_name, header_value in headers.items():
            if isinstance(header_name, str) and header_name.lower() == wanted:
                return header_value
    return value


def _has_header(headers: Mapping[str, Any], name: str) -> bool:
    wanted = name.lower()
    return any(isinstance(k, str) and k.lower() == wanted for k in headers)


def parse_payment_required(response: Any) -> dict:
    """
    Read the x402 v2 challenge from a 402 response's `PAYMENT-REQUIRED` header.

    `response` is a requests.Response (or anything with a `.headers` mapping).
    Returns the decoded PaymentRequired object: `x402Version`, `accepts` (the
    list of payment requirements), `resource`, and `error` when the server
    rejected a previous attempt. The x402 v2 HTTP transport carries the
    challenge only in this header; the 402 body is not part of the protocol.
    """
    headers = getattr(response, "headers", None)
    if headers is None:
        raise TypeError("expected an HTTP response with a .headers mapping")
    value = _get_header(headers, HEADER_PAYMENT_REQUIRED)
    if value is None:
        status = getattr(response, "status_code", "?")
        raise ProtocolError(f"HTTP {status} response has no {HEADER_PAYMENT_REQUIRED} header: not an x402 v2 challenge")
    return decode_payment_required_header(value)


def parse_payment_response(response: Any) -> Optional[dict]:
    """Decode the settlement result in a paid response's `PAYMENT-RESPONSE` header, or None if absent."""
    headers = getattr(response, "headers", None)
    if headers is None:
        raise TypeError("expected an HTTP response with a .headers mapping")
    value = _get_header(headers, HEADER_PAYMENT_RESPONSE)
    if value is None:
        return None
    decoded = _b64_json_decode(value, HEADER_PAYMENT_RESPONSE)
    if not isinstance(decoded, dict):
        raise ProtocolError(f"{HEADER_PAYMENT_RESPONSE} must decode to a JSON object")
    return decoded


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="cascet_x402.py", description="CasCet x402 helpers")
    sub = parser.add_subparsers(dest="command", required=True)
    account_hash = sub.add_parser("account-hash", help="print the payTo ('00' + account hash) for a public key")
    account_hash.add_argument("public_key", help="'01' + 64 hex (ed25519) or '02' + 66 hex (secp256k1)")
    args = parser.parse_args(argv)
    if args.command == "account-hash":
        try:
            print(pay_to_from_public_key(args.public_key))
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
