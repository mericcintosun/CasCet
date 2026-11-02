"""build_payment_payload: the x402 v2 payload shape (M10) and input validation."""
import unittest

from helpers import DELETE, NOW, SELLER, TEST_KEY, TOKEN, make_requirements, x402


def build(**kwargs):
    kwargs.setdefault("key", TEST_KEY)
    kwargs.setdefault("requirements", make_requirements())
    kwargs.setdefault("now", NOW)
    return x402.build_payment_payload(**kwargs)


class TestPayloadShape(unittest.TestCase):
    def test_accepted_is_the_full_accepts_entry(self):
        req = make_requirements()
        payload = build(requirements=req)
        self.assertEqual(payload["accepted"], req)
        self.assertEqual(payload["accepted"]["maxTimeoutSeconds"], 300)
        self.assertEqual(payload["accepted"]["extra"], req["extra"])
        self.assertEqual(payload["x402Version"], 2)

    def test_accepted_is_a_copy(self):
        req = make_requirements()
        payload = build(requirements=req)
        req["extra"]["name"] = "changed"
        req["amount"] = "1"
        self.assertEqual(payload["accepted"]["extra"]["name"], "CasCet X402 Token")
        self.assertEqual(payload["accepted"]["amount"], "500000000")

    def test_unknown_requirement_fields_are_echoed(self):
        # The gateway deep-compares `accepted` with what it advertised, so nothing may be dropped.
        req = make_requirements(extra={"name": "CasCet X402 Token", "version": "1", "feePayer": "00" + "11" * 32})
        req["futureField"] = {"nested": [1, 2, 3]}
        self.assertEqual(build(requirements=req)["accepted"], req)

    def test_authorization_fields(self):
        payload = build(nonce=bytes(range(32)))
        auth = payload["payload"]["authorization"]
        self.assertEqual(auth["from"], TEST_KEY.account_address())
        self.assertEqual(auth["to"], SELLER)
        self.assertEqual(auth["value"], "500000000")
        self.assertEqual(auth["nonce"], bytes(range(32)).hex())
        self.assertEqual(payload["payload"]["publicKey"], TEST_KEY.public_key_hex())
        self.assertEqual(len(bytes.fromhex(payload["payload"]["signature"])), 65)

    def test_value_is_the_advertised_amount_string(self):
        # The facilitator compares authorization.value with requirements.amount as strings.
        payload = build(requirements=make_requirements(amount="000500"))
        self.assertEqual(payload["payload"]["authorization"]["value"], "000500")

    def test_default_window_back_dates_valid_after(self):
        # As @make-software/casper-x402 1.0.0 did. The @x402/casper 2.29 client signs 0, which valid_after=0
        # reproduces (test_styles.py: test_valid_after_may_be_0).
        auth = build()["payload"]["authorization"]
        self.assertEqual(auth["validAfter"], str(NOW - 600))
        self.assertEqual(auth["validBefore"], str(NOW + 300))

    def test_window_is_capped(self):
        self.assertEqual(x402.MAX_VALIDITY_SECONDS, 900)  # the TS client's maxAuthorizationSeconds default
        auth = build(requirements=make_requirements(maxTimeoutSeconds=10**9))["payload"]["authorization"]
        self.assertEqual(auth["validBefore"], str(NOW + x402.MAX_VALIDITY_SECONDS))
        auth = build(requirements=make_requirements(maxTimeoutSeconds=10**9), max_validity_seconds=60)["payload"]
        self.assertEqual(auth["authorization"]["validBefore"], str(NOW + 60))
        auth = build(requirements=make_requirements(maxTimeoutSeconds=300), max_validity_seconds=3600)["payload"]
        self.assertEqual(auth["authorization"]["validBefore"], str(NOW + 300))

    def test_max_validity_seconds_validation(self):
        for bad in (0, -1, True, 1.5, "900", None):
            with self.subTest(max_validity_seconds=bad):
                with self.assertRaises(ValueError):
                    build(max_validity_seconds=bad)

    def test_explicit_window(self):
        auth = build(valid_after=NOW - 5, valid_before=NOW + 60)["payload"]["authorization"]
        self.assertEqual((auth["validAfter"], auth["validBefore"]), (str(NOW - 5), str(NOW + 60)))

    def test_missing_max_timeout_needs_explicit_valid_before(self):
        req = make_requirements(maxTimeoutSeconds=DELETE)
        with self.assertRaises(x402.ProtocolError):
            build(requirements=req)
        payload = build(requirements=req, valid_before=NOW + 60)
        self.assertNotIn("maxTimeoutSeconds", payload["accepted"])

    def test_random_nonce_by_default(self):
        a, b = build(), build()
        self.assertEqual(len(bytes.fromhex(a["payload"]["authorization"]["nonce"])), 32)
        self.assertNotEqual(a["payload"]["authorization"]["nonce"], b["payload"]["authorization"]["nonce"])

    def test_resource_and_extensions_are_echoed(self):
        resource = {"url": "https://gw.test/tools/echo", "description": "Paid MCP tool: echo"}
        extensions = {"bazaar": {"info": {"x": 1}}}
        payload = build(resource=resource, extensions=extensions)
        self.assertEqual(payload["resource"], resource)
        self.assertEqual(payload["extensions"], extensions)
        self.assertEqual(list(payload), ["x402Version", "payload", "extensions", "resource", "accepted"])
        self.assertEqual(list(build()), ["x402Version", "payload", "accepted"])

    def test_resource_must_be_an_object(self):
        with self.assertRaises(x402.ProtocolError):
            build(resource="https://gw.test/tools/echo")
        with self.assertRaises(x402.ProtocolError):
            build(extensions=["bazaar"])


