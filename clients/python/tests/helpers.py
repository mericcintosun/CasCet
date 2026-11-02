"""Shared fixtures for the cascet_x402 tests (stdlib unittest only)."""
from __future__ import annotations

import copy
import json
import sys
import threading
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

CLIENT_DIR = Path(__file__).resolve().parents[1]
if str(CLIENT_DIR) not in sys.path:
    sys.path.insert(0, str(CLIENT_DIR))

import cascet_x402 as x402  # noqa: E402

VECTORS: Dict[str, Any] = json.loads((Path(__file__).parent / "eip712_vectors.json").read_text("utf-8"))

# Test-only key from the vector file: seed = sha256(label). Public, unfunded, never use it for real.
TEST_KEY = x402.CasperKey.from_seed(bytes.fromhex(VECTORS["key"]["seedHex"]))

TESTNET = x402.NETWORK_CASPER_TESTNET
MAINNET = x402.NETWORK_CASPER_MAINNET
TOKEN = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3"
OTHER_TOKEN = "8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41"
#: The official Wrapped CSPR on testnet: a CEP-3009 ("cep3009-value") token.
WCSPR = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e"
SELLER = "00881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36"
OTHER_SELLER = "00" + "ab" * 32
NOW = 1767225600  # 2026-01-01T00:00:00Z
DELETE = object()  # make_requirements(field=DELETE) drops the field
#: `extra` of the two tokens as a CasCet gateway advertises them since the 2.29 migration.
LEGACY_EXTRA = {"name": "CasCet X402 Token", "symbol": "WCSPR", "version": "1", "decimals": "9", "authorizationStyle": "legacy-amount"}
WCSPR_EXTRA = {"name": "Wrapped CSPR", "symbol": "WCSPR", "version": "1", "decimals": "9", "authorizationStyle": "cep3009-value"}


def make_requirements(**overrides: Any) -> Dict[str, Any]:
    """One `accepts` entry as a CasCet gateway advertises it."""
    req: Dict[str, Any] = {
        "scheme": "exact",
        "network": TESTNET,
        "amount": "500000000",
        "asset": TOKEN,
        "payTo": SELLER,
        "maxTimeoutSeconds": 300,
        "extra": {"name": "CasCet X402 Token", "symbol": "WCSPR", "version": "1", "decimals": "9"},
    }
    for name, value in overrides.items():
        if value is DELETE:
            req.pop(name, None)
        else:
            req[name] = value
    return req


def legacy_requirements(**overrides: Any) -> Dict[str, Any]:
    """An `accepts` entry for the CasCet X402 Token that names its style (legacy-amount)."""
    overrides.setdefault("extra", copy.deepcopy(LEGACY_EXTRA))
    return make_requirements(**overrides)


def wcspr_requirements(**overrides: Any) -> Dict[str, Any]:
    """An `accepts` entry for the testnet Wrapped CSPR (cep3009-value)."""
    overrides.setdefault("asset", WCSPR)
    overrides.setdefault("extra", copy.deepcopy(WCSPR_EXTRA))
    return make_requirements(**overrides)


def make_payment_required(*accepts: Dict[str, Any], **extra: Any) -> Dict[str, Any]:
    pr: Dict[str, Any] = {
        "x402Version": 2,
        "error": "Payment required",
        "resource": {"url": "http://127.0.0.1:4402/tools/echo", "description": "Paid MCP tool: echo", "mimeType": "application/json"},
        "accepts": [copy.deepcopy(a) for a in (accepts or (make_requirements(),))],
    }
    pr.update(extra)
    return pr


def quiet_client(**kwargs: Any) -> x402.PayingClient:
    """A PayingClient with allowlists and budgets unless overridden; config warnings are silenced."""
    options: Dict[str, Any] = {
        "allowed_pay_to": [SELLER],
        "allowed_assets": [TOKEN],
        "max_per_call_raw": "1000000000",
        "max_session_raw": "2000000000",
    }
    options.update(kwargs)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", x402.InsecurePaymentConfigWarning)
        return x402.PayingClient(TEST_KEY, **options)


