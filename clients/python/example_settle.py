"""
End-to-end proof: a Python program signs an x402 authorization with a Casper
ed25519 key and settles it on-chain through an x402 facilitator. It moves real
tokens (0.5 of the chosen token): testnet by default, mainnet with
CASCET_NET=mainnet.

Two tokens, one per authorization style. Both are signed the same way (the
same EIP-712 TransferWithAuthorization message); they differ only in the
argument the facilitator passes to the token's transfer_with_authorization:

    legacy  CasCet X402 Token ("legacy-amount": `amount`), the default.
            CasCet's self-hosted facilitator settles it and is its default
            facilitator. The hosted CSPR.cloud facilitator sends `value`,
            which this token reverts on, so that pairing is refused here.
    wcspr   Wrapped CSPR on testnet ("cep3009-value": `value`), the official
            CEP-3009 token. CasCet's self-hosted facilitator (its default
            facilitator) and the hosted facilitator both settle it. The payer
            needs a WCSPR balance: wrap some testnet CSPR first.

Both carry the symbol WCSPR; only the second is the official Wrapped CSPR.
Any facilitator other than the hosted one is taken for CasCet's self-hosted
facilitator. A refused pairing stops before anything is signed: its settle
would revert (User error 64658) and still burn the whole gas limit. The
requirements sent to the hosted facilitator leave out CasCet's own
extra.authorizationStyle, as a CasCet gateway's do (no signature covers it).

Testnet, CasCet token, self-hosted facilitator (run from the repo root; the
script finds its files from any directory):
    pnpm --filter @cascet/e2e facilitator
    clients/python/venv/bin/python clients/python/example_settle.py

Testnet, Wrapped CSPR, hosted facilitator (name it: the self-hosted
facilitator is the default for both tokens):
    CSPR_CLOUD_TOKEN=<CSPR.cloud access key> \\
    clients/python/venv/bin/python clients/python/example_settle.py --asset wcspr --facilitator hosted

Without --facilitator hosted, Wrapped CSPR goes to the self-hosted
facilitator, which settles it only once its package hash is in that
facilitator's CASCET_ALLOWED_ASSETS (by default it allows only the CasCet
token; see tools/e2e/src/run-facilitator.ts).

Mainnet (CasCet token only) has no defaults: name the payer key and the payee
yourself. The repo's demo key (tools/e2e/keys/agent.pem) is a throwaway key,
and the old demo payee was the account of the single hot deployer key. Start
the facilitator for mainnet as tools/e2e/src/run-facilitator.ts describes, then:
    CASCET_NET=mainnet CASCET_KEY_PATH=/secure/payer.pem \\
    CASCET_SELLER_ACCOUNT_HASH=00<seller account hash> CASCET_FACILITATOR_TOKEN=<token> \\
    clients/python/venv/bin/python clients/python/example_settle.py

Options (each overrides its environment variable):
    --asset legacy|wcspr          CASCET_ASSET (default legacy)
    --facilitator URL|self|hosted FACILITATOR (default self, for both tokens;
                                  self is http://127.0.0.1:4501, hosted is
                                  https://x402-facilitator.cspr.cloud)

Environment:
    CASCET_NET=mainnet           settle on Casper mainnet instead of testnet
    CASCET_ASSET                 legacy or wcspr (testnet only)
    CASCET_KEY_PATH              payer PEM; testnet default: tools/e2e/keys/agent.pem
                                 in this repo; required on mainnet
    FACILITATOR                  facilitator base URL (no query or fragment), or
                                 self / hosted
    CSPR_CLOUD_TOKEN             CSPR.cloud access key, sent raw ("Authorization:
                                 <key>", never "Bearer") and only to the hosted
                                 facilitator, which requires it
    CASCET_FACILITATOR_TOKEN     token of any other facilitator, sent as
                                 "Authorization: Bearer <token>" (the self-hosted
                                 facilitator requires it on mainnet); never sent
                                 to the hosted facilitator
    CASCET_SELLER_ACCOUNT_HASH   payee account hash (64 hex, 00 + 64 hex or
                                 account-hash-<hex>); testnet default: the demo
                                 seller; required on mainnet

A key is never sent over plain http:// to a host other than this machine. Each
key must be one line of 1-256 printable ASCII characters without spaces
(surrounding whitespace, such as the newline of a key read from a file, is
dropped); an error about a key names its variable and never shows the value.

Exit status:
    0  settled
    1  not settled: a setting or a refusal (before anything is signed), a
       facilitator that could not be reached, or a settle it reports failed
       (a hosted failure this script does not recognize, without a
       transaction hash, prints the caution of 3)
    2  invalid options
    3  outcome unknown: the request may have reached the facilitator but no
       answer came back (a timeout, a dropped connection, a TLS error other
       than a certificate that does not verify, an answer that cannot be
       parsed), or the facilitator could not tell whether the transfer
       executed (settlement_pending, settlement_unknown, the hosted
       facilitator's invalid_exact_casper_facilitator_settle_failed other than
       a revert, or a server error that does not say). The settle may still
       execute. Check the payer's token balance and the explorer before
       running again: a re-run signs a new authorization and can pay twice.
"""
from __future__ import annotations

