"""
CasCet x402 client for Python.

Lets a Python program (an AI agent) pay an x402 v2 challenge on Casper. It signs
an EIP-712 `TransferWithAuthorization` with a Casper ed25519 key and builds the
payment payload that a CasCet gateway (in the `PAYMENT-SIGNATURE` request
header) or a facilitator (`/verify`, `/settle`) expects.

The digest, signature and payload match the TypeScript client
(`@casper-ecosystem/casper-eip-712` with `@x402/casper` 2.29 and `@x402/core`
2.29, and before them `@make-software/casper-x402` 1.0.0 and `@x402/core`
2.17) byte for byte for the same validity window, and so does the header for
the same input JSON (numbers written with a fraction or an exponent excepted:
Python writes 300.0 where JavaScript writes 300, which decodes to the same
value). `tests/eip712_vectors.json` and `tests/x402_casper_2_29_vectors.json`
hold vectors produced by those packages and `tests/test_vectors.py` checks
this module against them.

Both token authorization styles are paid the same way. A "legacy-amount"
token (CasCet's own x402 token) and a "cep3009-value" token (the official
Wrapped CSPR and other CEP-3009 tokens) verify the same EIP-712
`TransferWithAuthorization` message; only the argument name the facilitator
passes to the token's `transfer_with_authorization` differs. A CasCet gateway
names the style in each `accepts` entry's `extra.authorizationStyle`; this
client echoes it in `accepted`, refuses values it does not know, and can
prefer one style over the other.

Two layers:

* Protocol helpers with no budget: `parse_payment_required` (reads the 402's
  `PAYMENT-REQUIRED` header), `select_requirement` (picks the `accepts` entry
  to pay by network, payee and asset allowlists and style preference),
  `build_payment_payload` (signs one `accepts` entry and echoes it as
  `accepted`), `payment_signature_header`.
* `PayingClient`: the same guard rails as the TypeScript `createPayingFetch`
  around a 402 -> sign -> retry flow: network, payTo and asset allowlists,
  strict amount parsing, per-call and per-asset session budgets, a cap on how
  long a signed authorization stays valid, and a deadline for the whole call.
  It never follows redirects and refuses to pay over plain HTTP to a
  non-loopback host.

Deps: cryptography (ed25519 PEM), pycryptodome (keccak-256); requests is only
needed by `PayingClient`.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import copy
import hashlib
import ipaddress
import json
import math
import os
import re
import secrets
import sys
import threading
import time
import warnings
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import TYPE_CHECKING, Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple, Union
from urllib.parse import urlsplit

from Crypto.Hash import keccak as _keccak
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import load_pem_private_key

if TYPE_CHECKING:  # pragma: no cover - typing only
    import requests

__all__ = [
    "X402_VERSION",
    "SCHEME_EXACT",
    "NETWORK_CASPER_MAINNET",
    "NETWORK_CASPER_TESTNET",
    "DEFAULT_NETWORKS",
    "DEFAULT_TIMEOUT_SECONDS",
    "MAX_VALIDITY_SECONDS",
    "HEADER_PAYMENT_SIGNATURE",
    "HEADER_PAYMENT_REQUIRED",
    "HEADER_PAYMENT_RESPONSE",
    "HEADER_CASCET_PARENT_ID",
    "HEADER_CASCET_PAYMENT_ID",
    "AUTHORIZATION_STYLES",
    "AUTHORIZATION_STYLE_EXTRA_KEY",
    "LEGACY_AMOUNT_TOKENS",
    "KNOWN_CEP3009_ASSETS",
    "CONTRACT_PAYEE_REASON",
    "HOSTED_FACILITATOR_HOST",
    "X402Error",
    "ProtocolError",
    "PaymentAborted",
    "InsecurePaymentConfigWarning",
    "keccak256",
    "transfer_with_auth_digest",
    "CasperKey",
    "account_hash_from_public_key",
    "pay_to_from_public_key",
    "normalize_pay_to",
    "normalize_asset",
    "default_authorization_style",
    "authorization_style",
    "is_hosted_facilitator_url",
    "parse_amount",
    "validate_requirements",
    "select_requirement",
    "build_payment_payload",
    "payment_signature_header",
    "decode_payment_signature_header",
    "decode_payment_required_header",
    "parse_payment_required",
    "parse_payment_response",
    "PayingClient",
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

#: Networks a PayingClient pays on unless told otherwise (TS client default too).
DEFAULT_NETWORKS: Tuple[str, ...] = (NETWORK_CASPER_TESTNET,)
#: Deadline for one PayingClient call (first request, 402, signing, paid retry
#: and reading the response), the TypeScript client's `timeoutMs: 30000`.
DEFAULT_TIMEOUT_SECONDS = 30.0
#: By default validAfter is back-dated by this much to tolerate clock skew, as
#: @make-software/casper-x402 1.0.0 did. @x402/casper 2.29, the TypeScript
#: client since the 2.29 migration, signs validAfter 0: pass valid_after=0 to
#: build_payment_payload for byte parity with it.
VALID_AFTER_SKEW_SECONDS = 600
#: Upper bound on how long a signed authorization stays valid, whatever
#: `maxTimeoutSeconds` a server asks for (a hostile 402 could ask for years).
#: The TS client's `maxAuthorizationSeconds` default.
MAX_VALIDITY_SECONDS = 900

# ---- token authorization styles (same names and values as @cascet/core) ----
#: How a token's `transfer_with_authorization` takes the amount. Both styles
#: verify the same EIP-712 message, so this client signs them the same way:
#: "legacy-amount" tokens (CasCet's own x402 token) take `amount`,
#: "cep3009-value" tokens (the official Wrapped CSPR, other CEP-3009 tokens)
#: take `value`. Only the facilitator that settles the payment cares.
AUTHORIZATION_STYLES: Tuple[str, ...] = ("legacy-amount", "cep3009-value")
#: Key of the style in an `accepts` entry's `extra`. The gateway sets it; a
#: client echoes it in `accepted`, may prefer a style and refuses values it
#: does not know. Facilitators must not rely on it: the token's ABI decides.
AUTHORIZATION_STYLE_EXTRA_KEY = "authorizationStyle"
#: Known tokens whose `transfer_with_authorization` takes `amount`: bare
#: package hash -> CAIP-2 network. Both are CasCet's x402 token ("CasCet X402
#: Token"), as in @cascet/core's LEGACY_AMOUNT_TOKENS.
LEGACY_AMOUNT_TOKENS: Mapping[str, str] = MappingProxyType({
    "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3": NETWORK_CASPER_TESTNET,
    "8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41": NETWORK_CASPER_MAINNET,
})
#: Known tokens whose `transfer_with_authorization` takes `value` (CEP-3009):
#: CAIP-2 network -> bare package hashes, the official Wrapped CSPR on each
#: network, as in @cascet/core's KNOWN_CEP3009_ASSETS.
KNOWN_CEP3009_ASSETS: Mapping[str, Tuple[str, ...]] = MappingProxyType({
    NETWORK_CASPER_MAINNET: ("8df5d26790e18cf0404502c62ce5dc9025800ad6975c97466e20506c39c505b6",),
    NETWORK_CASPER_TESTNET: ("3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e",),
})
#: Why a "01" payTo (a contract package, or a public key passed off as one) is
#: never paid, worded as in @cascet/client's CONTRACT_PAYEE_REASON.
CONTRACT_PAYEE_REASON = (
    "contract-package payees are not paid: @make-software/casper-x402 1.0.0 facilitators credit the payment "
    "to an account nobody controls, and CasCet's self-hosted facilitator refuses them"
)
#: Host of the hosted CSPR.cloud x402 facilitator. It takes the raw CSPR.cloud
#: access key in the Authorization header (never "Bearer <key>") and settles
#: only "cep3009-value" tokens.
HOSTED_FACILITATOR_HOST = "x402-facilitator.cspr.cloud"

_U64_MAX = 2**64 - 1
_U256_LIMIT = 2**256
_HEX64_RE = re.compile(r"[0-9a-fA-F]{64}")
_KEY_RE = re.compile(r"(?:00|01)[0-9a-fA-F]{64}")  # serialized Casper Key: tag + 32 bytes
_DIGITS_RE = re.compile(r"[0-9]{1,40}")  # ASCII digits only; used with fullmatch
_BASE64_RE = re.compile(r"[A-Za-z0-9+/]*={0,2}")
#: CAIP-2 id in the casper namespace (the TS client's pattern); no wildcards.
_CASPER_NETWORK_RE = re.compile(r"casper:[-_a-zA-Z0-9]{1,32}")
_SURROGATE_RE = re.compile("[\ud800-\udfff]")
#: Largest deadline accepted, the TS client's limit of 2^31 - 1 ms.
_MAX_TIMEOUT_SECONDS = 2_147_483.647


# ---- errors ----
class X402Error(Exception):
    """Base class for the errors this module raises."""


class ProtocolError(X402Error, ValueError):
    """A 402 challenge, x402 header or payment requirement is malformed."""


class PaymentAborted(X402Error):
    """The client refused to sign a payment (policy, budget or unsafe transport)."""


class InsecurePaymentConfigWarning(UserWarning):
    """A PayingClient was built without allowlists or without a budget."""


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


def _parse_budget(value: Union[int, str, None], what: str) -> Optional[int]:
    """A budget in raw token units, > 0 like the TS client's parseRawAmount (None = no budget)."""
    if value is None:
        return None
    if isinstance(value, int) and not isinstance(value, bool):
        if not 0 <= value < 10**40:
            raise ValueError(f"{what} must be between 1 and 10^40 - 1 raw units, got {value!r}")
        budget = value
    elif isinstance(value, str) and _DIGITS_RE.fullmatch(value):
        budget = int(value)
    else:
        raise ValueError(f"{what} must be raw token units as an int or a string of 1-40 ASCII digits, got {value!r}")
    if budget == 0:
        raise ValueError(f"{what} must be greater than zero, got {value!r} (leave it unset for no limit)")
    return budget


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


