"""PayingClient: the TypeScript client's guard rails (allowlists, networks, amounts, budgets, deadline, redirects)."""
import base64
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import warnings
from unittest import mock

import requests
from cryptography.hazmat.primitives import serialization

from helpers import (
    DELETE, MAINNET, NOW, OTHER_SELLER, OTHER_TOKEN, SELLER, TEST_KEY, TESTNET, TOKEN,
    CaseInsensitive, FakeResponse, FakeSession, LocalServer, challenge, direct_session, drip, make_payment_required,
    make_requirements, quiet_client, reset_warnings, send, send_challenge, x402,
)

OK = FakeResponse(200, {}, body={"jsonrpc": "2.0", "id": 1, "result": {}})
PRICE = 500000000  # make_requirements()'s amount


def pay(client, *accepts, **extra):
    return client.create_payment_payload(make_payment_required(*accepts, **extra))


def signature_json(call):
    """The raw JSON text inside a recorded call's PAYMENT-SIGNATURE header."""
    return base64.b64decode(call["headers"][x402.HEADER_PAYMENT_SIGNATURE]).decode("utf-8")


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
        for networks in (
            [], ["casper:*"], ["*"], ["eip155:8453"], ["casper:"], [None], ["CASPER:casper"],
            ["casper:casper casper:casper-test"],  # a space instead of a comma: one id that matches nothing
            ["casper:" + "a" * 33], ["casper:caspér"],
        ):
            with self.subTest(networks=networks):
                with self.assertRaises(ValueError):
                    quiet_client(networks=networks)

    def test_network_ids_are_trimmed_and_none_means_the_default(self):
        self.assertEqual(quiet_client(networks=[" casper:casper-test "]).networks, (TESTNET,))
        self.assertEqual(quiet_client(networks=None).networks, (TESTNET,))
        self.assertEqual(quiet_client(networks=MAINNET).networks, (MAINNET,))

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
        # Refused everywhere, as in the TS client: no facilitator in use credits a "01" payee correctly.
        payee = "01" + "cd" * 32
        open_client = quiet_client(allowed_pay_to=None)
        with self.assertRaises(x402.PaymentAborted) as ctx:
            pay(open_client, make_requirements(payTo=payee))
        self.assertIn("01 tag", str(ctx.exception))
        self.assertIn(x402.CONTRACT_PAYEE_REASON, str(ctx.exception))
        # Pinning it is a configuration error, not a way to pay it ...
        # (A bare "01" + 64 hex entry is refused as a public key: test_public_key_in_allowlist_is_refused...)
        for entry in ("hash-" + "cd" * 32, "package-hash-" + "cd" * 32, " HASH-" + "CD" * 32):
            with self.subTest(entry=entry):
                with self.assertRaises(ValueError) as ctx:
                    quiet_client(allowed_pay_to=[entry])
                self.assertIn("contract-package payee", str(ctx.exception))
        # ... and an account hash with the same 32 bytes does not let the 01 key through either.
        pinned = quiet_client(allowed_pay_to=["00" + "cd" * 32])
        with self.assertRaises(x402.PaymentAborted) as ctx:
            pay(pinned, make_requirements(payTo=payee))
        self.assertIn("01 tag", str(ctx.exception))
        self.assertEqual(pinned.spending(), {})

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


class TestEip712Domain(unittest.TestCase):
    """An entry without a usable extra.name or extra.version is skipped, as by the TS client, and nothing is reserved for it."""

    UNUSABLE = (
        {"version": "1"},
        {"name": "CasCet X402 Token"},
        {"name": "", "version": "1"},
        {"name": "CasCet X402 Token", "version": 1},
        {"name": "x" * 101, "version": "1"},
        {"name": "CasCet X402 Token", "version": "1" * 21},
    )

    def test_the_next_entry_is_paid(self):
        for extra in self.UNUSABLE:
            with self.subTest(extra=extra):
                client = quiet_client()
                payload = pay(client, make_requirements(extra=extra), make_requirements(amount="7"))
                self.assertEqual(payload["accepted"]["amount"], "7")
                self.assertEqual(client.spending(), {TOKEN: 7})

    def test_every_unusable_domain_is_reported(self):
        client = quiet_client()
        with self.assertRaises(x402.PaymentAborted) as ctx:
            pay(client, *(make_requirements(extra=extra) for extra in self.UNUSABLE))
        message = str(ctx.exception)
        self.assertIn("accepts[0]: malformed EIP-712 domain: extra.name is missing", message)
        self.assertIn("accepts[1]: malformed EIP-712 domain: extra.version is missing", message)
        self.assertIn("accepts[4]: malformed EIP-712 domain: extra.name is 101 characters long", message)
        self.assertIn("accepts[5]: malformed EIP-712 domain: extra.version is 21 characters long", message)
        self.assertEqual(client.spending(), {})