import argparse
import ipaddress
import os
import re
import ssl
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlsplit

import requests
import urllib3
from urllib3.util.ssl_match_hostname import CertificateError

from cascet_x402 import (
    AUTHORIZATION_STYLE_EXTRA_KEY,
    NETWORK_CASPER_MAINNET,
    NETWORK_CASPER_TESTNET,
    X402_VERSION,
    CasperKey,
    build_payment_payload,
    is_hosted_facilitator_url,
    normalize_pay_to,
)

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
SELF_HOSTED_FACILITATOR_URL = "http://127.0.0.1:4501"
HOSTED_FACILITATOR_URL = "https://x402-facilitator.cspr.cloud"
FACILITATOR_SHORTHANDS = {"self": SELF_HOSTED_FACILITATOR_URL, "hosted": HOSTED_FACILITATOR_URL}
TESTNET_DEMO_SELLER = "00881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36"
TESTNET_DEMO_KEY_PATH = REPO_ROOT / "tools" / "e2e" / "keys" / "agent.pem"
EXPLORERS = {
    NETWORK_CASPER_TESTNET: "https://testnet.cspr.live/transaction/",
    NETWORK_CASPER_MAINNET: "https://cspr.live/transaction/",
}
AMOUNT = "500000000"  # 0.5 token: both tokens have 9 decimals
#: Authorization styles CasCet's self-hosted facilitator settles. It builds its
#: own settlement in each token's style (tools/e2e/src/settlement.ts): `amount`
#: for legacy-amount tokens, `value` for cep3009-value tokens such as Wrapped
#: CSPR, and refuses a token whose on-chain ABI contradicts its style.
SELF_HOSTED_SETTLE_STYLES: Tuple[str, ...] = ("legacy-amount", "cep3009-value")
#: Authorization styles the hosted CSPR.cloud facilitator settles: it passes `value`.
HOSTED_SETTLE_STYLES: Tuple[str, ...] = ("cep3009-value",)
#: (connect, read) timeouts of the /settle POST in seconds. The facilitator answers once the transaction has
#: executed (CasCet's self-hosted one waits up to 60 s by default), so the read timeout is long; a failed
#: connect sends nothing and fails fast.
SETTLE_TIMEOUT: Tuple[float, float] = (10, 120)