def default_authorization_style(package_hash: str) -> str:
    """The style assumed for a token that names none, as @cascet/core's defaultAuthorizationStyle.

    A known CasCet x402 token (LEGACY_AMOUNT_TOKENS) is "legacy-amount"; every
    other token "cep3009-value", the CEP-3009 standard. `package_hash` takes
    the forms normalize_asset accepts; anything else raises ValueError.
    """
    return "legacy-amount" if normalize_asset(package_hash) in LEGACY_AMOUNT_TOKENS else "cep3009-value"


def known_authorization_style(package_hash: Any, network: Any) -> Optional[str]:
    """The style this client knows for a token on `network`, or None.

    CasCet's x402 tokens (LEGACY_AMOUNT_TOKENS) are "legacy-amount" and the
    official Wrapped CSPR (KNOWN_CEP3009_ASSETS) is "cep3009-value", each on
    its own network only. Anything unparsable is None.
    """
    if not isinstance(package_hash, str) or not isinstance(network, str):
        return None
    try:
        asset = normalize_asset(package_hash)
    except ValueError:
        return None
    if LEGACY_AMOUNT_TOKENS.get(asset) == network:
        return "legacy-amount"
    if asset in KNOWN_CEP3009_ASSETS.get(network, ()):
        return "cep3009-value"
    return None


def _effective_style(requirements: Mapping[str, Any]) -> str:
    """
    The style an `accepts` entry ranks under: the style this client knows for
    CasCet's x402 tokens and Wrapped CSPR, whatever the gateway labels them (so
    a gateway cannot steer `prefer_styles` by mislabeling them), else the
    advertised style, else default_authorization_style(asset).
    """
    return (
        known_authorization_style(requirements.get("asset"), requirements.get("network"))
        or authorization_style(requirements)
        or default_authorization_style(requirements["asset"])
    )


def _show(value: Any) -> str:
    """repr() of a value from a server, shortened for error messages."""
    text = repr(value)
    return text if len(text) <= 80 else text[:77] + "..."


def authorization_style(requirements: Mapping[str, Any]) -> Optional[str]:
    """
    The authorization style one `accepts` entry advertises in
    `extra.authorizationStyle`, or None when it names none (a gateway from
    before the field existed).

    Raises ProtocolError (a ValueError) for any other value: a style this
    client does not know means terms it cannot judge, so it is never paid.
    """
    extra = requirements.get("extra") if isinstance(requirements, Mapping) else None
    if not isinstance(extra, Mapping) or AUTHORIZATION_STYLE_EXTRA_KEY not in extra:
        return None
    style = extra[AUTHORIZATION_STYLE_EXTRA_KEY]
    if not isinstance(style, str) or style not in AUTHORIZATION_STYLES:
        raise ProtocolError(
            f"extra.{AUTHORIZATION_STYLE_EXTRA_KEY} {_show(style)} is not an authorization style this client knows "
            f"({', '.join(AUTHORIZATION_STYLES)})"
        )
    return style