class FakeResponse:
    def __init__(self, status_code: int, headers: Optional[Dict[str, str]] = None, url: str = "", body: Any = None):
        self.status_code = status_code
        self.headers = CaseInsensitive(headers or {})
        self.url = url
        self._body = body

    def json(self) -> Any:
        return self._body


class CaseInsensitive(dict):
    """Minimal stand-in for requests' CaseInsensitiveDict (only .get is case-insensitive)."""

    def get(self, key: str, default: Any = None) -> Any:  # type: ignore[override]
        for k, v in self.items():
            if k.lower() == key.lower():
                return v
        return default


class FakeSession:
    """Records requests and replays scripted responses (callables get the call record)."""

    def __init__(self, *responses: Any):
        self.responses: List[Any] = list(responses)
        self.calls: List[Dict[str, Any]] = []

    def request(self, method: str, url: str, **kwargs: Any) -> FakeResponse:
        call = {"method": method, "url": url, **kwargs}
        call["headers"] = dict(kwargs.get("headers") or {})
        self.calls.append(call)
        response = self.responses.pop(0)
        return response(call) if callable(response) else response


def challenge(payment_required: Optional[Dict[str, Any]] = None, url: str = "https://gateway.test/mcp") -> FakeResponse:
    pr = payment_required or make_payment_required()
    return FakeResponse(402, {"PAYMENT-REQUIRED": x402._b64_json_encode(pr)}, url=url, body={})


def reset_warnings() -> None:
    x402._warned.clear()


# ---- a real HTTP server on 127.0.0.1, for tests that need actual sockets ----
class LocalServer:
    """
    A threaded HTTP/1.1 server on an ephemeral 127.0.0.1 port.

    `app(handler, server)` answers each request; `requests` records what
    arrived (method, path, headers, body and the client's port). Use it as a
    context manager. `stop` is set on exit so slow handlers can end early.
    """

    def __init__(self, app: Callable[[BaseHTTPRequestHandler, "LocalServer"], None]):
        server = self
        self.requests: List[Dict[str, Any]] = []
        self.stop = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def answer(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                server.requests.append({
                    "method": self.command, "path": self.path, "headers": self.headers,
                    "body": body, "port": self.client_address[1],
                })
                try:
                    app(self, server)
                except (BrokenPipeError, ConnectionResetError):  # the client gave up first
                    self.close_connection = True

            do_GET = do_POST = answer

            def handle_one_request(self) -> None:
                try:
                    super().handle_one_request()
                except (BrokenPipeError, ConnectionResetError):  # the client hung up between requests
                    self.close_connection = True

            def log_message(self, format: str, *args: Any) -> None:  # keep the test output clean
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self._thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)

    def __enter__(self) -> "LocalServer":
        self._thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.stop.set()
        self.httpd.shutdown()
        self.httpd.server_close()
        self._thread.join(5)


def send(handler: BaseHTTPRequestHandler, status: int, headers: Optional[Dict[str, str]] = None, body: bytes = b"") -> None:
    handler.send_response(status)
    for name, value in (headers or {}).items():
        handler.send_header(name, value)
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def send_challenge(handler: BaseHTTPRequestHandler, payment_required: Optional[Dict[str, Any]] = None) -> None:
    pr = payment_required or make_payment_required()
    body = json.dumps({"error": "payment required"}).encode()
    send(handler, 402, {"PAYMENT-REQUIRED": x402._b64_json_encode(pr), "Content-Type": "application/json"}, body)


def drip(handler: BaseHTTPRequestHandler, server: LocalServer, body: bytes, interval: float) -> None:
    """Send the headers at once, then the body one byte per `interval` seconds."""
    handler.send_response(200)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    for index in range(len(body)):
        handler.wfile.write(body[index:index + 1])
        handler.wfile.flush()
        if server.stop.wait(interval):
            break
    handler.close_connection = True


def direct_session() -> Any:
    """A requests.Session that ignores proxy settings from the environment (tests talk to 127.0.0.1)."""
    import requests

    session = requests.Session()
    session.trust_env = False
    return session


