"""Token authorization styles: the accepted echo, unknown styles and validAfter 0."""
import copy
import unittest

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from helpers import (
    DELETE, LEGACY_EXTRA, MAINNET, NOW, OTHER_TOKEN, SELLER, TEST_KEY, TESTNET, TOKEN, WCSPR, WCSPR_EXTRA,
    legacy_requirements, make_requirements, wcspr_requirements, x402,
)

#: Values an `extra.authorizationStyle` may not take: unknown, misspelled, or not a string at all.
BAD_STYLES = [
    "", "value", "amount", "Legacy-Amount", "cep3009-value ", " legacy-amount", "cep-3009-value", "cep3009",
    "legacy-amount\u0000", None, 0, 1, True, ["cep3009-value"], {"style": "cep3009-value"}, "x" * 500,
]


def build(requirements, **kwargs):
    kwargs.setdefault("now", NOW)
    return x402.build_payment_payload(key=TEST_KEY, requirements=requirements, **kwargs)


def styled(style, **overrides):
    """make_requirements() whose extra names `style` (any value, for the refusal tests)."""
    extra = copy.deepcopy(LEGACY_EXTRA)
    extra["authorizationStyle"] = style
    return make_requirements(extra=extra, **overrides)


class TestStyleConstants(unittest.TestCase):
    def test_shared_names_and_values(self):
        # The same names and values as @cascet/core.
        self.assertEqual(x402.AUTHORIZATION_STYLES, ("legacy-amount", "cep3009-value"))
        self.assertEqual(x402.AUTHORIZATION_STYLE_EXTRA_KEY, "authorizationStyle")
        self.assertEqual(dict(x402.LEGACY_AMOUNT_TOKENS), {TOKEN: TESTNET, OTHER_TOKEN: MAINNET})

    def test_legacy_tokens_are_read_only(self):
        with self.assertRaises(TypeError):
            x402.LEGACY_AMOUNT_TOKENS[WCSPR] = TESTNET  # type: ignore[index]

    def test_default_authorization_style(self):
        for value in (TOKEN, OTHER_TOKEN, "hash-" + TOKEN, TOKEN.upper(), "0x" + OTHER_TOKEN, " package-hash-" + TOKEN):
            with self.subTest(value=value):
                self.assertEqual(x402.default_authorization_style(value), "legacy-amount")
        for value in (WCSPR, "hash-" + WCSPR, "11" * 32):
            with self.subTest(value=value):
                self.assertEqual(x402.default_authorization_style(value), "cep3009-value")
        for bad in ("", "hash-", TOKEN[:-1], None):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    x402.default_authorization_style(bad)

    def test_authorization_style_reads_the_extra_field(self):
        self.assertEqual(x402.authorization_style(legacy_requirements()), "legacy-amount")
        self.assertEqual(x402.authorization_style(wcspr_requirements()), "cep3009-value")
        # A gateway from before the field existed names none.
        self.assertIsNone(x402.authorization_style(make_requirements()))
        self.assertIsNone(x402.authorization_style(make_requirements(extra=DELETE)))
        self.assertIsNone(x402.authorization_style(make_requirements(extra="not an object")))
        self.assertIsNone(x402.authorization_style("not an object"))

    def test_unknown_styles_raise_value_error(self):
        for bad in BAD_STYLES:
            with self.subTest(style=bad):
                with self.assertRaises(ValueError) as ctx:  # a ProtocolError, which is a ValueError
                    x402.authorization_style(styled(bad))
                self.assertIsInstance(ctx.exception, x402.ProtocolError)
                self.assertIn("authorizationStyle", str(ctx.exception))
                self.assertLess(len(str(ctx.exception)), 300)  # a hostile value is shortened in the message