def is_hosted_facilitator_url(url: str) -> bool:
    """Whether `url` points at the hosted CSPR.cloud facilitator (HOSTED_FACILITATOR_HOST). False for anything unparsable.

    That facilitator takes the raw access key in the Authorization header, never "Bearer <key>".
    """
    if not isinstance(url, str):
        return False
    try:
        host = urlsplit(url.strip()).hostname
    except ValueError:
        return False
    if not host:
        return False
    if host.endswith("."):
        host = host[:-1]
    return host == HOSTED_FACILITATOR_HOST


def _nonempty_text(value: Any) -> bool:
    # A lone surrogate (valid in JSON, "\ud800") has no UTF-8 form, so it cannot be hashed into the domain.
    return isinstance(value, str) and value != "" and not _SURROGATE_RE.search(value)


def _max_timeout_seconds(value: Any) -> int:
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ProtocolError(f"maxTimeoutSeconds must be a positive integer, got {value!r}")
    return value


def validate_requirements(requirements: Mapping[str, Any]) -> None:
    """Check that one `accepts` entry is a well-formed Casper `exact` requirement.

    Raises ProtocolError (a ValueError) naming the bad field. These are the
    checks the TS scheme and the facilitator apply, done before anything is
    signed, plus the TS client's: an `extra.authorizationStyle` it does not
    know is refused.
    """
    if not isinstance(requirements, Mapping):
        raise ProtocolError("payment requirements must be a JSON object")
    scheme = requirements.get("scheme")
    if scheme != SCHEME_EXACT:
        raise ProtocolError(f"unsupported scheme {scheme!r} (only 'exact' is implemented)")
    network = requirements.get("network")
    if not isinstance(network, str) or not _CASPER_NETWORK_RE.fullmatch(network):
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
    if not isinstance(extra, Mapping) or not _nonempty_text(extra.get("name")) or not _nonempty_text(extra.get("version")):
        raise ProtocolError(
            "extra.name and extra.version (the token's EIP-712 domain) must be non-empty strings "
            "(without lone UTF-16 surrogates)"
        )
    authorization_style(requirements)
    if "maxTimeoutSeconds" in requirements:
        _max_timeout_seconds(requirements["maxTimeoutSeconds"])