class TestValidityWindow(unittest.TestCase):
    """maxTimeoutSeconds is capped like the TS SpendPolicy's maxAuthorizationSeconds (default 900)."""

    def test_default_limit_is_900_seconds(self):
        self.assertEqual(x402.MAX_VALIDITY_SECONDS, 900)
        client = quiet_client()
        payload = client.create_payment_payload(make_payment_required(make_requirements(maxTimeoutSeconds=900)), now=NOW)
        self.assertEqual(payload["payload"]["authorization"]["validBefore"], str(NOW + 900))
        with self.assertRaises(x402.PaymentAborted) as ctx:
            pay(client, make_requirements(maxTimeoutSeconds=901))
        self.assertIn("above this client's 900 s limit", str(ctx.exception))
        self.assertEqual(client.spent_raw(TOKEN), PRICE)

    def test_missing_or_malformed_max_timeout_is_refused(self):
        client = quiet_client()
        with self.assertRaises(x402.PaymentAborted) as ctx:
            pay(client, make_requirements(maxTimeoutSeconds=DELETE))
        self.assertIn("maxTimeoutSeconds is missing", str(ctx.exception))
        for bad in (0, -1, "300", 1.5, True, None):
            with self.subTest(maxTimeoutSeconds=bad):
                with self.assertRaises(x402.PaymentAborted) as ctx:
                    pay(client, make_requirements(maxTimeoutSeconds=bad))
                self.assertIn("maxTimeoutSeconds", str(ctx.exception))
        self.assertEqual(client.spending(), {})

    def test_custom_limit(self):
        client = quiet_client(max_authorization_seconds=60)
        payload = client.create_payment_payload(make_payment_required(make_requirements(maxTimeoutSeconds=60)), now=NOW)
        self.assertEqual(payload["payload"]["authorization"]["validBefore"], str(NOW + 60))
        with self.assertRaises(x402.PaymentAborted):
            pay(client, make_requirements(maxTimeoutSeconds=61))

    def test_a_higher_limit_is_honoured_when_signing(self):
        client = quiet_client(max_authorization_seconds=3600)
        payload = client.create_payment_payload(make_payment_required(make_requirements(maxTimeoutSeconds=3600)), now=NOW)
        self.assertEqual(payload["payload"]["authorization"]["validBefore"], str(NOW + 3600))

    def test_the_next_entry_is_tried(self):
        payload = pay(quiet_client(), make_requirements(maxTimeoutSeconds=86400), make_requirements(amount="7"))
        self.assertEqual(payload["accepted"]["amount"], "7")

    def test_limit_validation(self):
        for bad in (0, -1, True, 1.5, "900", None):
            with self.subTest(max_authorization_seconds=bad):
                with self.assertRaises(ValueError):
                    quiet_client(max_authorization_seconds=bad)


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

    def test_zero_budget_is_refused(self):
        # Like the TS client's parseRawAmount: a budget is > 0; leave it unset for no limit.
        for option in ("max_per_call_raw", "max_session_raw"):
            for zero in (0, "0", "00"):
                with self.subTest(option=option, value=zero):
                    with self.assertRaises(ValueError) as ctx:
                        quiet_client(**{option: zero})
                    self.assertIn("greater than zero", str(ctx.exception))

    def test_budget_values_are_validated(self):
        for bad in ("", "-1", "0x10", "1e9", " 5", "5.0", True, 5.0, -1, 0, "0", 10**40, "1" * 41):
            with self.subTest(budget=bad):
                with self.assertRaises(ValueError):
                    quiet_client(max_session_raw=bad)
        quiet_client(max_per_call_raw="1", max_session_raw=1)
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

    def test_failed_header_encoding_releases_the_reservation(self):
        seen = []
        client = quiet_client(max_session_raw="500000000", on_payment=seen.append)
        # NaN cannot be written as JSON, so the PAYMENT-SIGNATURE header cannot be built.
        with self.assertRaises(ValueError):
            pay(client, resource={"url": "https://gw.test/tools/echo", "weight": float("nan")})
        self.assertEqual(client.spending(), {})
        self.assertEqual(seen, [])  # nothing was reported as authorized
        pay(client)  # the whole budget is still available
        self.assertEqual(len(seen), 1)

    def test_concurrent_payments_respect_the_session_budget(self):
        # Switch threads as often as possible and release all workers at once, so an
        # unlocked check-then-reserve would overshoot the budget in some trials.
        previous = sys.getswitchinterval()
        sys.setswitchinterval(1e-6)
        try:
            for trial in range(100):
                client = quiet_client(max_per_call_raw=None, max_session_raw="100")
                barrier = threading.Barrier(25)
                results = []

                def worker():
                    barrier.wait()
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
                with self.subTest(trial=trial):
                    self.assertEqual(results.count("paid"), 10)
                    self.assertEqual(client.spent_raw(TOKEN), 100)
        finally:
            sys.setswitchinterval(previous)

    def test_on_payment_callback(self):
        seen = []
        client = quiet_client(on_payment=seen.append)
        pay(client)
        # TOKEN is CasCet's testnet x402 token: reported with the style the client knows for it.
        self.assertEqual(seen, [{"amount_raw": "500000000", "pay_to": SELLER, "asset": TOKEN, "network": TESTNET,
                                 "authorization_style": "legacy-amount"}])


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
        self.assertEqual(client.spent_raw(TOKEN), PRICE)

    def test_second_402_is_returned_not_paid_again(self):
        rejected = challenge(make_payment_required(error="No matching payment requirements"))
        session = FakeSession(challenge(), rejected)
        client = quiet_client(session=session)
        response = client.post("https://gw.test/mcp", json={})
        self.assertIs(response, rejected)
        self.assertEqual(x402.parse_payment_required(response)["error"], "No matching payment requirements")
        self.assertEqual(len(session.calls), 2)
        self.assertEqual(client.spent_raw(TOKEN), PRICE)  # signed once, counted once, never refunded

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

    def test_parent_id_validation(self):
        for bad in ("", "has space", "line\nbreak", "x" * 129, 42):
            with self.subTest(parent_id=bad):
                with self.assertRaises(ValueError):
                    quiet_client(parent_id=bad)

    def test_redirects_are_never_followed(self):
        session = FakeSession(challenge(), OK)
        client = quiet_client(session=session)
        client.post("https://gw.test/mcp", json={}, allow_redirects=True)  # the caller's value is overridden
        self.assertEqual([c["allow_redirects"] for c in session.calls], [False, False])
        self.assertEqual([c["stream"] for c in session.calls], [True, True])

    def test_deadline_is_passed_on_as_the_time_left(self):
        def slow_challenge(call):
            time.sleep(0.1)
            return challenge()

        session = FakeSession(slow_challenge, OK, OK)
        client = quiet_client(session=session)
        client.post("https://gw.test/mcp", json={})
        first, retry = (c["timeout"] for c in session.calls[:2])
        for connect, read in (first, retry):
            self.assertEqual(connect, read)
            self.assertTrue(29 < connect <= 30, connect)
        self.assertLess(retry[0], first[0] - 0.09)  # the retry only gets what the 402 left over
        client.get("https://gw.test/health", timeout=2)
        self.assertTrue(1.5 < session.calls[-1]["timeout"][0] <= 2)
        self.assertEqual(x402.DEFAULT_TIMEOUT_SECONDS, 30.0)

    def test_no_deadline(self):
        session = FakeSession(challenge(), OK)
        quiet_client(session=session, timeout=None).post("https://gw.test/mcp", json={})
        self.assertEqual([c["timeout"] for c in session.calls], [None, None])

    def test_timeout_validation(self):
        quiet_client(timeout=None)
        quiet_client(timeout=0.5)
        quiet_client(timeout=2_147_483.647)
        for bad in (0, -1, "30", True, float("inf"), float("nan"), 2_147_484, (3.05, 27), (1, 0), (1,)):
            with self.subTest(timeout=bad):
                with self.assertRaises(ValueError):
                    quiet_client(timeout=bad)
        with self.assertRaises(ValueError):
            quiet_client(session=FakeSession(OK)).get("https://gw.test/health", timeout=(3.05, 27))

    def test_nothing_is_signed_once_the_deadline_has_passed(self):
        # The 402 arrives in time, but reading it uses up the deadline: the client must not sign.
        class SlowHeaders(CaseInsensitive):
            def get(self, key, default=None):
                time.sleep(0.3)
                return super().get(key, default)

        slow = challenge()
        slow.headers = SlowHeaders(slow.headers)
        session = FakeSession(slow)
        client = quiet_client(session=session, timeout=0.2)
        with self.assertRaises(requests.exceptions.Timeout):
            client.post("https://gw.test/mcp", json={})
        self.assertEqual(len(session.calls), 1)
        self.assertEqual(client.spending(), {})

    def test_a_response_that_arrives_after_the_deadline_is_closed(self):
        closed = threading.Event()

        class LateResponse(FakeResponse):
            def close(self):
                closed.set()

        def late(call):
            time.sleep(0.4)
            return LateResponse(200, {}, body={})

        client = quiet_client(session=FakeSession(late), timeout=0.1)
        started = time.monotonic()
        with self.assertRaises(requests.exceptions.Timeout):
            client.get("https://gw.test/health")
        self.assertLess(time.monotonic() - started, 0.35)  # the caller did not wait for the session
        self.assertTrue(closed.wait(2))  # nobody will read it, so it is closed

    def test_session_errors_reach_the_caller(self):
        def refused(call):
            raise requests.exceptions.ConnectionError("connection refused")

        client = quiet_client(session=FakeSession(refused))
        with self.assertRaises(requests.exceptions.ConnectionError):
            client.get("https://gw.test/health")
        self.assertEqual(client.spending(), {})

    def test_on_payment_errors_are_reported_not_raised(self):
        def broken_hook(info):
            raise RuntimeError("dashboard offline")

        session = FakeSession(challenge(), OK)
        client = quiet_client(session=session, on_payment=broken_hook)
        with self.assertWarns(RuntimeWarning) as ctx:
            response = client.post("https://gw.test/mcp", json={})
        self.assertIn("dashboard offline", str(ctx.warning))
        self.assertIs(response, OK)
        self.assertEqual(len(session.calls), 2)  # the signed payment was still sent
        self.assertEqual(client.spent_raw(TOKEN), PRICE)

    def test_header_failure_before_the_retry_releases_the_budget(self):
        seen = []
        session = FakeSession(challenge(), OK)
        client = quiet_client(session=session, on_payment=seen.append)
        with mock.patch.object(x402, "payment_signature_header", side_effect=RuntimeError("encoder bug")):
            with self.assertRaises(RuntimeError):
                client.post("https://gw.test/mcp", json={})
        self.assertEqual(len(session.calls), 1)
        self.assertEqual(client.spending(), {})
        self.assertEqual(seen, [])

    def test_lone_surrogate_in_the_402_is_paid_and_echoed_like_json_stringify(self):
        # Valid JSON, and @x402/core handles it: a hostile 402 must not break the header after the budget is reserved.
        pr = make_payment_required()
        pr["resource"]["description"] = "Paid MCP tool: \ud800 echo"
        session = FakeSession(challenge(pr), OK)
        client = quiet_client(session=session)
        self.assertIs(client.post("https://gw.test/mcp", json={}), OK)
        retry = session.calls[1]
        self.assertIn("Paid MCP tool: \\ud800 echo", signature_json(retry))
        payload = x402.decode_payment_signature_header(retry["headers"][x402.HEADER_PAYMENT_SIGNATURE])
        self.assertEqual(payload["resource"], pr["resource"])
        self.assertEqual(client.spent_raw(TOKEN), PRICE)


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

    def test_a_session_that_ends_on_plain_http_is_refused(self):
        # Defence in depth for a custom session that followed a redirect despite allow_redirects=False.
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


