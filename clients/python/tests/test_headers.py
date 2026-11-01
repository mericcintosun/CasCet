"""PAYMENT-SIGNATURE / PAYMENT-REQUIRED / PAYMENT-RESPONSE helpers."""
import base64
import json
import re
import unittest

from helpers import NOW, TEST_KEY, FakeResponse, make_payment_required, make_requirements, x402

BASE64_RE = re.compile(r"^[A-Za-z0-9+/]*={0,2}$")  # what @x402/core accepts


def b64(obj_or_text):
    text = obj_or_text if isinstance(obj_or_text, str) else json.dumps(obj_or_text)
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


class TestPaymentSignatureHeader(unittest.TestCase):
    def test_round_trip(self):
        payload = x402.build_payment_payload(
            key=TEST_KEY, requirements=make_requirements(), now=NOW,
            resource={"url": "https://gw.test/tools/echo", "description": "Prix 5 € ✓"},
        )
        header = x402.payment_signature_header(payload)
        self.assertRegex(header, BASE64_RE)
        self.assertEqual(x402.decode_payment_signature_header(header), payload)
        # Compact JSON, UTF-8 (not \\u escapes), like JSON.stringify.
        raw = base64.b64decode(header).decode("utf-8")
        self.assertNotIn(": ", raw)
        self.assertIn("€", raw)

    def test_lone_surrogates_are_escaped_like_json_stringify(self):
        # "\ud800" is valid JSON but has no UTF-8 form; JSON.stringify writes it as a lowercase \u escape.
        payload = {"resource": {"description": "a \ud800 b \udc00 c \U0001F680"}, "k\udfff": "\udabc"}
        header = x402.payment_signature_header(payload)
        raw = base64.b64decode(header).decode("utf-8")
        self.assertEqual(raw, '{"resource":{"description":"a \\ud800 b \\udc00 c \U0001F680"},"k\\udfff":"\\udabc"}')
        self.assertEqual(x402.decode_payment_signature_header(header), payload)
        # A backslash next to a surrogate stays a literal backslash.
        self.assertEqual(x402.decode_payment_signature_header(x402.payment_signature_header({"x": "\\\ud800"})),
                         {"x": "\\\ud800"})

    def test_rejects_non_mapping_and_nan(self):
        with self.assertRaises(TypeError):
            x402.payment_signature_header([1, 2])
        with self.assertRaises(ValueError):
            x402.payment_signature_header({"x": float("nan")})

    def test_decode_errors(self):
        for bad in ("not base64!", b64("[1,2]"), b64("{"), "%%%", 42):
            with self.subTest(bad=bad):
                with self.assertRaises(x402.ProtocolError):
                    x402.decode_payment_signature_header(bad)


class TestParsePaymentRequired(unittest.TestCase):
    def test_reads_the_header(self):
        pr = make_payment_required()
        response = FakeResponse(402, {"PAYMENT-REQUIRED": x402._b64_json_encode(pr)}, body={})
        self.assertEqual(x402.parse_payment_required(response), pr)

    def test_header_name_is_case_insensitive(self):
        pr = make_payment_required()
        for name in ("payment-required", "Payment-Required"):
            with self.subTest(name=name):
                # FakeResponse.headers.get is case-insensitive like requests'; a plain dict also works.
                self.assertEqual(x402.parse_payment_required(FakeResponse(402, {name: b64(pr)})), pr)
                plain = type("R", (), {"headers": {name: b64(pr)}, "status_code": 402})()
                self.assertEqual(x402.parse_payment_required(plain), pr)

    def test_tolerates_missing_padding_and_whitespace(self):
        pr = make_payment_required()
        header = b64(pr).rstrip("=")
        self.assertEqual(x402.parse_payment_required(FakeResponse(402, {"PAYMENT-REQUIRED": f" {header} "})), pr)

    def test_missing_header(self):
        # The x402 v2 HTTP transport puts the challenge in the header only; a body is not used.
        response = FakeResponse(402, {}, body=make_payment_required())
        with self.assertRaises(x402.ProtocolError) as ctx:
            x402.parse_payment_required(response)
        self.assertIn("PAYMENT-REQUIRED", str(ctx.exception))
        with self.assertRaises(TypeError):
            x402.parse_payment_required(object())

    def test_rejects_malformed_challenges(self):
        for bad in (
            "@@@",
            b64("not json"),
            b64("NaN"),
            b64([1, 2, 3]),
            b64({"x402Version": 1, "accepts": []}),
            b64({"x402Version": True, "accepts": []}),
            b64({"x402Version": "2", "accepts": []}),
            b64({"x402Version": 2}),
            b64({"x402Version": 2, "accepts": {"scheme": "exact"}}),
            base64.b64encode(b"\xff\xfe").decode(),
            # 1e400 parses to inf, which could never be written back into the PAYMENT-SIGNATURE header.
            b64('{"x402Version":2,"accepts":[],"resource":{"weight":1e400}}'),
            b64('{"x402Version":2,"accepts":[],"resource":{"weight":-1e400}}'),
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(x402.ProtocolError):
                    x402.parse_payment_required(FakeResponse(402, {"PAYMENT-REQUIRED": bad}))

    def test_rejects_deeply_nested_json(self):
        nested = {"x402Version": 2, "accepts": [], "resource": {"url": "u", "extra": "[" * 40 + "]" * 40}}
        self.assertEqual(x402.parse_payment_required(FakeResponse(402, {"PAYMENT-REQUIRED": b64(nested)})), nested)
        deep = make_payment_required()
        node = deep["resource"]
        for _ in range(40):
            node["next"] = {}
            node = node["next"]
        for value in (b64(deep), b64("[" * 100000 + "]" * 100000)):
            with self.assertRaises(x402.ProtocolError):
                x402.parse_payment_required(FakeResponse(402, {"PAYMENT-REQUIRED": value}))


class TestParsePaymentResponse(unittest.TestCase):
    def test_decodes_settlement(self):
        settle = {"success": True, "transaction": "ab" * 32, "network": "casper:casper-test", "payer": "00" + "11" * 32}
        response = FakeResponse(200, {"payment-response": b64(settle)})
        self.assertEqual(x402.parse_payment_response(response), settle)

    def test_absent(self):
        self.assertIsNone(x402.parse_payment_response(FakeResponse(200, {})))

    def test_malformed(self):
        with self.assertRaises(x402.ProtocolError):
            x402.parse_payment_response(FakeResponse(200, {"PAYMENT-RESPONSE": b64("[]")}))


if __name__ == "__main__":
    unittest.main()