#: The transfer executed.
EXIT_SETTLED = 0
#: Not settled: a setting, a refusal, an unreachable facilitator or a settle the facilitator reports failed.
EXIT_FAILED = 1
#: The settle may still execute: check the payer's balance before running again.
EXIT_OUTCOME_UNKNOWN = 3
#: errorReason and extra.settlementStatus with which CasCet's self-hosted
#: facilitator answers a settle it broadcast but did not see execute, or whose
#: submission it cannot confirm (tools/e2e/src/facilitator-core.ts).
UNKNOWN_OUTCOME_REASONS = frozenset({"settlement_pending", "settlement_unknown"})
UNKNOWN_SETTLEMENT_STATUSES = frozenset({"pending", "unknown"})
#: errorReason with which @x402/casper 2.29's facilitator (the hosted facilitator runs it) answers any failure
#: after it built the transaction, without a transaction hash: signing, submitting it, or waiting for it to
#: execute ("Timed out waiting for transaction ..."). Only a revert ("transaction execution failed: ...") is final.
#: Its other invalid_exact_casper_facilitator_* reasons come before anything is submitted.
HOSTED_SETTLE_FAILED = "invalid_exact_casper_facilitator_settle_failed"
_HOSTED_REASON_PREFIX = "invalid_exact_casper_facilitator_"
_REVERTED_RE = re.compile(r"transaction execution failed", re.IGNORECASE)  # used with match: the message starts so
_TX_HASH_RE = re.compile(r"[0-9a-fA-F]{64}")
#: A facilitator key: one line of printable ASCII without spaces (used with fullmatch).
_FACILITATOR_KEY_RE = re.compile(r"[\x21-\x7e]{1,256}")
#: TLS errors raised only in the handshake, before the request is sent: a certificate that does not verify
#: (ssl's own check, or urllib3's when it matches the hostname itself).
_HANDSHAKE_ONLY_ERRORS = (ssl.SSLCertVerificationError, CertificateError)


@dataclass(frozen=True)
class Token:
    package_hash: str
    name: str  # the EIP-712 domain name: the token's on-chain name
    symbol: str
    style: str  # extra.authorizationStyle, as a CasCet gateway advertises it


#: The tokens this example pays, by --asset and network.
TOKENS: Dict[str, Dict[str, Token]] = {
    "legacy": {
        NETWORK_CASPER_TESTNET: Token(
            "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3", "CasCet X402 Token", "WCSPR", "legacy-amount"
        ),
        NETWORK_CASPER_MAINNET: Token(
            "8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41", "CasCet X402 Token", "WCSPR", "legacy-amount"
        ),
    },
    "wcspr": {
        NETWORK_CASPER_TESTNET: Token(
            "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e", "Wrapped CSPR", "WCSPR", "cep3009-value"
        ),
    },
}


class ConfigError(ValueError):
    """A setting is missing or invalid; nothing has been signed or sent."""


@dataclass(frozen=True)
class Settings:
    network: str
    asset: str
    token: Token
    facilitator_url: str
    key_path: Path
    seller: str
    headers: Dict[str, str] = field(repr=False)  # holds the facilitator key


def _is_loopback(host: Optional[str]) -> bool:
    if not host:
        return False
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def token_for(asset: Optional[str], network: str) -> Token:
    """The token `asset` (legacy or wcspr; default legacy) names on `network`."""
    name = (asset or "legacy").strip().lower()
    if name not in TOKENS:
        raise ConfigError(f"asset must be one of {', '.join(TOKENS)}, got {asset!r}")
    token = TOKENS[name].get(network)
    if token is None:
        raise ConfigError(
            f"asset {name} is only set up on {', '.join(TOKENS[name])}, not {network} "
            "(the mainnet Wrapped CSPR is not verified for x402 settlement yet)"
        )
    return token


def facilitator_url(value: Optional[str]) -> str:
    """The facilitator base URL: `value` itself, or the URL of the shorthand self / hosted (default self)."""
    raw = (value or "self").strip()
    url = FACILITATOR_SHORTHANDS.get(raw.lower(), raw).rstrip("/")
    try:
        parts = urlsplit(url)
        host = parts.hostname
    except ValueError:
        host = None
    if host is None or parts.scheme not in ("http", "https"):
        raise ConfigError(f"the facilitator must be an http(s) URL, self or hosted; got {value!r}")
    if parts.username is not None or parts.password is not None:
        raise ConfigError("put the facilitator key in CSPR_CLOUD_TOKEN or CASCET_FACILITATOR_TOKEN, not in the URL")
    if "?" in url or "#" in url:  # /settle is appended to the base URL; a key in a query would also be printed
        raise ConfigError(
            "the facilitator URL must not have a query or a fragment; put a key in CSPR_CLOUD_TOKEN or "
            "CASCET_FACILITATOR_TOKEN"
        )
    return url


