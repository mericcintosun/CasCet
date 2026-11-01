"""PayingClient: the TypeScript client's guard rails (allowlists, networks, amounts, budgets, timeout)."""
import os
import socket
import tempfile
import threading
import time
import unittest
import warnings

from cryptography.hazmat.primitives import serialization

from helpers import (
    MAINNET, OTHER_SELLER, OTHER_TOKEN, SELLER, TEST_KEY, TESTNET, TOKEN,
    FakeResponse, FakeSession, challenge, make_payment_required, make_requirements, quiet_client, reset_warnings, x402,
)

OK = FakeResponse(200, {}, body={"jsonrpc": "2.0", "id": 1, "result": {}})


def pay(client, *accepts, **extra):
    return client.create_payment_payload(make_payment_required(*accepts, **extra))


class TestNetworkPolicy(unittest.TestCase):
    def test_default_is_testnet_only(self):
        client = quiet_client()
        self.assertEqual(client.networks, (TESTNET,))
        pay(client)  # testnet is fine
        with self.assertRaises(x402.PaymentAborted) as ctx:
            pay(client, make_requirements(network=MAINNET))
        self.assertIn("network casper:casper is not allowed", str(ctx.exception))

    def test_explicit_networks(self):
        client = quiet_client(networks=[MAINNET])
        pay(client, make_requirements(network=MAINNET))
        with self.assertRaises(x402.PaymentAborted):
            pay(client, make_requirements(network=TESTNET))

    def test_bad_network_lists(self):
        for networks in ([], ["casper:*"], ["*"], ["eip155:8453"], ["casper:"], [None]):
            with self.subTest(networks=networks):
                with self.assertRaises(ValueError):
                    quiet_client(networks=networks)

    def test_unknown_network_spelling_is_not_matched_loosely(self):
        client = quiet_client(networks=[TESTNET])
        for network in ("casper:casper-test2", "CASPER:casper-test", "casper:casper-test "):
            with self.subTest(network=network):
                with self.assertRaises(x402.PaymentAborted):
                    pay(client, make_requirements(network=network))


class TestAllowlists(unittest.TestCase):
    def test_pay_to_not_allowlisted(self):
        client = quiet_client()
        with self.assertRaises(x402.PaymentAborted) as ctx:
            pay(client, make_requirements(payTo=OTHER_SELLER))
        self.assertIn("is not allowlisted", str(ctx.exception))
        self.assertEqual(client.spending(), {})

    def test_asset_not_allowlisted(self):
        client = quiet_client()
        with self.assertRaises(x402.PaymentAborted) as ctx:
            pay(client, make_requirements(asset=OTHER_TOKEN))
        self.assertIn("asset", str(ctx.exception))

    def test_allowlist_spellings_are_normalized(self):
        client = quiet_client(
            allowed_pay_to=["account-hash-" + SELLER[2:].upper()],
            allowed_assets=["hash-" + TOKEN.upper()],
        )
        pay(client, make_requirements(payTo=SELLER.upper(), asset=TOKEN))

    def test_public_key_in_allowlist_is_refused_with_the_payto_hint(self):
        public_key = TEST_KEY.public_key_hex()
        with self.assertRaises(ValueError) as ctx:
            quiet_client(allowed_pay_to=[public_key])
        self.assertIn(TEST_KEY.account_address(), str(ctx.exception))
        self.assertIn("account-hash", str(ctx.exception))
        with self.assertRaises(ValueError):
            quiet_client(allowed_pay_to=["02" + "ab" * 33])

    def test_malformed_allowlist_entries(self):
        for entry in ("", "00abc", "hash-xyz", "account-hash-" + "ab" * 31, 42):
            with self.subTest(entry=entry):
                with self.assertRaises(ValueError):
                    quiet_client(allowed_pay_to=[entry])
        for entry in ("", "hash-xyz", "ab" * 31, "00" + "ab" * 32):
            with self.subTest(asset=entry):
                with self.assertRaises(ValueError):
                    quiet_client(allowed_assets=[entry])

    def test_contract_package_payee(self):
        payee = "01" + "cd" * 32
        open_client = quiet_client(allowed_pay_to=None)
        with self.assertRaises(x402.PaymentAborted) as ctx:
            pay(open_client, make_requirements(payTo=payee))
        self.assertIn("01 tag", str(ctx.exception))
        pinned = quiet_client(allowed_pay_to=["hash-" + "cd" * 32])
        pay(pinned, make_requirements(payTo=payee))

    def test_empty_allowlist_pays_nobody(self):
        with self.assertRaises(x402.PaymentAborted):
            pay(quiet_client(allowed_pay_to=[]))

    def test_first_acceptable_entry_is_chosen(self):
        client = quiet_client()
        payload = pay(
            client,
            make_requirements(network=MAINNET),
            make_requirements(asset=OTHER_TOKEN),
            make_requirements(amount="7"),
        )
        self.assertEqual(payload["accepted"]["amount"], "7")

    def test_every_rejection_is_reported(self):
        client = quiet_client()
        with self.assertRaises(x402.PaymentAborted) as ctx:
            pay(client, make_requirements(network=MAINNET), make_requirements(payTo=OTHER_SELLER))
        message = str(ctx.exception)
        self.assertIn("accepts[0]: network", message)
        self.assertIn("accepts[1]: payTo", message)

    def test_no_accepts(self):
        client = quiet_client()
        for pr in ({"x402Version": 2, "accepts": []}, {"x402Version": 2}, {"accepts": "x"}, None):
            with self.subTest(payment_required=pr):
                with self.assertRaises(x402.PaymentAborted):
                    client.create_payment_payload(pr)