def _check_u64(value: Any, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= _U64_MAX:
        raise ValueError(f"{what} must be an integer unix time between 0 and 2^64 - 1, got {value!r}")
    return value


# ---- choosing what to pay ----
def _normalize_allowed_pay_to(value: Any) -> str:
    """An allowlist payee as normalize_pay_to returns it; a contract package is a config error (CONTRACT_PAYEE_REASON)."""
    pay_to = normalize_pay_to(value)
    if not pay_to.startswith("00"):
        raise ValueError(
            f"{value!r} is a contract-package payee: {CONTRACT_PAYEE_REASON}. Allowlist an account hash instead."
        )
    return pay_to


def _allowlist(values: Optional[Union[str, Iterable[str]]], normalize: Callable[[Any], str]) -> Optional[frozenset]:
    """A normalized allowlist; None means "no allowlist" and an empty list allows nothing."""
    if values is None:
        return None
    return frozenset(normalize(value) for value in _as_list(values))


def _networks_tuple(networks: Optional[Union[str, Iterable[str]]]) -> Tuple[str, ...]:
    if networks is None:
        networks = DEFAULT_NETWORKS
    nets = [_normalize_network(network) for network in _as_list(networks)]
    if not nets:
        raise ValueError("networks must name at least one network")
    return tuple(dict.fromkeys(nets))


def _prefer_styles_tuple(prefer_styles: Optional[Union[str, Iterable[str]]]) -> Tuple[str, ...]:
    if prefer_styles is None:
        return ()
    styles = []
    for style in _as_list(prefer_styles):
        candidate = style.strip() if isinstance(style, str) else style
        if not isinstance(candidate, str) or candidate not in AUTHORIZATION_STYLES:
            raise ValueError(
                f"unknown authorization style {style!r} in prefer_styles (known: {', '.join(AUTHORIZATION_STYLES)})"
            )
        styles.append(candidate)
    return tuple(dict.fromkeys(styles))


def _policy_reject_reason(
    requirements: Any,
    networks: Tuple[str, ...],
    allowed_pay_to: Optional[frozenset],
    allowed_assets: Optional[frozenset],
) -> Optional[str]:
    """Why one `accepts` entry may not be paid under these networks and allowlists, or None."""
    try:
        validate_requirements(requirements)
    except ProtocolError as exc:
        return str(exc)
    network = requirements["network"]
    if network not in networks:
        return f"network {network} is not allowed (allowed: {', '.join(networks)})"
    pay_to = requirements["payTo"].lower()
    # Checked before the allowlist and never overridable by it, like the TS client.
    if not pay_to.startswith("00"):
        return (
            f"payTo {requirements['payTo']} carries the 01 tag (a contract package, or a public key used where "
            f"an account hash belongs): {CONTRACT_PAYEE_REASON}"
        )
    if allowed_pay_to is not None and pay_to not in allowed_pay_to:
        return f"payTo {requirements['payTo']} is not allowlisted"
    asset = requirements["asset"].lower()
    if allowed_assets is not None and asset not in allowed_assets:
        return f"asset {requirements['asset']} is not allowlisted"
    return None


def _by_style_preference(candidates: List[Any], prefer_styles: Tuple[str, ...]) -> List[Any]:
    """
    `candidates` (valid `accepts` entries) ordered by `prefer_styles`; entries
    of the same rank keep the server's order. Each entry ranks under
    _effective_style: a known token's own style, else the advertised one, else
    default_authorization_style(asset).
    """
    if not prefer_styles:
        return list(candidates)

    def rank(requirements: Any) -> int:
        style = _effective_style(requirements)
        return prefer_styles.index(style) if style in prefer_styles else len(prefer_styles)

    return sorted(candidates, key=rank)  # stable


def select_requirement(
    accepts: Any,
    allowed_assets: Optional[Union[str, Iterable[str]]],
    allowed_pay_to: Optional[Union[str, Iterable[str]]],
    networks: Optional[Union[str, Iterable[str]]] = DEFAULT_NETWORKS,
    prefer_styles: Optional[Union[str, Iterable[str]]] = None,
) -> Any:
    """
    Pick the entry of a 402's `accepts` list to pay, without budgets.

    An entry qualifies when it is a well-formed Casper `exact` requirement
    (validate_requirements: scheme "exact", amount, extra.name/version, and a
    known `extra.authorizationStyle` if it names one), is on one of `networks`
    (default: testnet only), pays an account ("00" + account hash: a "01"
    contract-package payee is always refused, see CONTRACT_PAYEE_REASON), and
    its payTo and asset are in `allowed_pay_to` and `allowed_assets`.

    * `allowed_assets`, `allowed_pay_to`: lists in the forms normalize_asset
      and normalize_pay_to accept. Pass None explicitly for no allowlist (any
      asset, or any account payee): a hostile or man-in-the-middled 402 then
      picks the token or the payee. A contract-package entry (hash-<64 hex>)
      in `allowed_pay_to` raises ValueError.
    * `prefer_styles`: authorization styles in order of preference, for
      example ["cep3009-value"]. Qualifying entries are sorted by it, entries
      of the same rank keep the server's order, and the first one is returned.
      CasCet's x402 tokens and Wrapped CSPR rank under the style this client
      knows for them (known_authorization_style), whatever the gateway
      advertises; an entry without `extra.authorizationStyle` ranks as its
      asset's default_authorization_style. A preference never makes an entry
      qualify.

    Returns the chosen entry itself (pass it unchanged to build_payment_payload,
    which echoes it as `accepted`). Raises PaymentAborted, listing why each
    entry was refused, when none qualifies, and ValueError for invalid
    arguments. Budgets and the validity cap are PayingClient's job;
    build_payment_payload still caps the window at max_validity_seconds.
    """
    nets = _networks_tuple(networks)
    payees = _allowlist(allowed_pay_to, _normalize_allowed_pay_to)
    assets = _allowlist(allowed_assets, normalize_asset)
    styles = _prefer_styles_tuple(prefer_styles)
    if not isinstance(accepts, (list, tuple)) or not accepts:
        raise PaymentAborted("the 402 offers no payment requirements")
    candidates = []
    reasons = []
    for index, requirements in enumerate(accepts):
        reason = _policy_reject_reason(requirements, nets, payees, assets)
        if reason is None:
            candidates.append(requirements)
        else:
            reasons.append(f"accepts[{index}]: {reason}")
    if not candidates:
        raise PaymentAborted("refusing to pay: " + "; ".join(reasons))
    return _by_style_preference(candidates, styles)[0]


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
    max_validity_seconds: int = MAX_VALIDITY_SECONDS,
) -> dict:
    """
    Build the x402 v2 payment payload for one entry of a 402's `accepts` list.

    The result is what the TypeScript client sends: `x402Version`, the signed
    `payload`, the 402's `resource` (and `extensions`) when given, and
    `accepted`, a copy of `requirements` exactly as advertised (including
    `maxTimeoutSeconds` and all of `extra`, such as `extra.authorizationStyle`).
    A CasCet gateway only accepts a payment whose `accepted` equals one of its
    `accepts` entries, and the facilitator reads `accepted.scheme` /
    `accepted.network`. Both authorization styles are signed the same way;
    an `extra.authorizationStyle` this client does not know raises
    ProtocolError (a ValueError).

    Pass `requirements` unchanged from the 402. Without `valid_before` the
    authorization expires at `now + maxTimeoutSeconds`, capped at
    `max_validity_seconds` (default MAX_VALIDITY_SECONDS, 900). Without
    `valid_after` it is valid from `now - 600`, back-dated for clock skew as
    @make-software/casper-x402's client did. `valid_after` may be 0, which is
    what @x402/casper 2.29's client (the TypeScript client since the 2.29
    migration) signs: pass `valid_after=0` for the same payload byte for byte.
    The CasCet gateway and facilitator, and @x402/casper's facilitator, accept
    both.

    This applies no spending policy: use select_requirement or PayingClient
    for allowlists, and PayingClient for budgets.
    """
    if isinstance(max_validity_seconds, bool) or not isinstance(max_validity_seconds, int) or max_validity_seconds <= 0:
        raise ValueError(f"max_validity_seconds must be a positive whole number of seconds, got {max_validity_seconds!r}")
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
        valid_before = now + min(_max_timeout_seconds(requirements["maxTimeoutSeconds"]), max_validity_seconds)
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


def _parse_finite_float(text: str) -> float:
    value = float(text)
    if not math.isfinite(value):  # "1e400" parses to inf, which JSON cannot carry back
        raise ValueError(f"number {text[:40]} is out of range")
    return value


def _escape_surrogate(match: re.Match) -> str:
    return "\\u%04x" % ord(match.group())


def _b64_json_encode(obj: Any) -> str:
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    # JSON can carry a lone UTF-16 surrogate ("\ud800") but UTF-8 cannot. Escape it
    # the way JSON.stringify does (lowercase \uXXXX), so the header still encodes.
    text = _SURROGATE_RE.sub(_escape_surrogate, text)
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


#: x402 objects are a few levels deep; deeper JSON from a server is refused so
#: copying or re-encoding it can never hit the recursion limit.
_MAX_JSON_DEPTH = 32


def _json_depth(obj: Any) -> int:
    deepest, stack = 0, [(obj, 1)]
    while stack:
        node, depth = stack.pop()
        if isinstance(node, (dict, list)):
            deepest = max(deepest, depth)
            if depth <= _MAX_JSON_DEPTH:
                stack.extend((child, depth + 1) for child in (node.values() if isinstance(node, dict) else node))
    return deepest