def default_facilitator(token: Token) -> str:
    """The facilitator used when none is named: self, or hosted for a token the self-hosted one does not settle."""
    return "self" if token.style in SELF_HOSTED_SETTLE_STYLES else "hosted"


def check_facilitator_settles(token: Token, url: str) -> None:
    """
    Refuse a facilitator that would settle `token` with the wrong argument.

    Such a settle reverts (User error 64658) and still burns its whole gas
    limit, so it is refused before anything is signed. The hosted facilitator
    settles HOSTED_SETTLE_STYLES; any other facilitator is taken for CasCet's
    self-hosted one, which settles SELF_HOSTED_SETTLE_STYLES.
    """
    if is_hosted_facilitator_url(url):
        if token.style not in HOSTED_SETTLE_STYLES:
            raise ConfigError(
                f"the hosted facilitator settles only cep3009-value tokens (it passes `value`), and the {token.name} "
                f"is {token.style} (it takes `amount`): its settle would revert (User error 64658) and burn the gas "
                "limit. Use CasCet's self-hosted facilitator (--facilitator self)."
            )
    elif token.style not in SELF_HOSTED_SETTLE_STYLES:
        raise ConfigError(
            "any facilitator other than the hosted one is taken for CasCet's self-hosted facilitator, which settles "
            f"only {', '.join(SELF_HOSTED_SETTLE_STYLES)} tokens, and the {token.name} is {token.style}, so its "
            "settle would revert (User error 64658) and burn the gas limit. "
            "Use --facilitator hosted (with CSPR_CLOUD_TOKEN)."
        )


def facilitator_secret(env: Mapping[str, str], name: str) -> Optional[str]:
    """
    The facilitator key in the variable `name`, or None when it is unset or blank.

    Surrounding whitespace is dropped (a key read from a file ends in a
    newline). What is left must be one line of 1-256 printable ASCII
    characters without spaces, as an access key or bearer token is: a CR or
    LF would make requests refuse the header with an error that quotes the
    key. The error names the variable and never shows the value.
    """
    value = (env.get(name) or "").strip()
    if not value:
        return None
    if not _FACILITATOR_KEY_RE.fullmatch(value):
        raise ConfigError(
            f"{name} must be one line of 1-256 printable ASCII characters without spaces (the value is not shown)"
        )
    return value


def facilitator_headers(url: str, env: Mapping[str, str]) -> Dict[str, str]:
    """
    The Authorization header for the facilitator at `url`.

    The hosted facilitator takes the raw CSPR.cloud access key (CSPR_CLOUD_TOKEN),
    never "Bearer <key>"; any other facilitator gets CASCET_FACILITATOR_TOKEN as
    "Bearer <token>" when it is set. Each secret only ever goes to its own kind
    of facilitator, and never over plain http:// to another machine. The key
    in use must pass facilitator_secret's check.
    """
    if is_hosted_facilitator_url(url):
        key = facilitator_secret(env, "CSPR_CLOUD_TOKEN")
        if key is None:
            raise ConfigError("the hosted facilitator needs your CSPR.cloud access key: set CSPR_CLOUD_TOKEN")
        value = key  # raw: the hosted facilitator refuses "Bearer <key>"
    else:
        token = facilitator_secret(env, "CASCET_FACILITATOR_TOKEN")
        if token is None:
            return {}
        value = f"Bearer {token}"
    parts = urlsplit(url)
    if parts.scheme != "https" and not _is_loopback(parts.hostname):
        raise ConfigError(
            f"refusing to send the facilitator key over {parts.scheme}:// to {parts.hostname}: use https:// "
            "(or a facilitator on this machine)"
        )
    return {"Authorization": value}