class TestRequirementValidation(unittest.TestCase):
    def assertRejected(self, message_part=None, **overrides):
        with self.assertRaises(x402.ProtocolError) as ctx:
            build(requirements=make_requirements(**overrides))
        if message_part:
            self.assertIn(message_part, str(ctx.exception))

    def test_scheme_and_network(self):
        self.assertRejected("scheme", scheme="upto")
        self.assertRejected("network", network="eip155:8453")
        self.assertRejected("network", network="casper:")
        self.assertRejected("network", network=DELETE)
        # The CAIP-2 reference charset the TS client checks: [-_a-zA-Z0-9]{1,32}.
        for bad in ("casper:casper test", "casper:" + "a" * 33, "casper:caspér", "casper:\ud800", "casper:*"):
            with self.subTest(network=bad):
                self.assertRejected("network", network=bad)
        build(requirements=make_requirements(network="casper:" + "a" * 32))

    def test_pay_to_must_be_a_serialized_key(self):
        self.assertRejected("payTo", payTo="account-hash-" + "ab" * 32)
        self.assertRejected("payTo", payTo="02" + "ab" * 33)        # secp256k1 public key
        self.assertRejected("payTo", payTo="0x" + "12" * 20)         # 20-byte EVM address
        self.assertRejected("payTo", payTo="00" + "ab" * 31)
        self.assertRejected("payTo", payTo=None)

    def test_asset_must_be_bare_hex(self):
        self.assertRejected("without the 'hash-'", asset="hash-" + TOKEN)
        self.assertRejected("asset", asset=TOKEN[:-2])
        self.assertRejected("asset", asset="0x" + "12" * 20)

    def test_extra_name_and_version_required(self):
        self.assertRejected("extra", extra=DELETE)
        self.assertRejected("extra", extra={"name": "CasCet X402 Token"})
        self.assertRejected("extra", extra={"name": "", "version": "1"})
        self.assertRejected("extra", extra={"name": "CasCet X402 Token", "version": 1})
        # A lone surrogate has no UTF-8 form, so it could not be hashed into the EIP-712 domain.
        self.assertRejected("surrogates", extra={"name": "CasCet \ud800 Token", "version": "1"})
        self.assertRejected("surrogates", extra={"name": "CasCet X402 Token", "version": "\udc00"})

    def test_extra_name_and_version_reasons(self):
        # The TS client's SpendPolicy refuses the same entries, in the same words.
        name = "CasCet X402 Token"
        for extra, reason in (
            ({"version": "1"}, "extra.name is missing"),
            ({"name": 42, "version": "1"}, "extra.name must be a string; got 42"),
            ({"name": None, "version": "1"}, "extra.name must be a string; got None"),
            ({"name": "", "version": "1"}, "extra.name is empty"),
            ({"name": "CasCet \ud800 Token", "version": "1"},
             "extra.name contains lone UTF-16 surrogates, which have no UTF-8 form to sign over"),
            ({"name": "x" * 101, "version": "1"},
             "extra.name is 101 characters long, above this client's 100-character limit"),
            ({"name": name}, "extra.version is missing"),
            ({"name": name, "version": 1}, "extra.version must be a string; got 1"),
            ({"name": name, "version": ""}, "extra.version is empty"),
            ({"name": name, "version": "\udc00"},
             "extra.version contains lone UTF-16 surrogates, which have no UTF-8 form to sign over"),
            ({"name": name, "version": "1" * 21},
             "extra.version is 21 characters long, above this client's 20-character limit"),
        ):
            with self.subTest(reason=reason):
                with self.assertRaises(x402.ProtocolError) as ctx:
                    build(requirements=make_requirements(extra=extra))
                self.assertEqual(str(ctx.exception), f"malformed EIP-712 domain: {reason}")
        # No extra at all, or one that is not an object, names no domain either.
        for extra in (DELETE, None, name, [name, "1"]):
            with self.subTest(extra=extra):
                self.assertRejected("malformed EIP-712 domain: extra.name is missing", extra=extra)

    def test_extra_name_and_version_bounds(self):
        self.assertEqual((x402.MAX_TOKEN_NAME_LENGTH, x402.MAX_TOKEN_VERSION_LENGTH), (100, 20))
        for extra in (
            {"name": "x" * 100, "version": "1" * 20},
            {"name": "Jeton été \U0001FA99", "version": "2"},
            # Counted in UTF-16 code units, as the TS client counts them: a character outside the BMP counts twice.
            {"name": "\U0001FA99" * 50, "version": "1"},
        ):
            with self.subTest(extra=extra):
                self.assertEqual(build(requirements=make_requirements(extra=extra))["accepted"]["extra"], extra)
        self.assertRejected("extra.name is 102 characters long", extra={"name": "\U0001FA99" * 51, "version": "1"})

    def test_max_timeout_seconds(self):
        for bad in (0, -1, True, "300", 1.5, float("inf"), float("nan"), None):
            with self.subTest(maxTimeoutSeconds=bad):
                self.assertRejected("maxTimeoutSeconds", maxTimeoutSeconds=bad)
        self.assertEqual(build(requirements=make_requirements(maxTimeoutSeconds=300.0))["accepted"]["maxTimeoutSeconds"], 300.0)

    def test_window_validation(self):
        for kwargs in (
            {"valid_after": NOW, "valid_before": NOW},
            {"valid_after": NOW + 10, "valid_before": NOW},
            {"valid_after": -1, "valid_before": NOW},
            {"valid_after": 0, "valid_before": 2**64},
            {"valid_after": "0", "valid_before": NOW},
            {"valid_after": True, "valid_before": NOW},
        ):
            with self.subTest(**{k: repr(v) for k, v in kwargs.items()}):
                with self.assertRaises(ValueError):
                    build(**kwargs)
        build(valid_after=0, valid_before=2**64 - 1)  # u64 bounds are fine

    def test_nonce_must_be_32_bytes(self):
        with self.assertRaises(ValueError):
            build(nonce=b"\x00" * 31)
        with self.assertRaises(ValueError):
            build(nonce="00" * 32)


class TestAmountValidation(unittest.TestCase):
    VALID = ["1", "500000000", "000500", "9" * 40]
    INVALID = [
        "0", "00", "-5", "+5", "-1000000", "0x10", "0o17", "1e5", "5.0", "5_000", " 5", "5 ", "5\n", "",
        "٥", "²", "５", "1" * 41, 5, 5.0, None, True, b"5",
    ]

    def test_parse_amount(self):
        for value in self.VALID:
            with self.subTest(value=value):
                self.assertEqual(x402.parse_amount(value), int(value))
        for value in self.INVALID:
            with self.subTest(value=value):
                with self.assertRaises(x402.ProtocolError):
                    x402.parse_amount(value)

    def test_payload_refuses_bad_amounts(self):
        for value in self.INVALID:
            with self.subTest(value=value):
                with self.assertRaises(x402.ProtocolError):
                    build(requirements=make_requirements(amount=value))


if __name__ == "__main__":
    unittest.main()