class TestAmountsAndBudgets(unittest.TestCase):
    def test_malformed_amount_in_the_402_aborts(self):
        client = quiet_client()
        for amount in ("-1000000", "0", "0x10", "1e5", " 5", "", 5):
            with self.subTest(amount=amount):
                with self.assertRaises(x402.PaymentAborted) as ctx:
                    pay(client, make_requirements(amount=amount))
                self.assertIn("amount", str(ctx.exception))
        self.assertEqual(client.spending(), {})

    def test_negative_amount_cannot_reset_the_session_budget(self):
        # Regression for M32: with a 100-unit cap, 90 is fine, -1000000 must abort, and 90 more is over budget.
        client = quiet_client(max_per_call_raw=None, max_session_raw=100)
        pay(client, make_requirements(amount="90"))
        with self.assertRaises(x402.PaymentAborted):
            pay(client, make_requirements(amount="-1000000"))
        with self.assertRaises(x402.PaymentAborted):
            pay(client, make_requirements(amount="90"))
        self.assertEqual(client.spent_raw(TOKEN), 90)

    def test_per_call_budget(self):
        client = quiet_client(max_per_call_raw="500000000")
        pay(client, make_requirements(amount="500000000"))
        with self.assertRaises(x402.PaymentAborted) as ctx:
            pay(client, make_requirements(amount="500000001"))
        self.assertIn("per-call budget", str(ctx.exception))

    def test_session_budget_is_per_asset(self):
        client = quiet_client(allowed_assets=[TOKEN, OTHER_TOKEN], max_per_call_raw=None, max_session_raw="1000")
        pay(client, make_requirements(amount="600"))
        pay(client, make_requirements(amount="400"))
        with self.assertRaises(x402.PaymentAborted) as ctx:
            pay(client, make_requirements(amount="1"))
        self.assertIn("session budget", str(ctx.exception))
        pay(client, make_requirements(asset=OTHER_TOKEN, amount="1000"))
        self.assertEqual(client.spending(), {TOKEN: 1000, OTHER_TOKEN: 1000})
        self.assertEqual(client.spent_raw("hash-" + TOKEN), 1000)

    def test_zero_budget_pays_nothing(self):
        with self.assertRaises(x402.PaymentAborted):
            pay(quiet_client(max_per_call_raw=0), make_requirements(amount="1"))

    def test_budget_values_are_validated(self):
        for bad in ("", "-1", "0x10", "1e9", " 5", "5.0", True, 5.0, -1, 10**40, "1" * 41):
            with self.subTest(budget=bad):
                with self.assertRaises(ValueError):
                    quiet_client(max_session_raw=bad)
        quiet_client(max_per_call_raw="0", max_session_raw=0)
        quiet_client(max_per_call_raw=100, max_session_raw="100")

    def test_failed_signing_releases_the_reservation(self):
        client = quiet_client(max_session_raw="500000000")

        def boom(digest):
            raise RuntimeError("hsm offline")

        client._key = x402.CasperKey(TEST_KEY._sk, TEST_KEY.public_key_bytes)
        client._key.sign = boom  # type: ignore[method-assign]
        with self.assertRaises(RuntimeError):
            pay(client)
        self.assertEqual(client.spending(), {})
        client._key = TEST_KEY
        pay(client)  # the whole budget is still available

    def test_concurrent_payments_respect_the_session_budget(self):
        client = quiet_client(max_per_call_raw=None, max_session_raw="100")
        results = []

        def worker():
            try:
                pay(client, make_requirements(amount="10"))
                results.append("paid")
            except x402.PaymentAborted:
                results.append("aborted")

        threads = [threading.Thread(target=worker) for _ in range(25)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(results.count("paid"), 10)
        self.assertEqual(client.spent_raw(TOKEN), 100)

    def test_on_payment_callback(self):
        seen = []
        client = quiet_client(on_payment=seen.append)
        pay(client)
        self.assertEqual(seen, [{"amount_raw": "500000000", "pay_to": SELLER, "asset": TOKEN, "network": TESTNET}])


class TestWarnings(unittest.TestCase):
    def setUp(self):
        reset_warnings()

    def tearDown(self):
        reset_warnings()

    def test_missing_allowlists_and_budget_warn_once(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            x402.PayingClient(TEST_KEY)
            x402.PayingClient(TEST_KEY)
        messages = [str(w.message) for w in caught if issubclass(w.category, x402.InsecurePaymentConfigWarning)]
        self.assertEqual(len(messages), 2)
        self.assertTrue(any("allowed_pay_to" in m for m in messages))
        self.assertTrue(any("unlimited" in m for m in messages))

    def test_fully_configured_client_is_quiet(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            quiet_client()
        self.assertEqual([w for w in caught if issubclass(w.category, x402.InsecurePaymentConfigWarning)], [])


class TestHttpFlow(unittest.TestCase):
    def test_non_402_passes_through(self):
        session = FakeSession(OK)
        client = quiet_client(session=session)
        self.assertIs(client.get("https://gw.test/health"), OK)
        self.assertEqual(len(session.calls), 1)
        self.assertEqual(client.spending(), {})

    def test_402_is_paid_and_retried_once(self):
        pr = make_payment_required()
        session = FakeSession(challenge(pr), OK)
        client = quiet_client(session=session)
        body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "echo", "arguments": {}}}
        response = client.post("https://gw.test/mcp", json=body, headers={"accept": "application/json"})
        self.assertIs(response, OK)
        first, retry = session.calls
        self.assertNotIn(x402.HEADER_PAYMENT_SIGNATURE, first["headers"])
        self.assertEqual((retry["method"], retry["url"], retry["json"]), ("POST", "https://gw.test/mcp", body))
        self.assertEqual(retry["headers"]["accept"], "application/json")
        payload = x402.decode_payment_signature_header(retry["headers"][x402.HEADER_PAYMENT_SIGNATURE])
        self.assertEqual(payload["accepted"], pr["accepts"][0])
        self.assertEqual(payload["resource"], pr["resource"])
        self.assertEqual(client.spent_raw(TOKEN), 500000000)

    def test_second_402_is_returned_not_paid_again(self):
        rejected = challenge(make_payment_required(error="No matching payment requirements"))
        session = FakeSession(challenge(), rejected)
        client = quiet_client(session=session)
        response = client.post("https://gw.test/mcp", json={})
        self.assertIs(response, rejected)
        self.assertEqual(x402.parse_payment_required(response)["error"], "No matching payment requirements")
        self.assertEqual(len(session.calls), 2)
        self.assertEqual(client.spent_raw(TOKEN), 500000000)  # signed once, counted once, never refunded

    def test_caller_supplied_payment_header_is_not_overridden(self):
        session = FakeSession(challenge())
        client = quiet_client(session=session)
        response = client.post("https://gw.test/mcp", json={}, headers={"payment-signature": "abc"})
        self.assertEqual(response.status_code, 402)
        self.assertEqual(len(session.calls), 1)

    def test_policy_abort_sends_nothing(self):
        session = FakeSession(challenge(make_payment_required(make_requirements(payTo=OTHER_SELLER))))
        client = quiet_client(session=session)
        with self.assertRaises(x402.PaymentAborted):
            client.post("https://gw.test/mcp", json={})
        self.assertEqual(len(session.calls), 1)

    def test_parent_id_header(self):
        session = FakeSession(challenge(), OK)
        client = quiet_client(session=session, parent_id="pay-123")
        client.post("https://gw.test/mcp", json={})
        self.assertEqual([c["headers"][x402.HEADER_CASCET_PARENT_ID] for c in session.calls], ["pay-123", "pay-123"])

    def test_timeout_default_and_overrides(self):
        session = FakeSession(challenge(), OK, OK)
        client = quiet_client(session=session)
        client.post("https://gw.test/mcp", json={})
        self.assertEqual([c["timeout"] for c in session.calls], [30.0, 30.0])
        client.get("https://gw.test/health", timeout=2)
        self.assertEqual(session.calls[-1]["timeout"], 2)
        self.assertEqual(x402.DEFAULT_TIMEOUT_SECONDS, 30.0)

    def test_timeout_validation(self):
        quiet_client(timeout=(3.05, 27))
        quiet_client(timeout=None)
        for bad in (0, -1, "30", True, float("inf"), (1, 0), (1,)):
            with self.subTest(timeout=bad):
                with self.assertRaises(ValueError):
                    quiet_client(timeout=bad)


class TestTransportGuard(unittest.TestCase):
    def test_refuses_to_pay_over_plain_http_to_a_remote_host(self):
        for url in ("http://gw.example.com/mcp", "http://10.0.0.5:4402/mcp", "http://localhost.evil.test/mcp"):
            with self.subTest(url=url):
                session = FakeSession(challenge(url=url))
                client = quiet_client(session=session)
                with self.assertRaises(x402.PaymentAborted) as ctx:
                    client.post(url, json={})
                self.assertIn("https", str(ctx.exception))
                self.assertEqual(client.spending(), {})
                self.assertEqual(len(session.calls), 1)

    def test_redirect_to_plain_http_is_refused(self):
        session = FakeSession(challenge(url="http://gw.example.com/mcp"))
        client = quiet_client(session=session)
        with self.assertRaises(x402.PaymentAborted):
            client.post("https://gw.example.com/mcp", json={})

    def test_loopback_and_https_are_allowed(self):
        for url in ("http://127.0.0.1:4402/mcp", "http://localhost:4402/mcp", "http://[::1]:4402/mcp", "https://gw.example.com/mcp"):
            with self.subTest(url=url):
                session = FakeSession(challenge(url=url), OK)
                quiet_client(session=session).post(url, json={})
                self.assertEqual(len(session.calls), 2)

    def test_explicit_opt_out(self):
        url = "http://gw.lan:4402/mcp"
        session = FakeSession(challenge(url=url), OK)
        quiet_client(session=session, allow_insecure_http=True).post(url, json={})
        self.assertEqual(len(session.calls), 2)


class TestRealHttpTimeout(unittest.TestCase):
    """A gateway that accepts the connection and never answers must not hang the buyer."""

    def test_read_timeout(self):
        import requests

        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]
        release = threading.Event()

        def silent_server():
            try:
                conn, _ = server.accept()
            except OSError:
                return
            with conn:
                release.wait(5)  # hold the connection open without answering (bounded, so a bug fails fast)

        thread = threading.Thread(target=silent_server, daemon=True)
        thread.start()
        client = quiet_client(timeout=0.3)
        try:
            started = time.monotonic()
            with self.assertRaises(requests.exceptions.Timeout):
                client.get(f"http://127.0.0.1:{port}/mcp")
            self.assertLess(time.monotonic() - started, 4)
        finally:
            client.close()
            release.set()
            server.close()
            thread.join(2)


