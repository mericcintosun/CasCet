"""example_settle.py and example_gateway.py: the asset and facilitator choices and the hosted facilitator's raw key.

Nothing here touches an external network: requests.post and the PayingClient's session are replaced by fakes,
or by a session talking to a small server on 127.0.0.1 for the transport failures of a settle.
"""
import base64
import contextlib
import io
import json
import os
import socket
import tempfile
import unittest
from unittest import mock

import requests
import urllib3
from cryptography.hazmat.primitives import serialization

from helpers import (
    MAINNET, SELLER, TEST_KEY, TESTNET, TOKEN, OTHER_TOKEN, WCSPR, FakeResponse, FakeSession, LocalServer, challenge,
    direct_session, legacy_requirements, make_payment_required, wcspr_requirements, x402,
)

import example_gateway  # noqa: E402  (helpers puts clients/python on sys.path)
import example_settle  # noqa: E402

HOSTED = "https://x402-facilitator.cspr.cloud"
SELF_HOSTED = "http://127.0.0.1:4501"


def write_test_pem(test_case):
    tmp = tempfile.TemporaryDirectory()
    test_case.addCleanup(tmp.cleanup)
    path = os.path.join(tmp.name, "payer.pem")
    with open(path, "wb") as f:
        f.write(TEST_KEY._sk.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    return path


class TestSettleTokens(unittest.TestCase):
    def test_legacy_and_wcspr(self):
        legacy = example_settle.token_for("legacy", TESTNET)
        self.assertEqual((legacy.package_hash, legacy.name, legacy.style), (TOKEN, "CasCet X402 Token", "legacy-amount"))
        self.assertEqual(example_settle.token_for(None, TESTNET), legacy)  # the default
        self.assertEqual(example_settle.token_for(" LEGACY ", MAINNET).package_hash, OTHER_TOKEN)
        wcspr = example_settle.token_for("wcspr", TESTNET)
        self.assertEqual((wcspr.package_hash, wcspr.name, wcspr.style), (WCSPR, "Wrapped CSPR", "cep3009-value"))
        for token in (legacy, wcspr):  # the styles agree with the library's defaults for these hashes
            self.assertEqual(x402.default_authorization_style(token.package_hash), token.style)

    def test_unknown_or_unsupported(self):
        with self.assertRaises(example_settle.ConfigError) as ctx:
            example_settle.token_for("wcspr", MAINNET)
        self.assertIn("only set up on casper:casper-test", str(ctx.exception))
        for bad in ("usdc", "hash-" + WCSPR):
            with self.subTest(asset=bad):
                with self.assertRaises(example_settle.ConfigError):
                    example_settle.token_for(bad, TESTNET)

    def test_requirements_name_the_style(self):
        for name in ("legacy", "wcspr"):
            token = example_settle.token_for(name, TESTNET)
            requirements = example_settle.requirements_for(token, TESTNET, SELLER)
            with self.subTest(asset=name):
                self.assertEqual(requirements["asset"], token.package_hash)
                self.assertEqual(requirements["extra"]["name"], token.name)
                self.assertEqual(x402.authorization_style(requirements), token.style)
                payload = x402.build_payment_payload(key=TEST_KEY, requirements=requirements, now=1767225600)
                self.assertEqual(payload["accepted"], requirements)
                body = example_settle.settle_request(payload, requirements)
                self.assertEqual(body, {"x402Version": 2, "paymentPayload": payload, "paymentRequirements": requirements})

    def test_requirements_without_the_style_sign_the_same_message(self):
        # What goes to the hosted facilitator: no extra.authorizationStyle, which no signature covers.
        for name in ("legacy", "wcspr"):
            token = example_settle.token_for(name, TESTNET)
            with_style = example_settle.requirements_for(token, TESTNET, SELLER)
            without_style = example_settle.requirements_for(token, TESTNET, SELLER, advertise_style=False)
            with self.subTest(asset=name):
                self.assertNotIn("authorizationStyle", without_style["extra"])
                self.assertIsNone(x402.authorization_style(without_style))
                self.assertEqual(without_style["extra"], {k: v for k, v in with_style["extra"].items()
                                                          if k != "authorizationStyle"})
                self.assertEqual({k: v for k, v in without_style.items() if k != "extra"},
                                 {k: v for k, v in with_style.items() if k != "extra"})
                fixed = {"key": TEST_KEY, "now": 1767225600, "nonce": bytes(range(32))}
                signed_with = x402.build_payment_payload(requirements=with_style, **fixed)
                signed_without = x402.build_payment_payload(requirements=without_style, **fixed)
                self.assertEqual(signed_with["payload"], signed_without["payload"])  # same signature
                self.assertEqual(signed_without["accepted"], without_style)


class TestSettleFacilitator(unittest.TestCase):
    def test_url_shorthands(self):
        self.assertEqual(example_settle.facilitator_url(None), SELF_HOSTED)
        self.assertEqual(example_settle.facilitator_url("self"), SELF_HOSTED)
        self.assertEqual(example_settle.facilitator_url(" Hosted "), HOSTED)
        self.assertEqual(example_settle.facilitator_url("https://facilitator.example.test/x402/"),
                         "https://facilitator.example.test/x402")
        for bad in ("ftp://facilitator.example.test", "facilitator.example.test", "https://", "http://[::1",
                    "https://user:secret@facilitator.example.test"):
            with self.subTest(url=bad):
                with self.assertRaises(example_settle.ConfigError):
                    example_settle.facilitator_url(bad)

    def test_url_without_query_or_fragment(self):
        # /settle is appended to the base URL, and a key in a query string would end up in the output.
        for bad in ("https://facilitator.example.test/x402?key=secret", "https://facilitator.example.test/x402?",
                    "https://facilitator.example.test/#secret", "http://127.0.0.1:4501/?secret"):
            with self.subTest(url=bad):
                with self.assertRaises(example_settle.ConfigError) as ctx:
                    example_settle.facilitator_url(bad)
                self.assertIn("query or a fragment", str(ctx.exception))
                self.assertNotIn("secret", str(ctx.exception))

    def test_hosted_facilitator_gets_the_raw_key(self):
        headers = example_settle.facilitator_headers(HOSTED, {"CSPR_CLOUD_TOKEN": " cspr-cloud-key "})
        self.assertEqual(headers, {"Authorization": "cspr-cloud-key"})  # never "Bearer ..."
        # A key read from a file keeps its trailing newline; that is dropped, as are the surrounding blanks.
        headers = example_settle.facilitator_headers(HOSTED, {"CSPR_CLOUD_TOKEN": "cspr-cloud-key\r\n"})
        self.assertEqual(headers, {"Authorization": "cspr-cloud-key"})
        longest = "k" * 256
        self.assertEqual(example_settle.facilitator_headers(HOSTED, {"CSPR_CLOUD_TOKEN": longest}),
                         {"Authorization": longest})

    def test_a_key_must_be_one_line_of_printable_ascii(self):
        # Every value carries the marker "zq", which must never show up in the error.
        bad_values = ("zqfirst\nzqsecond", "zqkey\rzqinjected: header", "zqkey zqspaced", "zqkey\tzqtab",
                      "zq" * 129, "zqkéy", "zqkey\x00", "zqkey\x7f")
        for name, url in (("CSPR_CLOUD_TOKEN", HOSTED), ("CASCET_FACILITATOR_TOKEN", SELF_HOSTED),
                          ("CASCET_FACILITATOR_TOKEN", "https://facilitator.example.test")):
            for value in bad_values:
                with self.subTest(variable=name, url=url, value=value[:20]):
                    with self.assertRaises(example_settle.ConfigError) as ctx:
                        example_settle.facilitator_headers(url, {name: value})
                    message = str(ctx.exception)
                    self.assertIn(name, message)
                    self.assertNotIn("zq", message)
        # Only the key in use is checked: the hosted facilitator never reads CASCET_FACILITATOR_TOKEN.
        env = {"CSPR_CLOUD_TOKEN": "cspr-cloud-key", "CASCET_FACILITATOR_TOKEN": "bad\ntoken"}
        self.assertEqual(example_settle.facilitator_headers(HOSTED, env), {"Authorization": "cspr-cloud-key"})

    def test_hosted_facilitator_needs_its_own_key(self):
        for env in ({}, {"CASCET_FACILITATOR_TOKEN": "self-hosted-secret"}, {"CSPR_CLOUD_TOKEN": " "}):
            with self.subTest(env=env):
                with self.assertRaises(example_settle.ConfigError) as ctx:
                    example_settle.facilitator_headers(HOSTED, env)
                self.assertIn("CSPR_CLOUD_TOKEN", str(ctx.exception))
                self.assertNotIn("self-hosted-secret", str(ctx.exception))

    def test_other_facilitators_get_a_bearer_token(self):
        env = {"CASCET_FACILITATOR_TOKEN": "self-hosted-secret", "CSPR_CLOUD_TOKEN": "cspr-cloud-key"}
        for url in (SELF_HOSTED, "http://localhost:4501", "http://[::1]:4501", "https://facilitator.example.test"):
            with self.subTest(url=url):
                self.assertEqual(example_settle.facilitator_headers(url, env), {"Authorization": "Bearer self-hosted-secret"})
        # The CSPR.cloud key never goes anywhere but the hosted facilitator.
        self.assertEqual(example_settle.facilitator_headers(SELF_HOSTED, {"CSPR_CLOUD_TOKEN": "cspr-cloud-key"}), {})

    def test_no_key_over_plain_http_to_another_machine(self):
        cases = (
            ("http://facilitator.example.test", {"CASCET_FACILITATOR_TOKEN": "secret"}),
            ("http://10.0.0.5:4501", {"CASCET_FACILITATOR_TOKEN": "secret"}),
            ("http://x402-facilitator.cspr.cloud", {"CSPR_CLOUD_TOKEN": "cspr-cloud-key"}),
        )
        for url, env in cases:
            with self.subTest(url=url):
                with self.assertRaises(example_settle.ConfigError) as ctx:
                    example_settle.facilitator_headers(url, env)
                self.assertIn("https://", str(ctx.exception))
        # Without a key there is nothing to protect.
        self.assertEqual(example_settle.facilitator_headers("http://facilitator.example.test", {}), {})


class TestSettleSettings(unittest.TestCase):
    def test_defaults(self):
        settings = example_settle.load_settings([], {})
        self.assertEqual(settings.network, TESTNET)
        self.assertEqual(settings.token.package_hash, TOKEN)
        self.assertEqual(settings.facilitator_url, SELF_HOSTED)
        self.assertEqual(settings.headers, {})
        self.assertEqual(settings.seller, example_settle.TESTNET_DEMO_SELLER)
        self.assertEqual(settings.key_path, example_settle.TESTNET_DEMO_KEY_PATH)

    def test_wcspr_through_the_hosted_facilitator(self):
        env = {"CSPR_CLOUD_TOKEN": "cspr-cloud-key"}
        for argv, extra_env in (
            (["--asset", "wcspr", "--facilitator", "hosted"], {}),
            ([], {"CASCET_ASSET": "wcspr", "FACILITATOR": "hosted"}),
            (["--asset", "wcspr"], {"CASCET_ASSET": "legacy", "FACILITATOR": HOSTED + "/"}),
        ):
            with self.subTest(argv=argv, env=extra_env):
                settings = example_settle.load_settings(argv, {**env, **extra_env})
                self.assertEqual(settings.token.package_hash, WCSPR)
                self.assertEqual(settings.facilitator_url, HOSTED)
                self.assertEqual(settings.headers, {"Authorization": "cspr-cloud-key"})
                self.assertNotIn("cspr-cloud-key", repr(settings))

    def test_default_facilitator_follows_the_token_style(self):
        self.assertEqual(example_settle.SELF_HOSTED_SETTLE_STYLES, ("legacy-amount", "cep3009-value"))
        self.assertEqual(example_settle.HOSTED_SETTLE_STYLES, ("cep3009-value",))
        self.assertEqual(example_settle.default_facilitator(example_settle.token_for("legacy", TESTNET)), "self")
        self.assertEqual(example_settle.default_facilitator(example_settle.token_for("wcspr", TESTNET)), "self")

    def test_a_default_hosted_facilitator_needs_the_cspr_cloud_key(self):
        # For a token the self-hosted facilitator does not settle, the hosted one is picked by default and
        # needs CSPR_CLOUD_TOKEN; the error says why.
        with mock.patch.object(example_settle, "SELF_HOSTED_SETTLE_STYLES", ("legacy-amount",)):
            for env in ({}, {"CASCET_FACILITATOR_TOKEN": "self-hosted-secret"}):
                with self.subTest(env=sorted(env)):
                    with self.assertRaises(example_settle.ConfigError) as ctx:
                        example_settle.load_settings(["--asset", "wcspr"], env)
                    message = str(ctx.exception)
                    self.assertIn("CSPR_CLOUD_TOKEN", message)
                    self.assertIn("default", message)
                    self.assertIn("does not settle cep3009-value tokens", message)
                    self.assertNotIn("self-hosted-secret", message)
        # A facilitator named explicitly keeps the plain message.
        with self.assertRaises(example_settle.ConfigError) as ctx:
            example_settle.load_settings(["--asset", "wcspr", "--facilitator", "hosted"], {})
        self.assertNotIn("default", str(ctx.exception))

    def test_command_line_wins(self):
        settings = example_settle.load_settings(["--asset", "legacy", "--facilitator", "self"],
                                                {"CASCET_ASSET": "wcspr", "FACILITATOR": "hosted"})
        self.assertEqual((settings.token.package_hash, settings.facilitator_url), (TOKEN, SELF_HOSTED))

    def test_legacy_token_is_never_sent_to_the_hosted_facilitator(self):
        for network_env in ({}, {"CASCET_NET": "mainnet", "CASCET_KEY_PATH": "/x", "CASCET_SELLER_ACCOUNT_HASH": SELLER}):
            with self.subTest(env=network_env):
                with self.assertRaises(example_settle.ConfigError) as ctx:
                    example_settle.load_settings(["--facilitator", "hosted"], {"CSPR_CLOUD_TOKEN": "k", **network_env})
                self.assertIn("settles only cep3009-value tokens", str(ctx.exception))
                self.assertIn("User error 64658", str(ctx.exception))

    def test_a_style_the_self_hosted_facilitator_does_not_settle_is_never_sent_there(self):
        # A token sent to a facilitator without its amount argument would revert and burn the gas limit.
        env = {"CSPR_CLOUD_TOKEN": "cspr-cloud-key", "CASCET_FACILITATOR_TOKEN": "self-hosted-secret"}
        patch = mock.patch.object(example_settle, "SELF_HOSTED_SETTLE_STYLES", ("legacy-amount",))
        patch.start()
        self.addCleanup(patch.stop)
        for argv, extra_env in (
            (["--asset", "wcspr", "--facilitator", "self"], {}),
            (["--asset", "wcspr", "--facilitator", "http://localhost:4501"], {}),
            (["--asset", "wcspr", "--facilitator", SELF_HOSTED + "/"], {}),
            (["--asset", "wcspr", "--facilitator", "https://facilitator.example.test"], {}),
            (["--asset", "wcspr"], {"FACILITATOR": "self"}),
            ([], {"CASCET_ASSET": "wcspr", "FACILITATOR": "http://[::1]:4501"}),
        ):
            with self.subTest(argv=argv, env=extra_env):
                with self.assertRaises(example_settle.ConfigError) as ctx:
                    example_settle.load_settings(argv, {**env, **extra_env})
                message = str(ctx.exception)
                self.assertIn("self-hosted facilitator", message)
                self.assertIn("User error 64658", message)
                self.assertIn("--facilitator hosted", message)
                self.assertNotIn("cspr-cloud-key", message)
                self.assertNotIn("self-hosted-secret", message)

    def test_wcspr_on_the_self_hosted_facilitator(self):
        # The self-hosted facilitator settles both styles, so Wrapped CSPR may go there, and does by default.
        self.assertEqual(set(example_settle.SELF_HOSTED_SETTLE_STYLES), set(x402.AUTHORIZATION_STYLES))
        for argv in (["--asset", "wcspr", "--facilitator", "self"], ["--asset", "wcspr"]):
            with self.subTest(argv=argv):
                settings = example_settle.load_settings(argv, {})
                self.assertEqual((settings.token.package_hash, settings.facilitator_url), (WCSPR, SELF_HOSTED))

    def test_mainnet(self):
        env = {"CASCET_NET": "mainnet", "CASCET_KEY_PATH": "/secure/payer.pem", "CASCET_SELLER_ACCOUNT_HASH": SELLER[2:]}
        settings = example_settle.load_settings([], env)
        self.assertEqual((settings.network, settings.token.package_hash, settings.seller), (MAINNET, OTHER_TOKEN, SELLER))
        with self.assertRaises(example_settle.ConfigError):
            example_settle.load_settings(["--asset", "wcspr"], env)
        for missing in ("CASCET_KEY_PATH", "CASCET_SELLER_ACCOUNT_HASH"):
            with self.subTest(missing=missing):
                with self.assertRaises(example_settle.ConfigError):
                    example_settle.load_settings([], {k: v for k, v in env.items() if k != missing})

    def test_bad_options_exit_through_argparse(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                example_settle.load_settings(["--unknown"], {})


class SettleResponse(FakeResponse):
    text = ""


class TestSettleMain(unittest.TestCase):
    def run_main(self, argv, env, response=None):
        response = response or SettleResponse(
            200, {}, body={"success": True, "transaction": "ab" * 32, "network": TESTNET, "payer": TEST_KEY.account_address()}
        )
        out = io.StringIO()
        with mock.patch.object(example_settle.requests, "post", return_value=response) as post:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                code = example_settle.main(argv, env)
        return code, post, out.getvalue()

    def test_wcspr_settles_through_the_hosted_facilitator_with_the_raw_key(self):
        env = {"CASCET_KEY_PATH": write_test_pem(self), "CSPR_CLOUD_TOKEN": "cspr-cloud-key"}
        code, post, out = self.run_main(["--asset", "wcspr", "--facilitator", "hosted"], env)
        self.assertEqual(code, 0, out)
        post.assert_called_once()
        (url,), kwargs = post.call_args
        self.assertEqual(url, HOSTED + "/settle")
        self.assertEqual(kwargs["headers"], {"Authorization": "cspr-cloud-key"})
        self.assertFalse(kwargs["allow_redirects"])
        self.assertEqual(kwargs["timeout"], example_settle.SETTLE_TIMEOUT)
        body = kwargs["json"]
        self.assertEqual(body["x402Version"], 2)
        requirements = body["paymentRequirements"]
        self.assertEqual((requirements["asset"], requirements["extra"]["name"]), (WCSPR, "Wrapped CSPR"))
        # As a CasCet gateway does, CasCet's own extra.authorizationStyle stays away from the hosted facilitator.
        self.assertNotIn("authorizationStyle", requirements["extra"])
        self.assertNotIn("authorizationStyle", body["paymentPayload"]["accepted"]["extra"])
        self.assertEqual(body["paymentPayload"]["accepted"], requirements)
        self.assertEqual(body["paymentPayload"]["payload"]["authorization"]["from"], TEST_KEY.account_address())
        self.assertIn("https://testnet.cspr.live/transaction/" + "ab" * 32, out)

    def test_wcspr_alone_settles_through_the_self_hosted_facilitator(self):
        env = {"CASCET_KEY_PATH": write_test_pem(self), "CSPR_CLOUD_TOKEN": "cspr-cloud-key"}
        code, post, out = self.run_main(["--asset", "wcspr"], env)
        self.assertEqual(code, 0, out)
        (url,), kwargs = post.call_args
        self.assertEqual(url, SELF_HOSTED + "/settle")
        self.assertNotIn("Authorization", kwargs["headers"])
        self.assertEqual(kwargs["json"]["paymentRequirements"]["asset"], WCSPR)
        self.assertEqual(kwargs["json"]["paymentRequirements"]["extra"]["authorizationStyle"], "cep3009-value")

    def test_legacy_settles_through_the_self_hosted_facilitator_with_a_bearer_token(self):
        env = {"CASCET_KEY_PATH": write_test_pem(self), "CASCET_FACILITATOR_TOKEN": "self-hosted-secret"}
        code, post, out = self.run_main([], env)
        self.assertEqual(code, 0, out)
        (url,), kwargs = post.call_args
        self.assertEqual(url, SELF_HOSTED + "/settle")
        self.assertEqual(kwargs["headers"], {"Authorization": "Bearer self-hosted-secret"})
        body = kwargs["json"]
        # Every other facilitator gets the requirements exactly as a CasCet gateway advertises them.
        self.assertEqual(body["paymentRequirements"]["extra"]["authorizationStyle"], "legacy-amount")
        self.assertEqual(body["paymentPayload"]["accepted"]["extra"]["authorizationStyle"], "legacy-amount")
        self.assertEqual(body["paymentPayload"]["accepted"], body["paymentRequirements"])

    def test_refusals_happen_before_anything_is_signed_or_sent(self):
        pem = write_test_pem(self)
        for argv, env in (
            (["--facilitator", "hosted"], {"CASCET_KEY_PATH": pem, "CSPR_CLOUD_TOKEN": "k"}),  # legacy on hosted
            (["--asset", "wcspr", "--facilitator", "hosted"], {"CASCET_KEY_PATH": pem}),  # no CSPR.cloud key
            (["--asset", "wcspr"], {"CASCET_KEY_PATH": pem, "CASCET_NET": "mainnet",
                                    "CASCET_SELLER_ACCOUNT_HASH": SELLER}),  # no mainnet WCSPR
            ([], {"CASCET_NET": "mainnet"}),  # mainnet without explicit key and payee
        ):
            with self.subTest(argv=argv, env=sorted(env)):
                with mock.patch.object(example_settle, "build_payment_payload") as sign:
                    code, post, _ = self.run_main(argv, env)
                self.assertEqual(code, 1)
                post.assert_not_called()
                sign.assert_not_called()

    def test_a_multi_line_key_is_refused_without_showing_it(self):
        # requests would refuse the header with an InvalidHeader that quotes the key, and main() printed it.
        pem = write_test_pem(self)
        for argv, env in (
            (["--asset", "wcspr", "--facilitator", "hosted"],
             {"CASCET_KEY_PATH": pem, "CSPR_CLOUD_TOKEN": "cspr-cloud-key\nsecond-line"}),
            ([], {"CASCET_KEY_PATH": pem, "CASCET_FACILITATOR_TOKEN": "self-hosted-secret\r\nX-Injected: 1"}),
        ):
            with self.subTest(variable=sorted(env)[-1]):
                with mock.patch.object(example_settle, "build_payment_payload") as sign:
                    code, post, out = self.run_main(argv, env)
                self.assertEqual(code, 1)
                post.assert_not_called()
                sign.assert_not_called()
                self.assertIn("configuration error", out)
                for secret in ("cspr-cloud-key", "second-line", "self-hosted-secret", "X-Injected"):
                    self.assertNotIn(secret, out)

    def test_failed_settle(self):
        env = {"CASCET_KEY_PATH": write_test_pem(self)}
        refused = SettleResponse(403, {}, body={"error": "asset not allowlisted"})
        code, _, out = self.run_main([], env, refused)
        self.assertEqual(code, 1)
        self.assertIn("asset not allowlisted", out)
        failed = SettleResponse(200, {}, body={"success": False, "errorReason": "insufficient_funds", "transaction": ""})
        code, _, out = self.run_main([], env, failed)
        self.assertEqual(code, 1)
        self.assertIn("insufficient_funds", out)


def refused_connection():
    """What requests raises when nothing listens on the facilitator's port."""
    reason = urllib3.exceptions.NewConnectionError(
        None, "Failed to establish a new connection: [Errno 61] Connection refused"
    )
    return requests.exceptions.ConnectionError(urllib3.exceptions.MaxRetryError(None, "/settle", reason))


def dropped_connection():
    """What requests raises when the facilitator (or a proxy) hangs up after the request went out."""
    return requests.exceptions.ConnectionError(
        urllib3.exceptions.ProtocolError("Connection aborted.", ConnectionResetError(54, "Connection reset by peer"))
    )


class TestSettleOutcome(unittest.TestCase):
    """A settle that may still execute is reported as an unknown outcome (exit 3), never as a failure to re-run."""

    def setUp(self):
        self.env = {"CASCET_KEY_PATH": write_test_pem(self)}
        self.hosted_env = {**self.env, "CSPR_CLOUD_TOKEN": "cspr-cloud-key"}

    def run_main(self, argv, env, *, response=None, error=None):
        out = io.StringIO()
        with mock.patch.object(example_settle.requests, "post", return_value=response, side_effect=error) as post:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                code = example_settle.main(argv, env)
        post.assert_called_once()
        self.authorization = post.call_args.kwargs["json"]["paymentPayload"]["payload"]["authorization"]
        return code, out.getvalue()

    def assert_unknown(self, code, out):
        self.assertEqual(code, example_settle.EXIT_OUTCOME_UNKNOWN, out)
        self.assertEqual(code, 3)
        self.assertIn("outcome unknown", out)
        self.assertIn("may still execute", out)
        self.assertIn("can pay twice", out)
        self.assertIn(TEST_KEY.account_hash_hex(), out)  # whose balance to check
        self.assertIn(self.authorization["nonce"], out)
        self.assertIn(f"validBefore {self.authorization['validBefore']}", out)
        self.assertNotIn("❌", out)
        self.assertNotIn("unreachable", out)

    def assert_failed(self, code, out):
        self.assertEqual(code, example_settle.EXIT_FAILED, out)
        self.assertIn("❌", out)
        self.assertNotIn("outcome unknown", out)
        self.assertNotIn("can pay twice", out)

    def test_no_answer_after_the_request_went_out(self):
        for error in (
            requests.exceptions.ReadTimeout("HTTPConnectionPool(host='127.0.0.1', port=4501): Read timed out."),
            dropped_connection(),
            requests.exceptions.ChunkedEncodingError("Connection broken: IncompleteRead(0 bytes read)"),
        ):
            with self.subTest(error=type(error).__name__):
                code, out = self.run_main([], self.env, error=error)
                self.assert_unknown(code, out)
                self.assertIn("no answer came back", out)

    def test_a_request_that_never_left_failed(self):
        for error in (
            refused_connection(),
            requests.exceptions.ConnectTimeout("HTTPSConnectionPool(host='x402-facilitator.cspr.cloud'): timed out"),
            requests.exceptions.SSLError(urllib3.exceptions.MaxRetryError(
                None, "/settle", urllib3.exceptions.SSLError("certificate verify failed"))),
        ):
            with self.subTest(error=type(error).__name__):
                code, out = self.run_main(["--asset", "wcspr"], self.hosted_env, error=error)
                self.assert_failed(code, out)
                self.assertIn("facilitator unreachable", out)

    def test_request_never_left(self):
        self.assertTrue(example_settle.request_never_left(refused_connection()))
        self.assertTrue(example_settle.request_never_left(requests.exceptions.ConnectTimeout("timed out")))
        self.assertFalse(example_settle.request_never_left(dropped_connection()))
        self.assertFalse(example_settle.request_never_left(requests.exceptions.ReadTimeout("read timed out")))
        self.assertFalse(example_settle.request_never_left(requests.exceptions.ConnectionError("no cause")))
        self.assertFalse(example_settle.request_never_left(requests.exceptions.RequestException("anything else")))

    def test_pending_and_unknown_answers(self):
        tx = "cd" * 32
        cases = (
            # CasCet's self-hosted facilitator broadcast the transfer but did not see it execute in time.
            (SettleResponse(200, {}, body={
                "success": False, "errorReason": "settlement_pending", "transaction": tx, "network": TESTNET,
                "errorMessage": "transaction submitted; its execution was not observed yet",
                "extra": {"settlementStatus": "pending"}}), tx),
            # ...or it cannot tell whether its submission went through.
            (SettleResponse(500, {}, body={
                "success": False, "errorReason": "settlement_unknown", "transaction": "", "network": TESTNET,
                "extra": {"settlementStatus": "unknown"}}), None),
            (SettleResponse(200, {}, body={"success": False, "errorReason": "settlement_unknown", "transaction": tx}), tx),
            (SettleResponse(200, {}, body={"success": False, "errorReason": "something_new", "transaction": "",
                                           "extra": {"settlementStatus": "pending"}}), None),
        )
        for response, shown_tx in cases:
            with self.subTest(body=response._body):
                code, out = self.run_main([], self.env, response=response)
                self.assert_unknown(code, out)
                if shown_tx:
                    self.assertIn("https://testnet.cspr.live/transaction/" + shown_tx, out)
                else:
                    self.assertNotIn("cspr.live/transaction/", out)

    def test_a_server_error_that_does_not_say_is_an_unknown_outcome(self):
        gateway_timeout = SettleResponse(504, {})
        gateway_timeout.text = "<html><body>504 Gateway Time-out</body></html>"
        for response in (gateway_timeout, SettleResponse(502, {}, body={"error": "bad gateway"}),
                         SettleResponse(500, {}, body={"error": "internal error"})):
            with self.subTest(status=response.status_code):
                code, out = self.run_main(["--asset", "wcspr"], self.hosted_env, response=response)
                self.assert_unknown(code, out)
                self.assertIn(f"HTTP {response.status_code}", out)

    def test_answers_that_say_nothing_moved_are_failures(self):
        for response in (
            SettleResponse(403, {}, body={"error": "asset_not_allowlisted"}),
            SettleResponse(503, {}, body={"success": False, "errorReason": "facilitator_busy", "transaction": "",
                                          "extra": {"settlementStatus": "not_submitted"}}),
            SettleResponse(200, {}, body={"success": False, "errorReason": "insufficient_funds", "transaction": "",
                                          "extra": {"settlementStatus": "not_submitted"}}),
        ):
            with self.subTest(status=response.status_code):
                code, out = self.run_main([], self.env, response=response)
                self.assert_failed(code, out)

    def test_a_reverted_settle_shows_its_transaction(self):
        tx = "ef" * 32
        reverted = SettleResponse(200, {}, body={
            "success": False, "errorReason": "settlement_failed", "transaction": tx, "network": TESTNET,
            "errorMessage": "transaction execution failed: User error: 64658", "extra": {"settlementStatus": "failed"}})
        code, out = self.run_main([], self.env, response=reverted)
        self.assert_failed(code, out)
        self.assertIn("https://testnet.cspr.live/transaction/" + tx, out)

    def test_a_hosted_failure_without_a_transaction_hash_carries_the_caution(self):
        # @x402/casper 2.29's facilitator drops the hash when anything fails after the broadcast.
        failed = SettleResponse(200, {}, body={
            "success": False, "errorReason": "invalid_exact_casper_facilitator_settle_failed", "transaction": "",
            "errorMessage": "Timed out waiting for transaction", "network": TESTNET})
        code, out = self.run_main(["--asset", "wcspr", "--facilitator", "hosted"], self.hosted_env, response=failed)
        self.assertEqual(code, example_settle.EXIT_FAILED, out)
        self.assertIn("settle failed: invalid_exact_casper_facilitator_settle_failed", out)
        self.assertIn("no transaction hash", out)
        self.assertIn("may still execute", out)
        self.assertIn("can pay twice", out)
        self.assertIn(self.authorization["nonce"], out)
        # The same answer from CasCet's self-hosted facilitator says nothing was broadcast.
        code, out = self.run_main([], self.env, response=failed)
        self.assert_failed(code, out)

    def test_facilitator_text_is_escaped(self):
        hostile = SettleResponse(200, {}, body={"success": False, "errorReason": "bad\x1b[2Jreason", "transaction": "",
                                                "errorMessage": "line\nbreak"})
        code, out = self.run_main([], self.env, response=hostile)
        self.assert_failed(code, out)
        self.assertNotIn("\x1b", out)
        self.assertIn("bad\\x1b[2Jreason", out)
        settled = SettleResponse(200, {}, body={"success": True, "transaction": "not-a-hash\x1b", "network": TESTNET})
        code, out = self.run_main([], self.env, response=settled)
        self.assertEqual(code, example_settle.EXIT_SETTLED, out)
        self.assertNotIn("\x1b", out)
        self.assertNotIn("cspr.live/transaction/", out)


class TestSettleOverSockets(unittest.TestCase):
    """The same outcomes with requests' real transport errors, against a facilitator on 127.0.0.1."""

    def run_main(self, url):
        env = {"CASCET_KEY_PATH": write_test_pem(self)}
        out = io.StringIO()
        with direct_session() as session:  # ignores proxy settings from the environment
            with mock.patch.object(example_settle.requests, "post", side_effect=session.post):
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                    code = example_settle.main(["--facilitator", url], env)
        return code, out.getvalue()

    def test_a_facilitator_that_hangs_up_after_reading_the_request(self):
        def hang_up(handler, server):
            handler.close_connection = True  # read the settle request, answer nothing

        with LocalServer(hang_up) as server:
            code, out = self.run_main(server.url)
        self.assertEqual(code, example_settle.EXIT_OUTCOME_UNKNOWN, out)
        self.assertEqual(len(server.requests), 1)
        self.assertIn("outcome unknown", out)

    def test_a_facilitator_that_does_not_answer_in_time(self):
        def stall(handler, server):
            server.stop.wait(5)
            handler.close_connection = True

        self.assertEqual(example_settle.SETTLE_TIMEOUT, (10, 120))  # (connect, read)
        with mock.patch.object(example_settle, "SETTLE_TIMEOUT", (5, 0.3)), LocalServer(stall) as server:
            code, out = self.run_main(server.url)
        self.assertEqual(code, example_settle.EXIT_OUTCOME_UNKNOWN, out)
        self.assertIn("ReadTimeout", out)

    def test_a_facilitator_that_is_not_listening(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        code, out = self.run_main(f"http://127.0.0.1:{port}")
        self.assertEqual(code, example_settle.EXIT_FAILED, out)
        self.assertIn("facilitator unreachable", out)
        self.assertNotIn("outcome unknown", out)


class GatewayResponse(FakeResponse):
    is_redirect = False
    ok = True
    text = ""


class GatewaySession(FakeSession):
    def close(self):
        pass


class TestGatewayExample(unittest.TestCase):
    def setUp(self):
        self.env = {
            "CASCET_KEY_PATH": write_test_pem(self),
            "CASCET_ALLOWED_PAYTO": SELLER,
            "CASCET_ALLOWED_ASSETS": f"hash-{TOKEN},hash-{WCSPR}",
            "CASCET_MAX_PER_CALL": "1000000000",
            "CASCET_MAX_SESSION": "5000000000",
        }

    def test_allowed_assets_for(self):
        self.assertEqual(example_gateway.allowed_assets_for("legacy", None), [f"hash-{TOKEN}"])
        self.assertEqual(example_gateway.allowed_assets_for(" WCSPR ", " casper:casper-test "), [f"hash-{WCSPR}"])
        self.assertEqual(example_gateway.allowed_assets_for("legacy", f"{MAINNET},{TESTNET}"),
                         [f"hash-{OTHER_TOKEN}", f"hash-{TOKEN}"])
        self.assertEqual(example_gateway.allowed_assets_for("wcspr", f"{MAINNET},{TESTNET}"), [f"hash-{WCSPR}"])
        for asset, networks in (("wcspr", MAINNET), ("usdc", None), ("legacy", "casper:other")):
            with self.subTest(asset=asset, networks=networks):
                with self.assertRaises(ValueError):
                    example_gateway.allowed_assets_for(asset, networks)

    def test_client_environment(self):
        self.assertEqual(example_gateway.client_environment(None, self.env), self.env)
        env = example_gateway.client_environment("wcspr", self.env)
        self.assertEqual(env["CASCET_ALLOWED_ASSETS"], f"hash-{WCSPR}")
        self.assertEqual(self.env["CASCET_ALLOWED_ASSETS"], f"hash-{TOKEN},hash-{WCSPR}")  # the input is not changed
        from_variable = example_gateway.client_environment(None, {**self.env, "CASCET_ASSET": "legacy"})
        self.assertEqual(from_variable["CASCET_ALLOWED_ASSETS"], f"hash-{TOKEN}")
        flag_wins = example_gateway.client_environment("wcspr", {**self.env, "CASCET_ASSET": "legacy"})
        self.assertEqual(flag_wins["CASCET_ALLOWED_ASSETS"], f"hash-{WCSPR}")

    def run_main(self, argv, env):
        settlement = {"success": True, "transaction": "cd" * 32, "network": TESTNET, "payer": TEST_KEY.account_address()}
        header = base64.b64encode(json.dumps(settlement).encode()).decode()
        paid = GatewayResponse(200, {"PAYMENT-RESPONSE": header}, body={"jsonrpc": "2.0", "id": 1, "result": {}})
        session = GatewaySession(
            challenge(make_payment_required(legacy_requirements(), wcspr_requirements(amount="20000000"))), paid
        )
        out, err = io.StringIO(), io.StringIO()
        with mock.patch("requests.Session", return_value=session):
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = example_gateway.main(argv, env)
        return code, session, err.getvalue()

    def paid_asset(self, session):
        payload = x402.decode_payment_signature_header(session.calls[1]["headers"][x402.HEADER_PAYMENT_SIGNATURE])
        return payload["accepted"]["asset"], payload["accepted"]["extra"]["authorizationStyle"]

    def test_pays_in_the_named_asset(self):
        url = "https://gateway.test/mcp"
        code, session, err = self.run_main(["--asset", "wcspr", url, "get_cspr_market_data", "{}"], self.env)
        self.assertEqual(code, 0, err)
        self.assertEqual(self.paid_asset(session), (WCSPR, "cep3009-value"))
        self.assertIn("(cep3009-value)", err)
        code, session, err = self.run_main([url, "get_cspr_market_data", "--asset", "legacy"], self.env)
        self.assertEqual(code, 0, err)
        self.assertEqual(self.paid_asset(session), (TOKEN, "legacy-amount"))

    def test_prefer_styles_from_the_environment(self):
        url = "https://gateway.test/mcp"
        code, session, err = self.run_main([url, "echo"], {**self.env, "CASCET_PREFER_STYLES": "cep3009-value"})
        self.assertEqual(code, 0, err)
        self.assertEqual(self.paid_asset(session), (WCSPR, "cep3009-value"))
        code, session, err = self.run_main([url, "echo"], self.env)
        self.assertEqual(code, 0, err)
        self.assertEqual(self.paid_asset(session), (TOKEN, "legacy-amount"))  # the gateway's order

    def test_configuration_errors(self):
        url = "https://gateway.test/mcp"
        for argv, env in (
            (["--asset", "wcspr", url, "echo"], {**self.env, "CASCET_NETWORK": MAINNET}),
            (["--asset", "usdc", url, "echo"], self.env),
            ([url, "echo"], {**self.env, "CASCET_PREFER_STYLES": "value"}),
        ):
            with self.subTest(argv=argv):
                code, session, err = self.run_main(argv, env)
                self.assertEqual(code, 2)
                self.assertIn("configuration error", err)
                self.assertEqual(session.calls, [])
        code, session, _ = self.run_main([url], self.env)  # the tool is missing
        self.assertEqual(code, 2)
        self.assertEqual(session.calls, [])


if __name__ == "__main__":
    unittest.main()