class TestRealHttp(unittest.TestCase):
    """The same guarantees over real sockets and the real requests/urllib3 stack."""

    def client(self, **kwargs):
        session = direct_session()
        self.addCleanup(session.close)
        return quiet_client(session=session, **kwargs)

    def test_silent_gateway_times_out(self):
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
        try:
            started = time.monotonic()
            with self.assertRaises(requests.exceptions.Timeout):
                self.client(timeout=0.3).get(f"http://127.0.0.1:{port}/mcp")
            self.assertLess(time.monotonic() - started, 4)
        finally:
            release.set()
            server.close()
            thread.join(2)

    def test_slow_drip_body_is_cut_off_at_the_deadline(self):
        # Each byte arrives well within a socket read timeout, so only a deadline for the whole call stops it.
        with LocalServer(lambda handler, srv: drip(handler, srv, b'{"result":1}', 0.5)) as gateway:
            started = time.monotonic()
            with self.assertRaises(requests.exceptions.Timeout):
                self.client(timeout=1.0).get(gateway.url + "/mcp")
            elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, 0.9)
        self.assertLess(elapsed, 3.0)  # the whole 12-byte drip takes 6 s

    def test_trickled_headers_are_cut_off_at_the_deadline(self):
        # A read timeout applies per socket read, so headers sent a byte at a time would never trip it.
        def app(handler, srv):
            handler.wfile.write(b"HTTP/1.1 200 OK\r\nX-Slow: ")
            handler.wfile.flush()
            for _ in range(24):  # 6 s in all, unless the test ends first
                if srv.stop.wait(0.25):
                    break
                handler.wfile.write(b"a")
                handler.wfile.flush()
            handler.close_connection = True

        with LocalServer(app) as gateway:
            started = time.monotonic()
            with self.assertRaises(requests.exceptions.Timeout):
                self.client(timeout=1.0).get(gateway.url + "/mcp")
            elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, 0.9)
        self.assertLess(elapsed, 2.0)

    def test_deadline_covers_the_402_and_the_paid_retry_together(self):
        def app(handler, srv):
            if handler.headers.get(x402.HEADER_PAYMENT_SIGNATURE) is None:
                srv.stop.wait(0.6)  # a slow 402
                send_challenge(handler)
            else:
                srv.stop.wait(5)  # the paid retry never gets an answer

        with LocalServer(app) as gateway:
            client = self.client(timeout=1.0)
            started = time.monotonic()
            with self.assertRaises(requests.exceptions.Timeout):
                client.post(gateway.url + "/mcp", json={"jsonrpc": "2.0", "id": 1})
            elapsed = time.monotonic() - started
            self.assertEqual(len(gateway.requests), 2)
        self.assertGreaterEqual(elapsed, 0.9)
        self.assertLess(elapsed, 1.4)  # a fresh timeout for the retry would take 0.6 s + 1.0 s
        self.assertEqual(client.spent_raw(TOKEN), PRICE)  # the payment was sent, so it stays counted

    def test_slow_drip_of_the_paid_response_is_cut_off_at_the_deadline(self):
        def app(handler, srv):
            if handler.headers.get(x402.HEADER_PAYMENT_SIGNATURE) is None:
                send_challenge(handler)
            else:
                drip(handler, srv, b'{"jsonrpc":"2.0","id":1,"result":{}}', 0.3)

        with LocalServer(app) as gateway:
            client = self.client(timeout=1.0)
            started = time.monotonic()
            with self.assertRaises(requests.exceptions.Timeout):
                client.post(gateway.url + "/mcp", json={"jsonrpc": "2.0", "id": 1})
            elapsed = time.monotonic() - started
        self.assertLess(elapsed, 2.5)  # the whole drip takes about 11 s

    def test_paid_call_reuses_the_402_connection_and_returns_the_body(self):
        def app(handler, srv):
            if handler.headers.get(x402.HEADER_PAYMENT_SIGNATURE) is None:
                send_challenge(handler)
            else:
                send(handler, 200, {"Content-Type": "application/json"}, b'{"jsonrpc":"2.0","id":1,"result":{}}')

        with LocalServer(app) as gateway:
            client = self.client()
            response = client.post(gateway.url + "/mcp", json={"jsonrpc": "2.0", "id": 1})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {"jsonrpc": "2.0", "id": 1, "result": {}})
            first, retry = gateway.requests
        self.assertEqual(first["port"], retry["port"])  # the 402 body was drained, so keep-alive works
        self.assertEqual(json.loads(retry["body"]), {"jsonrpc": "2.0", "id": 1})
        payload = x402.decode_payment_signature_header(retry["headers"][x402.HEADER_PAYMENT_SIGNATURE])
        self.assertEqual(payload["accepted"], make_requirements())

    def test_a_large_402_body_is_not_downloaded(self):
        # Only the first 64 KiB of a 402 body are read: a gateway cannot make the buyer download a huge
        # 402. The connection is dropped instead of drained, so the paid retry goes out on a new one.
        def app(handler, srv):
            if handler.headers.get(x402.HEADER_PAYMENT_SIGNATURE) is None:
                challenge_header = x402._b64_json_encode(make_payment_required())
                send(handler, 402, {"PAYMENT-REQUIRED": challenge_header}, b" " * (256 * 1024))
            else:
                send(handler, 200, {"Content-Type": "application/json"}, b'{"jsonrpc":"2.0","id":1,"result":{}}')

        with LocalServer(app) as gateway:
            client = self.client()
            response = client.post(gateway.url + "/mcp", json={"jsonrpc": "2.0", "id": 1})
            self.assertEqual(response.status_code, 200)
            first, retry = gateway.requests
        self.assertNotEqual(first["port"], retry["port"])
        self.assertEqual(client.spent_raw(TOKEN), PRICE)

    def test_redirect_of_the_paid_retry_is_not_followed(self):
        # Reproduces the review finding: the retry got a 307 to another origin, which then received
        # PAYMENT-SIGNATURE and the body and answered in the gateway's name.
        with LocalServer(lambda handler, srv: send(handler, 200, body=b"stolen")) as thief:
            def app(handler, srv):
                if handler.headers.get(x402.HEADER_PAYMENT_SIGNATURE) is None:
                    send_challenge(handler)
                else:
                    send(handler, 307, {"Location": thief.url + "/steal"})

            with LocalServer(app) as gateway:
                client = self.client()
                response = client.post(gateway.url + "/mcp", json={"jsonrpc": "2.0", "id": 1})
                self.assertEqual(response.status_code, 307)
                self.assertEqual(response.headers["Location"], thief.url + "/steal")
                self.assertEqual(len(gateway.requests), 2)
            self.assertEqual(thief.requests, [])
        self.assertEqual(client.spent_raw(TOKEN), PRICE)

    def test_redirect_before_payment_is_returned_unpaid(self):
        with LocalServer(lambda handler, srv: send_challenge(handler)) as elsewhere:
            with LocalServer(lambda handler, srv: send(handler, 302, {"Location": elsewhere.url + "/mcp"})) as gateway:
                client = self.client()
                response = client.post(gateway.url + "/mcp", json={})
                self.assertEqual(response.status_code, 302)
            self.assertEqual(elsewhere.requests, [])
        self.assertEqual(client.spending(), {})

    def test_stream_true_leaves_the_body_to_the_caller(self):
        with LocalServer(lambda handler, srv: drip(handler, srv, b'{"result":1}', 0.5)) as gateway:
            started = time.monotonic()
            response = self.client(timeout=1.0).get(gateway.url + "/mcp", stream=True)
            self.assertLess(time.monotonic() - started, 1.0)  # returned once the headers arrived
            self.assertEqual(response.status_code, 200)
            response.close()


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

    def from_env(self, env, **kwargs):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", x402.InsecurePaymentConfigWarning)
            return x402.PayingClient.from_env(env, **kwargs)

    def assertEnvError(self, env, variable, fragment=None):
        with self.assertRaises(ValueError) as ctx:
            self.from_env(env)
        self.assertIn(variable, str(ctx.exception))
        if fragment:
            self.assertIn(fragment, str(ctx.exception))

    def test_full_configuration(self):
        client = self.from_env(self.env)
        self.assertEqual(client.networks, (TESTNET,))
        pay(client)
        with self.assertRaises(x402.PaymentAborted):
            pay(client, make_requirements(amount="500000001"))

    def test_network_list(self):
        client = self.from_env({**self.env, "CASCET_NETWORK": "casper:casper, casper:casper-test"})
        self.assertEqual(client.networks, (MAINNET, TESTNET))

    def test_malformed_network_names_the_variable(self):
        for value in ("casper:casper casper:casper-test", "casper:*", "mainnet"):
            with self.subTest(value=value):
                self.assertEnvError({**self.env, "CASCET_NETWORK": value}, "CASCET_NETWORK")

    def test_key_is_required(self):
        env = dict(self.env)
        del env["CASCET_KEY_PATH"]
        self.assertEnvError(env, "CASCET_KEY_PATH")
        self.from_env(env, key=TEST_KEY)

    def test_key_algorithm(self):
        for value in ("ed25519", " ed25519 ", ""):
            with self.subTest(value=value):
                self.from_env({**self.env, "CASCET_KEY_ALGO": value})
        for value in ("secp256k1", "ED25519", "rsa"):
            with self.subTest(value=value):
                self.assertEnvError({**self.env, "CASCET_KEY_ALGO": value}, "CASCET_KEY_ALGO", "ed25519")
        with self.assertRaises(ValueError):
            self.from_env({**self.env, "CASCET_KEY_ALGO": "secp256k1"}, key=TEST_KEY)

    def test_allowlists_are_required_unless_opted_out(self):
        for missing in ("CASCET_ALLOWED_PAYTO", "CASCET_ALLOWED_ASSETS"):
            env = {k: v for k, v in self.env.items() if k != missing}
            with self.subTest(missing=missing):
                with self.assertRaises(ValueError) as ctx:
                    self.from_env(env)
                self.assertIn(missing, str(ctx.exception))
                self.assertIn("CASCET_ALLOW_ANY_SELLER", str(ctx.exception))
            for flag in ("1", "true", "TRUE", " yes ", "Yes"):  # what `cascet connect` accepts
                with self.subTest(missing=missing, flag=flag):
                    self.from_env({**env, "CASCET_ALLOW_ANY_SELLER": flag})
            for flag in ("0", "no", "false", "on", "", "2"):
                with self.subTest(missing=missing, flag=flag):
                    with self.assertRaises(ValueError):
                        self.from_env({**env, "CASCET_ALLOW_ANY_SELLER": flag})

    def test_budget_is_required_unless_opted_out(self):
        for missing in ("CASCET_MAX_PER_CALL", "CASCET_MAX_SESSION"):
            env = {k: v for k, v in self.env.items() if k != missing}
            with self.subTest(missing=missing):
                with self.assertRaises(ValueError) as ctx:
                    self.from_env(env)
                self.assertIn(missing, str(ctx.exception))
                self.assertIn("CASCET_ALLOW_UNLIMITED_BUDGET", str(ctx.exception))
                with self.assertRaises(ValueError):
                    self.from_env({**env, missing: " "})
            for flag in ("1", "true", "YES"):
                with self.subTest(missing=missing, flag=flag):
                    self.from_env({**env, "CASCET_ALLOW_UNLIMITED_BUDGET": flag})
            with self.assertRaises(ValueError):
                self.from_env({**env, "CASCET_ALLOW_UNLIMITED_BUDGET": "0"})

    def test_bad_budget_values_name_the_variable(self):
        for variable in ("CASCET_MAX_PER_CALL", "CASCET_MAX_SESSION"):
            for value, fragment in (("-1", None), ("0", "greater than zero"), ("1e9", None), ("5.0", None)):
                with self.subTest(variable=variable, value=value):
                    self.assertEnvError({**self.env, variable: value}, variable, fragment)

    def test_bad_allowlist_entries_name_the_variable(self):
        self.assertEnvError({**self.env, "CASCET_ALLOWED_PAYTO": TEST_KEY.public_key_hex()},
                            "CASCET_ALLOWED_PAYTO", "account-hash")
        self.assertEnvError({**self.env, "CASCET_ALLOWED_ASSETS": "hash-xyz"}, "CASCET_ALLOWED_ASSETS")

    def test_timeout_ms(self):
        session = FakeSession(OK)
        self.from_env({**self.env, "CASCET_TIMEOUT_MS": " 1500 "}, session=session).get("https://gw.test/health")
        self.assertTrue(1.4 < session.calls[0]["timeout"][0] <= 1.5)
        session = FakeSession(OK)
        self.from_env(self.env, session=session).get("https://gw.test/health")
        self.assertTrue(29 < session.calls[0]["timeout"][0] <= 30)  # the default
        session = FakeSession(OK)
        self.from_env({**self.env, "CASCET_TIMEOUT_MS": "1500"}, session=session, timeout=5).get("https://gw.test/x")
        self.assertTrue(4.5 < session.calls[0]["timeout"][0] <= 5)  # an explicit argument wins

    def test_bad_timeout_ms(self):
        for value in ("0", "-1", "1.5", "30s", "abc", "2147483648", "99999999999"):
            with self.subTest(value=value):
                self.assertEnvError({**self.env, "CASCET_TIMEOUT_MS": value}, "CASCET_TIMEOUT_MS")


if __name__ == "__main__":
    unittest.main()