# ---- a TLS server on 127.0.0.1, with a throwaway certificate authority made for the test ----
def throwaway_certificates(directory: str) -> Dict[str, str]:
    """
    Write a test CA (ca.pem) and a certificate for 127.0.0.1 it signed (cert.pem, key.pem) into `directory`.
    The keys are generated for the test and live only there.
    """
    import datetime
    import ipaddress

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    def key_usage(**allowed: bool) -> x509.KeyUsage:
        names = ("digital_signature", "content_commitment", "key_encipherment", "data_encipherment", "key_agreement",
                 "key_cert_sign", "crl_sign", "encipher_only", "decipher_only")
        return x509.KeyUsage(**{name: allowed.get(name, False) for name in names})

    now = datetime.datetime.now(datetime.timezone.utc)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "cascet test CA")])
    ca = (
        x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(key_usage(key_cert_sign=True, crl_sign=True), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    key = ec.generate_private_key(ec.SECP256R1())
    cert = (
        x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "127.0.0.1")]))
        .issuer_name(ca_name).public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(key_usage(digital_signature=True), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    paths = {name: str(Path(directory) / name) for name in ("ca.pem", "cert.pem", "key.pem")}
    Path(paths["ca.pem"]).write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    Path(paths["cert.pem"]).write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    Path(paths["key.pem"]).write_bytes(
        key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    )
    return paths


class TlsServer:
    """
    A TLS server on an ephemeral 127.0.0.1 port that serves one connection at a time. After the handshake it
    reads one HTTP request (headers and Content-Length body) into `requests`, then hands the TLS socket to
    `app(tls_socket, server)`. A failed handshake is recorded in `handshake_errors`. Use it as a context manager.
    """

    def __init__(self, app: Callable[[Any, "TlsServer"], None], certfile: str, keyfile: str):
        import socket
        import ssl

        self.app = app
        self.requests: List[bytes] = []
        self.handshake_errors: List[str] = []
        self.stop = threading.Event()
        self._context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self._context.load_cert_chain(certfile, keyfile)
        self._socket = socket.socket()
        self._socket.bind(("127.0.0.1", 0))
        self._socket.listen(4)
        self._socket.settimeout(0.05)
        self.url = f"https://127.0.0.1:{self._socket.getsockname()[1]}"
        self._thread = threading.Thread(target=self._serve, daemon=True)

    def _serve(self) -> None:
        while not self.stop.is_set():
            try:
                conn, _ = self._socket.accept()
            except OSError:  # the accept timeout, or the socket was closed
                continue
            conn.settimeout(5)
            try:
                tls = self._context.wrap_socket(conn, server_side=True)
            except OSError as exc:  # ssl.SSLError included: the client refused the certificate
                self.handshake_errors.append(repr(exc))
                conn.close()
                continue
            with tls:
                try:
                    self.requests.append(self._read_request(tls))
                    self.app(tls, self)
                except OSError:  # the client gave up first
                    pass

    @staticmethod
    def _read_request(tls: Any) -> bytes:
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = tls.recv(4096)
            if not chunk:
                return data
            data += chunk
        head, _, body = data.partition(b"\r\n\r\n")
        length = 0
        for line in head.split(b"\r\n")[1:]:
            name, _, value = line.partition(b":")
            if name.strip().lower() == b"content-length":
                length = int(value.strip())
        while len(body) < length:
            chunk = tls.recv(4096)
            if not chunk:
                break
            body += chunk
        return head + b"\r\n\r\n" + body

    def __enter__(self) -> "TlsServer":
        self._thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.stop.set()
        self._thread.join(5)
        self._socket.close()


def corrupt_tls(tls: Any) -> None:
    """Write bytes that are not a TLS record straight to the socket under `tls`, as a broken proxy might."""
    import os

    os.write(tls.fileno(), b"this is not a TLS record\r\n" * 4)
    try:
        tls.recv(1)  # wait for the client to give up, so the bytes are not cut short by a reset
    except OSError:
        pass