def _b64_json_decode(value: Any, what: str) -> Any:
    if not isinstance(value, str):
        raise ProtocolError(f"{what} header must be a string")
    value = value.strip()
    if not _BASE64_RE.fullmatch(value):
        raise ProtocolError(f"{what} header is not base64")
    try:
        raw = base64.b64decode(value + "=" * (-len(value) % 4), validate=True)
        decoded = json.loads(
            raw.decode("utf-8"), parse_constant=_reject_json_constant, parse_float=_parse_finite_float
        )
    except (binascii.Error, UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise ProtocolError(f"{what} header is not base64-encoded JSON: {exc}") from exc
    if _json_depth(decoded) > _MAX_JSON_DEPTH:
        raise ProtocolError(f"{what} header nests JSON deeper than {_MAX_JSON_DEPTH} levels")
    return decoded


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


# ---- paying client ----
_warned: set = set()


def _warn_once(kind: str, message: str) -> None:
    if kind in _warned:
        return
    _warned.add(kind)
    # stacklevel 3: attribute the warning to the code that built the PayingClient.
    warnings.warn(message, InsecurePaymentConfigWarning, stacklevel=3)


def _is_loopback_host(host: Optional[str]) -> bool:
    if not host:
        return False
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


#: A deadline in seconds for a whole PayingClient call, or None for no deadline.
Timeout = Optional[float]

_READ_CHUNK_BYTES = 64 * 1024
#: A 402's body is read (so its connection can carry the paid retry) only up to this size.
_DRAIN_LIMIT_BYTES = 64 * 1024


def _check_timeout(timeout: Any) -> Timeout:
    if timeout is None:
        return None
    if (
        isinstance(timeout, (int, float))
        and not isinstance(timeout, bool)
        and math.isfinite(timeout)
        and 0 < timeout <= _MAX_TIMEOUT_SECONDS
    ):
        return float(timeout)
    hint = ""
    if isinstance(timeout, tuple):
        hint = "; (connect, read) tuples are not supported because the timeout is a deadline for the whole call"
    raise ValueError(f"timeout must be seconds (> 0 and at most 2147483.647) or None, got {timeout!r}{hint}")


def _deadline_error(url: str, timeout: Timeout) -> Exception:
    import requests  # deferred like in PayingClient._http

    return requests.exceptions.Timeout(f"request to {url} did not complete within the {timeout:g} s deadline")


def _close_quietly(response: Any) -> None:
    close = getattr(response, "close", None)
    if callable(close):
        try:
            close()
        except Exception:  # best effort: the response is being abandoned anyway
            pass


def _read_body(response: Any, deadline: Optional[float], timeout: Timeout, url: str, limit: Optional[int] = None) -> bool:
    """
    Read a streamed requests.Response body into `response.content` before `deadline`.

    Raises requests.exceptions.Timeout once the deadline passes, so a gateway
    that sends its body a byte at a time cannot hold the caller. With urllib3
    2.3 or newer (the lock pins 2.8) a read still blocked at the deadline is
    cut off by shutting the socket down; with older versions the deadline is
    checked between chunks. Returns False, and closes the response, when the
    body is larger than `limit`. A response that is already read (or is not a
    requests.Response) is left as it is.
    """
    if getattr(response, "_content", None) is not False:
        return True
    fired = threading.Event()

    def expired() -> bool:
        return fired.is_set() or (deadline is not None and time.monotonic() >= deadline)

    watchdog = None
    shutdown = getattr(getattr(response, "raw", None), "shutdown", None)
    if deadline is not None and callable(shutdown):
        def cut_off() -> None:
            fired.set()  # set first, so a read that the shutdown cuts short always sees it
            try:
                shutdown()
            except Exception:  # already released to the pool (fully read) or closed: nothing is blocked
                pass

        watchdog = threading.Timer(max(0.0, deadline - time.monotonic()), cut_off)
        watchdog.daemon = True
        watchdog.start()
    chunks: List[bytes] = []
    size = 0
    try:
        for chunk in response.iter_content(_READ_CHUNK_BYTES):
            if expired():
                break
            size += len(chunk)
            if limit is not None and size > limit:
                _close_quietly(response)
                return False
            chunks.append(chunk)
    except Exception as exc:
        _close_quietly(response)
        if expired():
            raise _deadline_error(url, timeout) from exc
        raise
    finally:
        if watchdog is not None:
            watchdog.cancel()
    if expired():  # never hand back a body that the deadline may have cut short
        _close_quietly(response)
        raise _deadline_error(url, timeout)
    response._content = b"".join(chunks)
    response._content_consumed = True
    return True


def _call_before(deadline: float, url: str, timeout: Timeout, call: Callable[[], Any]) -> Any:
    """
    Run `call` (one streamed request: it returns once the status line and the
    headers are in) on a helper thread, and stop waiting for it at `deadline`.

    requests' timeouts bound each socket operation, not the whole exchange: a
    server that sends its status line and headers a byte at a time, or a slow
    DNS lookup (which ignores socket timeouts), could otherwise hold the caller
    past the deadline. An abandoned call is left to finish in the background:
    each of its socket reads is still bounded by the time that was left when it
    started, and a response that arrives after the caller gave up is closed
    unread. A paid retry abandoned this way may still settle.
    """
    state: Dict[str, Any] = {}
    lock = threading.Lock()
    done = threading.Event()

    def run() -> None:
        try:
            result = call()
        except BaseException as exc:  # handed to the waiting caller below
            with lock:
                state["error"] = exc
        else:
            with lock:
                abandoned = state.get("abandoned", False)
                if not abandoned:
                    state["result"] = result
            if abandoned:
                _close_quietly(result)
        finally:
            done.set()

    threading.Thread(target=run, name="cascet-x402-request", daemon=True).start()
    try:
        done.wait(max(0.0, deadline - time.monotonic()))
    finally:
        with lock:
            if "result" not in state and "error" not in state:
                state["abandoned"] = True
    if "error" in state:
        raise state["error"]
    if "result" in state:
        return state["result"]
    raise _deadline_error(url, timeout)


def _split_env(value: Optional[str]) -> List[str]:
    return [part.strip() for part in (value or "").split(",") if part.strip()]


def _env_value(env: Mapping[str, str], name: str) -> Optional[str]:
    """The trimmed value of an environment variable, or None when it is unset or blank."""
    return (env.get(name) or "").strip() or None


def _is_set(value: Optional[str]) -> bool:
    """An opt-out flag as `cascet connect` reads it: 1, true or yes, in any case."""
    return (value or "").strip().lower() in {"1", "true", "yes"}


def _normalize_network(network: Any) -> str:
    candidate = network.strip() if isinstance(network, str) else network
    if not isinstance(candidate, str) or not _CASPER_NETWORK_RE.fullmatch(candidate):
        raise ValueError(
            f"invalid network {network!r}: use a CAIP-2 Casper id such as 'casper:casper-test' or 'casper:casper' "
            "(wildcards are not allowed)"
        )
    return candidate


class PayingClient:
    """
    HTTP client that answers x402 challenges with Casper payments, within limits.

    The Python counterpart of the TypeScript `createPayingFetch`:

    * `networks`: CAIP-2 networks it pays on (default: testnet only). A 402 on
      any other network is refused.
    * `allowed_pay_to` / `allowed_assets`: only pay these sellers in these
      tokens. Leaving either out logs a warning, because then a hostile or
      man-in-the-middled 402 picks the payee or the token. A '01'-tagged payTo
      (a contract package, or a public key pasted where an account hash
      belongs) is always refused, and a contract-package entry (hash-<64 hex>)
      in `allowed_pay_to` raises ValueError (see CONTRACT_PAYEE_REASON).
    * `prefer_styles`: authorization styles in order of preference (for
      example ["cep3009-value"]) when a 402 offers several acceptable entries;
      see select_requirement. Without it the first acceptable entry is paid.
      An `accepts` entry whose `extra.authorizationStyle` is not one of
      AUTHORIZATION_STYLES is never paid.
    * `max_per_call_raw` / `max_session_raw`: budgets in raw token units
      (greater than zero); the session budget is tracked per asset. Spend is
      counted when an authorization is signed (a signed authorization can be
      settled even if the server then fails), and never refunded.
    * `max_authorization_seconds`: longest validity window it signs (default
      900, the TS default). An `accepts` entry without a positive whole
      `maxTimeoutSeconds`, or with a longer one, is refused.
    * `timeout`: deadline in seconds for a whole call: the first request, the
      402, signing, the paid retry and reading the response (default 30, like
      the TS `timeoutMs`). Every connect and socket read is also bounded by
      the time left, and the status line and headers are awaited on a helper
      thread, so a server that trickles them (or a slow DNS lookup) cannot
      hold the call past the deadline. None disables it. A call that times
      out after the paid retry was sent may still settle.
    * `allow_insecure_http`: pay over plain http:// to a non-loopback host only
      when this is True.
    * `parent_id`: sent as x-cascet-parent-id so a cascade's receipts link up.
    * `on_payment`: called with {amount_raw, pay_to, asset, network} after each
      authorization is signed and encoded, before it is sent, plus
      authorization_style when the 402 advertised one. An exception it raises
      is reported as a RuntimeWarning and does not stop the payment.
    * `session`: a requests.Session (or compatible object honoring
      `allow_redirects=False` and `stream=True`); one is created by default.

    `request()` sends the request; on a 402 it reads PAYMENT-REQUIRED, picks an
    acceptable `accepts` entry (the first, or the first of the most preferred
    style), signs it and retries once with
    PAYMENT-SIGNATURE. A second 402 is returned as is, never paid again. It
    never follows redirects: a 3xx response comes back to the caller unpaid,
    so PAYMENT-SIGNATURE, the parent id and the request body never reach
    another origin. The request body must be replayable (json=, data=
    bytes/str/dict).
    """

    def __init__(
        self,
        key: CasperKey,
        *,
        networks: Optional[Sequence[str]] = DEFAULT_NETWORKS,
        allowed_pay_to: Optional[Sequence[str]] = None,
        allowed_assets: Optional[Sequence[str]] = None,
        prefer_styles: Optional[Sequence[str]] = None,
        max_per_call_raw: Union[int, str, None] = None,
        max_session_raw: Union[int, str, None] = None,
        max_authorization_seconds: int = MAX_VALIDITY_SECONDS,
        timeout: Timeout = DEFAULT_TIMEOUT_SECONDS,
        allow_insecure_http: bool = False,
        parent_id: Optional[str] = None,
        on_payment: Optional[Callable[[Dict[str, str]], None]] = None,
        session: Any = None,
    ) -> None:
        if not isinstance(key, CasperKey):
            raise TypeError("key must be a CasperKey")
        nets = _networks_tuple(networks)
        if (
            isinstance(max_authorization_seconds, bool)
            or not isinstance(max_authorization_seconds, int)
            or max_authorization_seconds <= 0
        ):
            raise ValueError(
                f"max_authorization_seconds must be a positive whole number of seconds, got {max_authorization_seconds!r}"
            )
        if parent_id is not None and (not isinstance(parent_id, str) or not re.fullmatch(r"[\x21-\x7e]{1,128}", parent_id)):
            raise ValueError("parent_id must be 1-128 printable ASCII characters without spaces")
        self._key = key
        self._networks: Tuple[str, ...] = nets
        self._max_authorization_seconds = max_authorization_seconds
        self._allowed_pay_to: Optional[frozenset] = _allowlist(allowed_pay_to, _normalize_allowed_pay_to)
        self._allowed_assets: Optional[frozenset] = _allowlist(allowed_assets, normalize_asset)
        self._prefer_styles: Tuple[str, ...] = _prefer_styles_tuple(prefer_styles)
        self._max_per_call = _parse_budget(max_per_call_raw, "max_per_call_raw")
        self._max_session = _parse_budget(max_session_raw, "max_session_raw")
        self._timeout = _check_timeout(timeout)
        self._allow_insecure_http = bool(allow_insecure_http)
        self._parent_id = parent_id
        self._on_payment = on_payment
        self._session = session
        self._owns_session = False
        self._spent: Dict[str, int] = {}
        self._lock = threading.Lock()

        if self._allowed_pay_to is None or self._allowed_assets is None:
            _warn_once(
                "allowlist",
                "PayingClient has no allowed_pay_to/allowed_assets: it will sign whatever payee and token a 402 "
                "names on the allowed networks. Pin the sellers and tokens you intend to pay.",
            )
        if self._max_per_call is None and self._max_session is None:
            _warn_once(
                "budget",
                "PayingClient has no max_per_call_raw/max_session_raw: spending is unlimited.",
            )

    # -- configuration from the same env vars as `cascet connect` --
    @classmethod
    def from_env(
        cls,
        environ: Optional[Mapping[str, str]] = None,
        *,
        key: Optional[CasperKey] = None,
        **kwargs: Any,
    ) -> PayingClient:
        """
        Build a client from the environment variables `cascet connect` reads.

        * CASCET_KEY_PATH: the payer's PEM key (ignored when `key` is given).
        * CASCET_KEY_ALGO: only "ed25519" is supported here; any other value
          is an error.
        * CASCET_NETWORK: comma list, default casper:casper-test.
        * CASCET_ALLOWED_PAYTO, CASCET_ALLOWED_ASSETS: comma lists, required
          unless CASCET_ALLOW_ANY_SELLER is 1, true or yes. Payees are account
          hashes; a contract package (hash-<64 hex>) is an error.
        * CASCET_PREFER_STYLES: optional comma list of authorization styles in
          order of preference (legacy-amount, cep3009-value).
        * CASCET_MAX_PER_CALL, CASCET_MAX_SESSION: raw token units (> 0),
          required unless CASCET_ALLOW_UNLIMITED_BUDGET is 1, true or yes.
        * CASCET_TIMEOUT_MS: deadline per call in milliseconds (default 30000).

        Every value is validated here, and an error names its variable.
        Keyword arguments go to PayingClient and take precedence over the
        environment. CASCET_TOOL_PINS belongs to the stdio bridge and is not
        used by this client.
        """
        env = os.environ if environ is None else environ

        def attribute(name: str, parse: Callable[..., Any], *args: Any) -> Any:
            try:
                return parse(*args)
            except ValueError as exc:
                raise ValueError(f"{name}: {exc}") from None

        key_algo = _env_value(env, "CASCET_KEY_ALGO")
        if key_algo is not None and key_algo != "ed25519":
            raise ValueError(
                f'CASCET_KEY_ALGO is "{key_algo}", but the Python client signs with ed25519 keys only '
                '(unset it or set it to "ed25519")'
            )
        if key is None:
            key_path = _env_value(env, "CASCET_KEY_PATH")
            if key_path is None:
                raise ValueError("CASCET_KEY_PATH (path to the payer's PEM private key) is required")
            key = CasperKey.from_pem(key_path)
        networks = [attribute("CASCET_NETWORK", _normalize_network, n) for n in _split_env(env.get("CASCET_NETWORK"))]

        allowed_pay_to = _split_env(env.get("CASCET_ALLOWED_PAYTO"))
        allowed_assets = _split_env(env.get("CASCET_ALLOWED_ASSETS"))
        missing = [n for n, v in (("CASCET_ALLOWED_PAYTO", allowed_pay_to), ("CASCET_ALLOWED_ASSETS", allowed_assets)) if not v]
        if missing and not _is_set(env.get("CASCET_ALLOW_ANY_SELLER")):
            raise ValueError(
                f"{' and '.join(missing)} {'are' if len(missing) > 1 else 'is'} required: list the payTo account "
                "hash(es) and the token package hash(es) you intend to pay, comma-separated "
                "(set CASCET_ALLOW_ANY_SELLER=1 to pay any seller in any token)"
            )
        for pay_to in allowed_pay_to:
            attribute("CASCET_ALLOWED_PAYTO", _normalize_allowed_pay_to, pay_to)
        for asset in allowed_assets:
            attribute("CASCET_ALLOWED_ASSETS", normalize_asset, asset)
        prefer_styles = attribute("CASCET_PREFER_STYLES", _prefer_styles_tuple, _split_env(env.get("CASCET_PREFER_STYLES")))

        max_per_call = _env_value(env, "CASCET_MAX_PER_CALL")
        max_session = _env_value(env, "CASCET_MAX_SESSION")
        missing = [n for n, v in (("CASCET_MAX_PER_CALL", max_per_call), ("CASCET_MAX_SESSION", max_session)) if v is None]
        if missing and not _is_set(env.get("CASCET_ALLOW_UNLIMITED_BUDGET")):
            raise ValueError(
                f"{' and '.join(missing)} {'are' if len(missing) > 1 else 'is'} required: set the largest single "
                "payment and the session total per token, in raw token units "
                "(set CASCET_ALLOW_UNLIMITED_BUDGET=1 to run without a budget)"
            )
        attribute("CASCET_MAX_PER_CALL", _parse_budget, max_per_call, "the per-call budget")
        attribute("CASCET_MAX_SESSION", _parse_budget, max_session, "the session budget")

        timeout_ms = _env_value(env, "CASCET_TIMEOUT_MS")
        if timeout_ms is not None:
            if not re.fullmatch(r"[0-9]{1,10}", timeout_ms) or not 0 < int(timeout_ms) <= 2_147_483_647:
                raise ValueError(
                    f'CASCET_TIMEOUT_MS must be a whole number of milliseconds (e.g. 30000); got "{timeout_ms}"'
                )
            kwargs.setdefault("timeout", int(timeout_ms) / 1000)

        options: Dict[str, Any] = {
            "networks": networks or list(DEFAULT_NETWORKS),
            "allowed_pay_to": allowed_pay_to or None,
            "allowed_assets": allowed_assets or None,
            "prefer_styles": list(prefer_styles) or None,
            "max_per_call_raw": max_per_call,
            "max_session_raw": max_session,
        }
        options.update(kwargs)
        return cls(key, **options)

    # -- policy --
    @property
    def networks(self) -> Tuple[str, ...]:
        return self._networks

    @property
    def prefer_styles(self) -> Tuple[str, ...]:
        return self._prefer_styles

    def _reject_reason(self, requirements: Any) -> Optional[str]:
        # select_requirement's rules (format, known style, network, an account payee, allowlists) ...
        reason = _policy_reject_reason(requirements, self._networks, self._allowed_pay_to, self._allowed_assets)
        if reason is not None:
            return reason
        # ... then the validity cap and the budgets.
        asset = requirements["asset"].lower()
        if "maxTimeoutSeconds" not in requirements:
            return "maxTimeoutSeconds is missing (it bounds how long the signed authorization stays valid)"
        seconds = _max_timeout_seconds(requirements["maxTimeoutSeconds"])  # well-formed: validated above
        if seconds > self._max_authorization_seconds:
            return (
                f"the authorization would stay valid for {seconds} s, above this client's "
                f"{self._max_authorization_seconds} s limit (max_authorization_seconds)"
            )
        amount = int(requirements["amount"])
        if self._max_per_call is not None and amount > self._max_per_call:
            return f"price {amount} exceeds the per-call budget {self._max_per_call}"
        if self._max_session is not None:
            spent = self._spent.get(asset, 0)
            if spent + amount > self._max_session:
                return (
                    f"price {amount} would exceed the session budget {self._max_session} "
                    f"for asset {asset} (already authorized {spent})"
                )
        return None

    def select_requirements(self, payment_required: Mapping[str, Any]) -> dict:
        """
        The `accepts` entry this client pays: the first acceptable one, or the
        first acceptable one of the most preferred style (`prefer_styles`).
        Raises PaymentAborted listing why each entry was refused when none qualifies.
        """
        accepts = payment_required.get("accepts") if isinstance(payment_required, Mapping) else None
        if not isinstance(accepts, list) or not accepts:
            raise PaymentAborted("the 402 offers no payment requirements")
        candidates = []
        reasons = []
        for index, requirements in enumerate(accepts):
            reason = self._reject_reason(requirements)
            if reason is None:
                candidates.append(requirements)
            else:
                reasons.append(f"accepts[{index}]: {reason}")
        if not candidates:
            raise PaymentAborted("refusing to pay: " + "; ".join(reasons))
        return _by_style_preference(candidates, self._prefer_styles)[0]

    def create_payment_payload(self, payment_required: Mapping[str, Any], *, now: Optional[int] = None) -> dict:
        """Pick an acceptable requirement, reserve its budget and sign it. Raises PaymentAborted."""
        return self._create_payment(payment_required, now)[0]

    def _create_payment(self, payment_required: Mapping[str, Any], now: Optional[int] = None) -> Tuple[dict, str]:
        """Reserve the budget, sign, and encode the PAYMENT-SIGNATURE header: (payload, header)."""
        with self._lock:
            requirements = self.select_requirements(payment_required)
            # Reported as the TS client does: a known token's own style, else the advertised one (or none).
            style = known_authorization_style(requirements.get("asset"), requirements.get("network")) or (
                authorization_style(requirements)  # known: select_requirements refuses any other value
            )
            asset = requirements["asset"].lower()
            amount = int(requirements["amount"])
            self._spent[asset] = self._spent.get(asset, 0) + amount
        try:
            payload = build_payment_payload(
                key=self._key,
                requirements=requirements,
                resource=payment_required.get("resource"),
                extensions=payment_required.get("extensions"),
                now=now,
                max_validity_seconds=self._max_authorization_seconds,
            )
            # Encoded here, so a payload that cannot be sent never keeps its reservation.
            header = payment_signature_header(payload)
        except BaseException:
            # Nothing was handed out, so the reservation can be released.
            with self._lock:
                self._spent[asset] -= amount
                if self._spent[asset] == 0:
                    del self._spent[asset]
            raise
        if self._on_payment is not None:
            info = {
                "amount_raw": str(amount),
                "pay_to": requirements["payTo"],
                "asset": requirements["asset"],
                "network": requirements["network"],
            }
            if style is not None:
                info["authorization_style"] = style
            try:
                self._on_payment(info)
            except Exception as exc:  # a reporting hook must not stop a payment that is already signed
                warnings.warn(f"PayingClient on_payment callback raised {exc!r}; ignored", RuntimeWarning, stacklevel=3)
        return payload, header

    def spent_raw(self, asset: str) -> int:
        """Raw units authorized so far in `asset` (hash-<hex> or bare hex)."""
        with self._lock:
            return self._spent.get(normalize_asset(asset), 0)

    def spending(self) -> Dict[str, int]:
        """Raw units authorized so far, per asset."""
        with self._lock:
            return dict(self._spent)

    # -- HTTP --
    def _http(self) -> Any:
        if self._session is None:
            import requests  # deferred: only the HTTP flow needs it

            self._session = requests.Session()
            self._owns_session = True
        return self._session

    def _check_transport(self, *urls: str) -> None:
        if self._allow_insecure_http:
            return
        for url in urls:
            parts = urlsplit(url)
            scheme = parts.scheme.lower()
            if scheme == "https" or (scheme == "http" and _is_loopback_host(parts.hostname)):
                continue
            raise PaymentAborted(
                f"refusing to pay over {scheme or '?'}:// to {parts.hostname or url}: a man-in-the-middle could "
                "rewrite the 402. Use https:// (or allow_insecure_http=True on a network you trust)."
            )

    def request(self, method: str, url: str, **kwargs: Any) -> requests.Response:
        """
        Send a request; answer a 402 with one payment within the limits, then retry once.

        Takes the keyword arguments of requests.Session.request. `timeout`
        (seconds or None) replaces the client's deadline for this call.
        `allow_redirects` is ignored: redirects are never followed. With
        `stream=True` the deadline covers the exchange up to the response
        headers, and reading the body is left to the caller.
        """
        http = self._http()
        timeout = _check_timeout(kwargs.pop("timeout", self._timeout))
        deadline = None if timeout is None else time.monotonic() + timeout
        stream = bool(kwargs.pop("stream", False))
        # Following a redirect would carry PAYMENT-SIGNATURE, the parent id and
        # the body to whatever origin the Location header names (the TS client
        # uses redirect: "error" for the same reason).
        kwargs.pop("allow_redirects", None)
        headers = dict(kwargs.pop("headers", None) or {})
        if self._parent_id and not _has_header(headers, HEADER_CASCET_PARENT_ID):
            headers[HEADER_CASCET_PARENT_ID] = self._parent_id

        response = self._send(http, method, url, headers, kwargs, deadline, timeout)
        if response.status_code != 402 or _has_header(headers, HEADER_PAYMENT_SIGNATURE):
            return self._finish(response, stream, deadline, timeout, url)
        try:
            self._check_transport(url, getattr(response, "url", None) or url)
            payment_required = parse_payment_required(response)
            # Read the small 402 body so its connection can carry the paid retry.
            _read_body(response, deadline, timeout, url, limit=_DRAIN_LIMIT_BYTES)
        finally:
            _close_quietly(response)
        if deadline is not None and time.monotonic() >= deadline:
            raise _deadline_error(url, timeout)  # nothing has been signed yet
        _, header = self._create_payment(payment_required)
        headers[HEADER_PAYMENT_SIGNATURE] = header
        retry = self._send(http, method, url, headers, kwargs, deadline, timeout)
        return self._finish(retry, stream, deadline, timeout, url)

    def _send(
        self,
        http: Any,
        method: str,
        url: str,
        headers: Mapping[str, str],
        kwargs: Mapping[str, Any],
        deadline: Optional[float],
        timeout: Timeout,
    ) -> Any:
        io_timeout = None
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise _deadline_error(url, timeout)
            io_timeout = (remaining, remaining)  # connect, then each socket read: never past the deadline alone

        def call() -> Any:
            return http.request(
                method, url, headers=dict(headers), timeout=io_timeout, stream=True, allow_redirects=False, **kwargs
            )

        return call() if deadline is None else _call_before(deadline, url, timeout, call)

    @staticmethod
    def _finish(response: Any, stream: bool, deadline: Optional[float], timeout: Timeout, url: str) -> Any:
        if not stream:
            _read_body(response, deadline, timeout, url)
        return response

    def get(self, url: str, **kwargs: Any) -> requests.Response:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> requests.Response:
        return self.request("POST", url, **kwargs)

    def close(self) -> None:
        if self._owns_session and self._session is not None:
            self._session.close()
            self._session = None
            self._owns_session = False

    def __enter__(self) -> PayingClient:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


def _as_list(values: Sequence[str]) -> List[str]:
    if isinstance(values, str):
        return [values]
    return list(values)


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