class TestAcceptedEchoesTheStyle(unittest.TestCase):
    def test_accepted_is_the_full_requirements_for_both_styles(self):
        for requirements in (legacy_requirements(), wcspr_requirements()):
            with self.subTest(style=requirements["extra"]["authorizationStyle"]):
                payload = build(requirements)
                self.assertEqual(payload["accepted"], requirements)
                self.assertEqual(
                    payload["accepted"]["extra"]["authorizationStyle"], requirements["extra"]["authorizationStyle"]
                )
                requirements["extra"]["authorizationStyle"] = "changed"
                self.assertNotEqual(payload["accepted"]["extra"]["authorizationStyle"], "changed")  # a copy

    def test_both_styles_are_signed_the_same_way(self):
        # Same requirements except the token: the authorization differs only through the EIP-712 domain.
        nonce = bytes(range(32))
        legacy = build(legacy_requirements(), nonce=nonce)
        value = build(wcspr_requirements(), nonce=nonce)
        self.assertEqual(legacy["payload"]["authorization"], value["payload"]["authorization"])
        self.assertNotEqual(legacy["payload"]["signature"], value["payload"]["signature"])
        public_key = Ed25519PublicKey.from_public_bytes(TEST_KEY.public_key_bytes)
        for payload, extra, asset in ((legacy, LEGACY_EXTRA, TOKEN), (value, WCSPR_EXTRA, WCSPR)):
            auth = payload["payload"]["authorization"]
            digest = x402.transfer_with_auth_digest(
                name=extra["name"], version=extra["version"], chain_name=TESTNET, asset=asset,
                frm="0x" + auth["from"], to="0x" + auth["to"], value=int(auth["value"]),
                valid_after=int(auth["validAfter"]), valid_before=int(auth["validBefore"]), nonce_hex=auth["nonce"],
            )
            public_key.verify(bytes.fromhex(payload["payload"]["signature"])[1:], digest)

    def test_unknown_style_is_refused_before_signing(self):
        class NoSigning(x402.CasperKey):
            def sign(self, digest):
                raise AssertionError("must not sign")

        key = NoSigning(TEST_KEY._sk, TEST_KEY.public_key_bytes)
        for bad in BAD_STYLES:
            with self.subTest(style=bad):
                with self.assertRaises(ValueError):
                    x402.build_payment_payload(key=key, requirements=styled(bad), now=NOW)
                with self.assertRaises(x402.ProtocolError):
                    x402.validate_requirements(styled(bad))

    def test_requirements_without_a_style_still_work(self):
        req = make_requirements()
        self.assertNotIn("authorizationStyle", req["extra"])
        self.assertEqual(build(req)["accepted"], req)


class TestValidAfter(unittest.TestCase):
    def test_valid_after_may_be_0(self):
        # What @x402/casper 2.29's client (the TypeScript client) signs.
        nonce = bytes.fromhex("11" * 32)
        for requirements in (legacy_requirements(), wcspr_requirements()):
            with self.subTest(asset=requirements["asset"]):
                payload = build(requirements, valid_after=0, nonce=nonce)
                auth = payload["payload"]["authorization"]
                self.assertEqual(auth["validAfter"], "0")
                self.assertEqual(auth["validBefore"], str(NOW + 300))
                digest = x402.transfer_with_auth_digest(
                    name=requirements["extra"]["name"], version="1", chain_name=TESTNET, asset=requirements["asset"],
                    frm="0x" + TEST_KEY.account_address(), to="0x" + SELLER, value=500000000,
                    valid_after=0, valid_before=NOW + 300, nonce_hex=nonce.hex(),
                )
                Ed25519PublicKey.from_public_bytes(TEST_KEY.public_key_bytes).verify(
                    bytes.fromhex(payload["payload"]["signature"])[1:], digest
                )

    def test_valid_after_0_is_not_treated_as_missing(self):
        auth = build(make_requirements(), valid_after=0)["payload"]["authorization"]
        self.assertEqual(auth["validAfter"], "0")
        self.assertEqual(build(make_requirements())["payload"]["authorization"]["validAfter"], str(NOW - 600))
        # Early in the epoch the back-dated default is clamped to 0 as well.
        self.assertEqual(build(make_requirements(), now=100)["payload"]["authorization"]["validAfter"], "0")
        with self.assertRaises(ValueError):
            build(make_requirements(), valid_after=0, valid_before=0)


if __name__ == "__main__":
    unittest.main()