def seller_pay_to(value: Optional[str], network: str) -> str:
    """The payee: CASCET_SELLER_ACCOUNT_HASH, or the demo seller on testnet."""
    value = (value or "").strip()
    if not value:
        if network != NETWORK_CASPER_TESTNET:
            raise ConfigError("CASCET_SELLER_ACCOUNT_HASH is required on mainnet")
        return TESTNET_DEMO_SELLER
    if len(value) == 64:  # a bare account hash
        value = "00" + value
    try:
        pay_to = normalize_pay_to(value)
    except ValueError as exc:
        raise ConfigError(f"CASCET_SELLER_ACCOUNT_HASH: {exc}") from None
    if not pay_to.startswith("00"):
        raise ConfigError(f"CASCET_SELLER_ACCOUNT_HASH must be an account hash, got {value!r}")
    return pay_to


def missing_mainnet_settings(env: Mapping[str, str]) -> list:
    """The variables mainnet needs that are unset (testnet has defaults for both)."""
    if env.get("CASCET_NET") != "mainnet":
        return []
    return [name for name in ("CASCET_KEY_PATH", "CASCET_SELLER_ACCOUNT_HASH") if not (env.get(name) or "").strip()]


def load_settings(argv: Optional[Sequence[str]], env: Mapping[str, str]) -> Settings:
    """Read the options and the environment; raises ConfigError (or SystemExit for bad options)."""
    parser = argparse.ArgumentParser(
        prog="example_settle.py",
        description="Sign an x402 authorization in Python and settle it through a facilitator (moves real tokens).",
    )
    parser.add_argument("--asset", help="legacy (CasCet X402 Token, the default) or wcspr (testnet Wrapped CSPR)")
    parser.add_argument(
        "--facilitator", help="facilitator base URL, or self or hosted (default: self, for both tokens)"
    )
    args = parser.parse_args(argv)

    network = NETWORK_CASPER_MAINNET if env.get("CASCET_NET") == "mainnet" else NETWORK_CASPER_TESTNET
    asset = (args.asset or env.get("CASCET_ASSET") or "legacy").strip().lower()
    token = token_for(asset, network)
    chosen = args.facilitator or env.get("FACILITATOR")
    url = facilitator_url(chosen or default_facilitator(token))
    check_facilitator_settles(token, url)
    try:
        headers = facilitator_headers(url, env)
    except ConfigError as exc:
        if chosen or not is_hosted_facilitator_url(url):
            raise
        raise ConfigError(
            f"{exc}. The hosted facilitator is the default for the {token.name}: CasCet's self-hosted facilitator "
            f"does not settle {token.style} tokens"
        ) from None
    seller = seller_pay_to(env.get("CASCET_SELLER_ACCOUNT_HASH"), network)
    key_path = (env.get("CASCET_KEY_PATH") or "").strip()
    if not key_path and network != NETWORK_CASPER_TESTNET:
        raise ConfigError("CASCET_KEY_PATH is required on mainnet")
    return Settings(
        network=network,
        asset=asset,
        token=token,
        facilitator_url=url,
        key_path=Path(key_path) if key_path else TESTNET_DEMO_KEY_PATH,
        seller=seller,
        headers=headers,
    )


def requirements_for(token: Token, network: str, seller: str, *, advertise_style: bool = True) -> dict:
    """
    The payment requirements a CasCet gateway would advertise in its 402 (`accepts[0]`).

    With `advertise_style` False, `extra` leaves out authorizationStyle: a
    CasCet gateway strips that field before it forwards a payment to the
    hosted facilitator (whether that service tolerates fields it does not know
    is untested), so this script sends the hosted facilitator what production
    sends it. The field is not part of the signed EIP-712 message, so the
    signature is the same either way.
    """
    extra = {"name": token.name, "symbol": token.symbol, "version": "1", "decimals": "9"}
    if advertise_style:
        extra[AUTHORIZATION_STYLE_EXTRA_KEY] = token.style
    return {
        "scheme": "exact",
        "network": network,
        "amount": AMOUNT,
        "asset": token.package_hash,
        "payTo": seller,
        "maxTimeoutSeconds": 300,
        "extra": extra,
    }