class TestFromEnv(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pem_path = os.path.join(self.tmp.name, "payer.pem")
        with open(self.pem_path, "wb") as f:
            f.write(TEST_KEY._sk.private_bytes(
                serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        self.env = {
            "CASCET_KEY_PATH": self.pem_path,
            "CASCET_ALLOWED_PAYTO": f" {SELLER} , account-hash-{'ab' * 32}",
            "CASCET_ALLOWED_ASSETS": f"hash-{TOKEN}",
            "CASCET_MAX_PER_CALL": "500000000",
            "CASCET_MAX_SESSION": "1000000000",
        }

    def tearDown(self):
        self.tmp.cleanup()

    def test_full_configuration(self):
        client = x402.PayingClient.from_env(self.env)
        self.assertEqual(client.networks, (TESTNET,))
        pay(client)
        with self.assertRaises(x402.PaymentAborted):
            pay(client, make_requirements(amount="500000001"))

    def test_network_list(self):
        client = x402.PayingClient.from_env({**self.env, "CASCET_NETWORK": "casper:casper, casper:casper-test"})
        self.assertEqual(client.networks, (MAINNET, TESTNET))

    def test_key_is_required(self):
        env = dict(self.env)
        del env["CASCET_KEY_PATH"]
        with self.assertRaises(ValueError):
            x402.PayingClient.from_env(env)
        x402.PayingClient.from_env(env, key=TEST_KEY)

    def test_allowlists_are_required_unless_opted_out(self):
        for missing in ("CASCET_ALLOWED_PAYTO", "CASCET_ALLOWED_ASSETS"):
            with self.subTest(missing=missing):
                env = {k: v for k, v in self.env.items() if k != missing}
                with self.assertRaises(ValueError) as ctx:
                    x402.PayingClient.from_env(env)
                self.assertIn("CASCET_ALLOW_ANY_SELLER", str(ctx.exception))
                with self.assertRaises(ValueError):
                    x402.PayingClient.from_env({**env, "CASCET_ALLOW_ANY_SELLER": "true"})
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", x402.InsecurePaymentConfigWarning)
                    x402.PayingClient.from_env({**env, "CASCET_ALLOW_ANY_SELLER": "1"})

    def test_budget_is_required_unless_opted_out(self):
        for missing in ("CASCET_MAX_PER_CALL", "CASCET_MAX_SESSION"):
            with self.subTest(missing=missing):
                env = {k: v for k, v in self.env.items() if k != missing}
                with self.assertRaises(ValueError) as ctx:
                    x402.PayingClient.from_env(env)
                self.assertIn("CASCET_ALLOW_UNLIMITED_BUDGET", str(ctx.exception))
                with self.assertRaises(ValueError):
                    x402.PayingClient.from_env({**env, missing: ""})
                x402.PayingClient.from_env({**env, "CASCET_ALLOW_UNLIMITED_BUDGET": "1"})

    def test_bad_budget_value(self):
        with self.assertRaises(ValueError):
            x402.PayingClient.from_env({**self.env, "CASCET_MAX_SESSION": "-1"})


if __name__ == "__main__":
    unittest.main()