def settle_request(payment_payload: dict, requirements: dict) -> dict:
    """The body of a facilitator's /settle (and /verify): an x402 v2 SettleRequest."""
    return {"x402Version": X402_VERSION, "paymentPayload": payment_payload, "paymentRequirements": requirements}


def _wrapped_errors(exc: BaseException) -> Iterator[BaseException]:
    """`exc` and every error it wraps: requests and urllib3 keep the original in args[0], `reason` or the chain."""
    seen = set()
    pending = [exc]
    while pending:
        err = pending.pop()
        if id(err) in seen:
            continue
        seen.add(id(err))
        yield err
        for inner in (getattr(err, "reason", None), err.__cause__, err.__context__, err.args[0] if err.args else None):
            if isinstance(inner, BaseException):
                pending.append(inner)


def request_never_left(exc: requests.RequestException) -> bool:
    """
    Whether `exc` ended the /settle POST before the facilitator could have
    received it: the connection or the DNS lookup failed, the facilitator's
    certificate did not verify, or the request was refused while it was
    being prepared.

    requests raises a failed connect as ConnectTimeout, or as a
    ConnectionError around urllib3's MaxRetryError with a NewConnectionError
    (connection refused, DNS), and a certificate that does not verify stops
    the TLS handshake. Any other error can come after the request went out,
    when the facilitator may already have broadcast the transfer, so it
    leaves the outcome unknown: another TLS error (an SSLError, which
    requests raises the same way while the answer is awaited or read as in
    the handshake), a connection dropped or reset (a ConnectionError around
    urllib3's ProtocolError), a slow answer (ReadTimeout), an answer urllib3
    cannot parse (InvalidHeader, such as a Content-Length with values that
    disagree).
    """
    if isinstance(exc, requests.exceptions.SSLError):
        return any(isinstance(err, _HANDSHAKE_ONLY_ERRORS) for err in _wrapped_errors(exc))
    if isinstance(
        exc,
        (
            requests.exceptions.ConnectTimeout,
            requests.exceptions.ProxyError,
            requests.exceptions.InvalidURL,
            requests.exceptions.InvalidSchema,
            requests.exceptions.MissingSchema,
        ),
    ):
        return True
    if isinstance(exc, requests.exceptions.ConnectionError):
        cause = exc.args[0] if exc.args else None
        return isinstance(cause, urllib3.exceptions.MaxRetryError) and isinstance(
            cause.reason, urllib3.exceptions.NewConnectionError
        )
    return False


def settlement_status(data: Any) -> Optional[str]:
    """`extra.settlementStatus` of a /settle answer (CasCet's self-hosted facilitator sets it), or None."""
    extra = data.get("extra") if isinstance(data, Mapping) else None
    status = extra.get("settlementStatus") if isinstance(extra, Mapping) else None
    return status if isinstance(status, str) else None


def hosted_failure(data: Any) -> Optional[str]:
    """
    What an unsuccessful /settle answer of the hosted facilitator says about
    the transfer, as CasCet's gateway reads it (classifySettleFailure in
    @cascet/gateway): "unknown" when it was submitted, or may have been, and
    did not revert (a transaction hash, or HOSTED_SETTLE_FAILED), "failed"
    for a revert or a reason given before anything is submitted, and None for
    an answer it does not recognize.
    """
    if not isinstance(data, Mapping) or data.get("success") is True:
        return None
    reason = data.get("errorReason")
    message = data.get("errorMessage")
    reverted = isinstance(message, str) and _REVERTED_RE.match(message) is not None
    if transaction_hash(data) and not reverted:
        return "unknown"
    if reason == HOSTED_SETTLE_FAILED:
        return "failed" if reverted else "unknown"
    if isinstance(reason, str) and reason.startswith(_HOSTED_REASON_PREFIX):
        return "failed"
    return None


def outcome_unknown(status_code: int, data: Any, *, hosted: bool = False) -> bool:
    """
    Whether a /settle answer leaves open whether the transfer executes.

    True for settlement_pending / settlement_unknown (as errorReason, or
    pending / unknown as extra.settlementStatus), for a hosted facilitator's
    failure that may hide a transfer that still executes (see
    hosted_failure), and for a server error (5xx, such as a proxy's 502 or
    504) that does not say what happened: the facilitator may already have
    broadcast the transaction.
    """
    reason = data.get("errorReason") if isinstance(data, Mapping) else None
    status = settlement_status(data)
    if (isinstance(reason, str) and reason in UNKNOWN_OUTCOME_REASONS) or status in UNKNOWN_SETTLEMENT_STATUSES:
        return True
    if hosted and hosted_failure(data) == "unknown":
        return True
    return status_code >= 500 and status is None


def transaction_hash(data: Any) -> Optional[str]:
    """The `transaction` of a /settle answer when it is a 64-hex transaction hash, else None."""
    tx = data.get("transaction") if isinstance(data, Mapping) else None
    return tx if isinstance(tx, str) and _TX_HASH_RE.fullmatch(tx) else None


def shown(value: Any, limit: int = 300) -> str:
    """A value from the facilitator, fit for the terminal: control characters escaped, at most `limit` characters."""
    text = value if isinstance(value, str) else repr(value)
    text = "".join(ch if ch.isprintable() else ascii(ch)[1:-1] for ch in text)
    return text if len(text) <= limit else text[: limit - 3] + "..."


def unknown_outcome_caution(token: Token, key: CasperKey, authorization: Mapping[str, str]) -> str:
    """What to do when a settle may still execute: a re-run signs a new authorization and can pay twice."""
    valid_before = int(authorization["validBefore"])
    until = datetime.fromtimestamp(valid_before, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    return (
        f"   The settle may still execute. Check the payer's {token.name} balance (account-hash "
        f"{key.account_hash_hex()}) and the explorer before running this again: a re-run signs a new "
        "authorization and can pay twice.\n"
        f"   This authorization (nonce {authorization['nonce']}) cannot execute after {until} "
        f"(validBefore {valid_before})."
    )


def main(argv: Optional[Sequence[str]] = None, env: Optional[Mapping[str, str]] = None) -> int:
    env = os.environ if env is None else env
    missing = missing_mainnet_settings(env)
    if missing:
        print(
            "set CASCET_KEY_PATH and CASCET_SELLER_ACCOUNT_HASH explicitly for mainnet "
            f"(missing: {', '.join(missing)}). This moves real funds, so there are no mainnet defaults: "
            "the repo's demo key is a throwaway key and the old demo payee is the hot deployer account.",
            file=sys.stderr,
        )
        return EXIT_FAILED
    try:
        settings = load_settings(argv, env)
    except ConfigError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return EXIT_FAILED
    hosted = is_hosted_facilitator_url(settings.facilitator_url)
    # Like a CasCet gateway, keep CasCet's own extra.authorizationStyle away from the hosted facilitator.
    requirements = requirements_for(settings.token, settings.network, settings.seller, advertise_style=not hosted)

    if not settings.key_path.is_file():
        hint = "" if settings.network == NETWORK_CASPER_MAINNET else "\nset CASCET_KEY_PATH or run `pnpm --filter @cascet/e2e gen-keys`"
        print(f"payer key not found: {settings.key_path}{hint}", file=sys.stderr)
        return EXIT_FAILED
    key = CasperKey.from_pem(settings.key_path)
    print(f"[python] network: {settings.network}")
    print(f"[python] token: {settings.token.name} ({settings.token.style}) {settings.token.package_hash[:10]}...")
    print(f"[python] facilitator: {settings.facilitator_url}")
    print(f"[python] payer account-hash: {key.account_hash_hex()}")

    # Signs the EIP-712 authorization; the payload carries `accepted` (the full requirements).
    payment_payload = build_payment_payload(key=key, requirements=requirements)
    print(f"[python] signed authorization for {AMOUNT} raw units -> {settings.seller[:12]}...")
    caution = unknown_outcome_caution(settings.token, key, payment_payload["payload"]["authorization"])
    explorer = EXPLORERS[settings.network]

    try:
        resp = requests.post(
            f"{settings.facilitator_url}/settle",
            json=settle_request(payment_payload, requirements),
            headers=settings.headers,
            timeout=SETTLE_TIMEOUT,
            allow_redirects=False,  # never hand the signed authorization (or the key) to another origin
        )
    except requests.RequestException as exc:
        if request_never_left(exc):
            print(f"\n❌ facilitator unreachable at {settings.facilitator_url}: {exc}")
            return EXIT_FAILED
        print(
            f"\n⚠ outcome unknown: the settle request may have reached {settings.facilitator_url}, "
            f"but no answer came back ({type(exc).__name__}: {exc})"
        )
        print(caution)
        return EXIT_OUTCOME_UNKNOWN

    try:
        data = resp.json()
    except ValueError:
        data = None
    if isinstance(data, dict):
        print(f"[python] facilitator response (HTTP {resp.status_code}): {data}")
    tx = transaction_hash(data)

    if outcome_unknown(resp.status_code, data, hosted=hosted):
        if isinstance(data, dict):
            reason = data.get("errorReason") or data.get("error") or settlement_status(data)
            detail = shown(reason) if reason else "no reason given"
            if data.get("errorMessage"):
                detail += f": {shown(data['errorMessage'])}"
        else:
            detail = f"a non-JSON body {resp.text[:300]!r}"
        print(
            f"\n⚠ outcome unknown: the facilitator answered HTTP {resp.status_code} without confirming the settle "
            f"({detail})"
        )
        if tx:
            print(f"   tx: {tx}\n   {explorer}{tx}")
        print(caution)
        return EXIT_OUTCOME_UNKNOWN
    if not isinstance(data, dict):
        print(f"\n❌ facilitator answered HTTP {resp.status_code} with a non-JSON body: {resp.text[:300]!r}")
        return EXIT_FAILED
    if resp.status_code != 200:
        # Refusals before any verdict (401 auth, 429 rate limit, 503 gas cap/unavailable) carry "errorReason";
        # allowlist and duplicate verdicts come back as HTTP 200 with success: false (handled below).
        reason = data.get("error") or data.get("errorReason") or "unknown error"
        print(f"\n❌ facilitator refused the settle (HTTP {resp.status_code}): {shown(reason)}")
        return EXIT_FAILED
    if data.get("success") is True:
        net_label = "MAINNET" if settings.network == NETWORK_CASPER_MAINNET else "testnet"
        print(f"\n✅ Python-signed x402 payment settled on Casper {net_label}")
        if tx:
            print(f"   tx: {tx}\n   {explorer}{tx}")
        else:
            print(f"   tx: {shown(data.get('transaction'))} (not a transaction hash)")
        return EXIT_SETTLED
    print(f"\n❌ settle failed: {shown(data.get('errorReason'))} — {shown(data.get('errorMessage') or '')}")
    if tx:
        print(f"   tx: {tx}\n   {explorer}{tx}")
    elif hosted and hosted_failure(data) is None:
        # A failure this script does not recognize: the hosted facilitator names no transaction even for a
        # transfer it had already broadcast, so this one may still execute.
        print("   The hosted facilitator gives no transaction hash even for a transfer it had already broadcast.")
        print(caution)
    return EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main())
