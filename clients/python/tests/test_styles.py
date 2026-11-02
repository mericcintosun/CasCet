"""Token authorization styles: the accepted echo, unknown styles, select_requirement and PayingClient preferences."""
import copy
import os
import tempfile
import unittest
import warnings

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from helpers import (
    DELETE, LEGACY_EXTRA, MAINNET, NOW, OTHER_SELLER, OTHER_TOKEN, SELLER, TEST_KEY, TESTNET, TOKEN, WCSPR,
    WCSPR_EXTRA, legacy_requirements, make_payment_required, make_requirements, quiet_client, wcspr_requirements, x402,
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
        self.assertEqual(x402.HOSTED_FACILITATOR_HOST, "x402-facilitator.cspr.cloud")

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


class TestSelectRequirement(unittest.TestCase):
    def select(self, *accepts, allowed_assets=(TOKEN, WCSPR), allowed_pay_to=(SELLER,), **kwargs):
        return x402.select_requirement(list(accepts), list(allowed_assets) if allowed_assets is not None else None,
                                       list(allowed_pay_to) if allowed_pay_to is not None else None, **kwargs)

    def test_returns_the_entry_itself_in_server_order(self):
        legacy, value = legacy_requirements(), wcspr_requirements()
        self.assertIs(self.select(legacy, value), legacy)
        self.assertIs(self.select(value, legacy), value)

    def test_sorts_by_style_preference(self):
        legacy, value = legacy_requirements(), wcspr_requirements()
        self.assertIs(self.select(legacy, value, prefer_styles=["cep3009-value"]), value)
        self.assertIs(self.select(value, legacy, prefer_styles=["legacy-amount"]), legacy)
        self.assertIs(self.select(legacy, value, prefer_styles=["cep3009-value", "legacy-amount"]), value)
        self.assertIs(self.select(legacy, value, prefer_styles="cep3009-value"), value)  # one style as a string
        self.assertIs(self.select(legacy, value, prefer_styles=[" cep3009-value "]), value)
        self.assertIs(self.select(legacy, value, prefer_styles=[]), legacy)

    def test_a_preference_never_makes_an_entry_qualify(self):
        legacy = legacy_requirements()
        value = wcspr_requirements(payTo=OTHER_SELLER)  # not allowlisted
        self.assertIs(self.select(legacy, value, prefer_styles=["cep3009-value"]), legacy)
        with self.assertRaises(x402.PaymentAborted):
            self.select(value, prefer_styles=["cep3009-value"])

    def test_same_rank_keeps_the_server_order(self):
        first = wcspr_requirements(amount="7")
        second = wcspr_requirements(amount="9")
        legacy = legacy_requirements()
        self.assertIs(self.select(legacy, first, second, prefer_styles=["cep3009-value"]), first)
        self.assertIs(self.select(legacy, second, first, prefer_styles=["cep3009-value"]), second)

    def test_entries_without_a_style_rank_by_their_asset(self):
        # A gateway from before the migration: no extra.authorizationStyle.
        old_legacy = make_requirements()
        old_other = make_requirements(asset=WCSPR, extra={"name": "Wrapped CSPR", "version": "1"})
        self.assertIs(self.select(old_other, old_legacy, prefer_styles=["legacy-amount"]), old_legacy)
        self.assertIs(self.select(old_legacy, old_other, prefer_styles=["cep3009-value"]), old_other)
        self.assertIs(self.select(old_legacy, wcspr_requirements(), prefer_styles=["legacy-amount"]), old_legacy)

    def test_filters_scheme_network_and_format(self):
        good = wcspr_requirements()
        for bad, fragment in (
            (wcspr_requirements(scheme="upto"), "scheme"),
            (wcspr_requirements(network=MAINNET), "network casper:casper is not allowed"),
            (wcspr_requirements(amount="-1"), "amount"),
            (wcspr_requirements(extra={"name": "Wrapped CSPR"}), "extra"),
            (wcspr_requirements(extra={**WCSPR_EXTRA, "name": "W" * 101}), "extra.name is 101 characters long"),
            (styled("unknown-style"), "authorizationStyle"),
            ("not an object", "JSON object"),
        ):
            with self.subTest(fragment=fragment):
                self.assertIs(self.select(bad, good), good)
                with self.assertRaises(x402.PaymentAborted) as ctx:
                    self.select(bad)
                self.assertIn("accepts[0]: ", str(ctx.exception))
                self.assertIn(fragment, str(ctx.exception))

    def test_networks(self):
        on_mainnet = legacy_requirements(network=MAINNET, asset=OTHER_TOKEN)
        self.assertIs(self.select(on_mainnet, allowed_assets=[OTHER_TOKEN], networks=[MAINNET]), on_mainnet)
        self.assertIs(self.select(on_mainnet, allowed_assets=[OTHER_TOKEN], networks=MAINNET), on_mainnet)
        with self.assertRaises(x402.PaymentAborted):
            self.select(on_mainnet, allowed_assets=[OTHER_TOKEN])  # default: testnet only
        for bad in ([], ["casper:*"], ["eip155:8453"], [None]):
            with self.subTest(networks=bad):
                with self.assertRaises(ValueError):
                    self.select(legacy_requirements(), networks=bad)

    def test_allowlists(self):
        legacy, value = legacy_requirements(), wcspr_requirements()
        self.assertIs(self.select(legacy, value, allowed_assets=["hash-" + WCSPR.upper()]), value)
        with self.assertRaises(x402.PaymentAborted) as ctx:
            self.select(legacy, value, allowed_assets=[OTHER_TOKEN])
        self.assertIn("accepts[0]: asset", str(ctx.exception))
        self.assertIn("accepts[1]: asset", str(ctx.exception))
        with self.assertRaises(x402.PaymentAborted) as ctx:
            self.select(legacy, allowed_pay_to=[OTHER_SELLER])
        self.assertIn("is not allowlisted", str(ctx.exception))
        self.assertIs(self.select(legacy, allowed_pay_to=["account-hash-" + SELLER[2:]]), legacy)
        # None means "no allowlist" (any account payee, any asset); an empty list allows nothing.
        other = legacy_requirements(payTo=OTHER_SELLER, asset=OTHER_TOKEN)
        self.assertIs(self.select(other, allowed_assets=None, allowed_pay_to=None), other)
        with self.assertRaises(x402.PaymentAborted):
            self.select(legacy, allowed_assets=[])
        with self.assertRaises(x402.PaymentAborted):
            self.select(legacy, allowed_pay_to=[])

    def test_contract_package_payees_are_always_refused(self):
        payee = "01" + "cd" * 32
        entry = wcspr_requirements(payTo=payee)
        for allowed in (None, [SELLER], ["00" + "cd" * 32]):
            with self.subTest(allowed_pay_to=allowed):
                with self.assertRaises(x402.PaymentAborted) as ctx:
                    self.select(entry, allowed_pay_to=allowed)
                self.assertIn("01 tag", str(ctx.exception))
                self.assertIn(x402.CONTRACT_PAYEE_REASON, str(ctx.exception))
        for entry_text in ("hash-" + "cd" * 32, "package-hash-" + "cd" * 32):
            with self.subTest(allowlist_entry=entry_text):
                with self.assertRaises(ValueError) as ctx:
                    self.select(entry, allowed_pay_to=[entry_text])
                self.assertIn("contract-package payee", str(ctx.exception))

    def test_invalid_arguments_raise_value_error_before_the_402_is_read(self):
        for kwargs in (
            {"prefer_styles": ["value"]},
            {"prefer_styles": ["cep3009-value", "amount"]},
            {"prefer_styles": [None]},
            {"allowed_assets": ["hash-xyz"]},
            {"allowed_pay_to": [TEST_KEY.public_key_hex()]},
            {"networks": ["casper:casper casper:casper-test"]},
        ):
            with self.subTest(**{k: repr(v) for k, v in kwargs.items()}):
                with self.assertRaises(ValueError):
                    self.select(legacy_requirements(), **kwargs)
                with self.assertRaises(ValueError):
                    self.select(**kwargs)  # an empty offer does not hide the configuration error

    def test_no_payable_entries(self):
        for accepts in ([], None, {"scheme": "exact"}, "accepts"):
            with self.subTest(accepts=accepts):
                with self.assertRaises(x402.PaymentAborted) as ctx:
                    x402.select_requirement(accepts, [TOKEN], [SELLER])
                self.assertIn("offers no payment requirements", str(ctx.exception))

    def test_every_rejection_is_reported(self):
        with self.assertRaises(x402.PaymentAborted) as ctx:
            self.select(legacy_requirements(network=MAINNET), wcspr_requirements(payTo=OTHER_SELLER), styled("bogus"))
        message = str(ctx.exception)
        self.assertIn("accepts[0]: network", message)
        self.assertIn("accepts[1]: payTo", message)
        self.assertIn("accepts[2]: extra.authorizationStyle", message)

    def test_selected_entry_pays_as_is(self):
        accepts = [legacy_requirements(), wcspr_requirements()]
        chosen = self.select(*accepts, prefer_styles=["cep3009-value"])
        payload = build(chosen)
        self.assertEqual(payload["accepted"], accepts[1])


class TestPayingClientStyles(unittest.TestCase):
    def client(self, **kwargs):
        kwargs.setdefault("allowed_assets", [TOKEN, WCSPR])
        return quiet_client(**kwargs)

    def test_first_acceptable_entry_without_a_preference(self):
        payload = self.client().create_payment_payload(make_payment_required(legacy_requirements(), wcspr_requirements()))
        self.assertEqual(payload["accepted"], legacy_requirements())

    def test_prefer_styles(self):
        client = self.client(prefer_styles=["cep3009-value"])
        self.assertEqual(client.prefer_styles, ("cep3009-value",))
        payload = client.create_payment_payload(make_payment_required(legacy_requirements(), wcspr_requirements()))
        self.assertEqual(payload["accepted"], wcspr_requirements())
        self.assertEqual(client.spending(), {WCSPR: 500000000})

    def test_preference_yields_to_the_budget(self):
        client = self.client(prefer_styles=["cep3009-value"], max_per_call_raw=None, max_session_raw="600000000")
        pr = make_payment_required(legacy_requirements(), wcspr_requirements())
        self.assertEqual(client.create_payment_payload(pr)["accepted"]["asset"], WCSPR)
        # WCSPR's session budget is used up: the client falls back to the legacy entry.
        self.assertEqual(client.create_payment_payload(pr)["accepted"]["asset"], TOKEN)
        self.assertEqual(client.spending(), {WCSPR: 500000000, TOKEN: 500000000})

    def test_unknown_style_entry_is_skipped(self):
        client = self.client()
        payload = client.create_payment_payload(make_payment_required(styled("cep3009-valu"), wcspr_requirements()))
        self.assertEqual(payload["accepted"]["asset"], WCSPR)
        with self.assertRaises(x402.PaymentAborted) as ctx:
            client.create_payment_payload(make_payment_required(styled("bogus")))
        self.assertIn("authorizationStyle", str(ctx.exception))
        self.assertEqual(client.spending(), {WCSPR: 500000000})

    def test_prefer_styles_validation(self):
        for bad in (["value"], ["legacy-amount", "LEGACY-AMOUNT"], [1], "amount"):
            with self.subTest(prefer_styles=bad):
                with self.assertRaises(ValueError):
                    self.client(prefer_styles=bad)
        self.assertEqual(self.client(prefer_styles="legacy-amount").prefer_styles, ("legacy-amount",))
        self.assertEqual(
            self.client(prefer_styles=["legacy-amount", "cep3009-value", "legacy-amount"]).prefer_styles,
            ("legacy-amount", "cep3009-value"),
        )
        self.assertEqual(self.client().prefer_styles, ())

    def test_on_payment_reports_the_known_or_advertised_style(self):
        seen = []
        unknown = "ee" * 32
        client = self.client(on_payment=seen.append, allowed_assets=[TOKEN, WCSPR, unknown])
        client.create_payment_payload(make_payment_required(wcspr_requirements()))
        client.create_payment_payload(make_payment_required(legacy_requirements()))
        client.create_payment_payload(make_payment_required(make_requirements()))  # names no style, known token
        # A known token is reported with its own style, whatever the gateway labels it.
        client.create_payment_payload(make_payment_required(make_requirements(extra={
            "name": "CasCet X402 Token", "version": "1", x402.AUTHORIZATION_STYLE_EXTRA_KEY: "cep3009-value"})))
        # An unknown token: the advertised style, or none.
        client.create_payment_payload(make_payment_required(make_requirements(asset=unknown)))
        self.assertEqual(seen, [
            {"amount_raw": "500000000", "pay_to": SELLER, "asset": WCSPR, "network": TESTNET,
             "authorization_style": "cep3009-value"},
            {"amount_raw": "500000000", "pay_to": SELLER, "asset": TOKEN, "network": TESTNET,
             "authorization_style": "legacy-amount"},
            {"amount_raw": "500000000", "pay_to": SELLER, "asset": TOKEN, "network": TESTNET,
             "authorization_style": "legacy-amount"},
            {"amount_raw": "500000000", "pay_to": SELLER, "asset": TOKEN, "network": TESTNET,
             "authorization_style": "legacy-amount"},
            {"amount_raw": "500000000", "pay_to": SELLER, "asset": unknown, "network": TESTNET},
        ])

    def test_a_mislabeled_known_token_cannot_steer_the_preference(self):
        # The gateway labels CasCet's legacy token cep3009-value and lists it first; a buyer preferring
        # cep3009-value still gets Wrapped CSPR, because the client knows the legacy token's style.
        mislabeled = make_requirements(extra={"name": "CasCet X402 Token", "version": "1",
                                              x402.AUTHORIZATION_STYLE_EXTRA_KEY: "cep3009-value"})
        chosen = x402.select_requirement([mislabeled, wcspr_requirements()], [TOKEN, WCSPR], [SELLER],
                                         prefer_styles=["cep3009-value"])
        self.assertEqual(chosen["asset"], WCSPR)
        self.assertEqual(x402.known_authorization_style(TOKEN, TESTNET), "legacy-amount")
        self.assertEqual(x402.known_authorization_style(WCSPR, TESTNET), "cep3009-value")
        self.assertIsNone(x402.known_authorization_style(WCSPR, "casper:casper"))  # testnet WCSPR on mainnet
        self.assertIsNone(x402.known_authorization_style("not-a-hash", TESTNET))


class TestFromEnvPreferStyles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        path = os.path.join(self.tmp.name, "payer.pem")
        with open(path, "wb") as f:
            f.write(TEST_KEY._sk.private_bytes(
                serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        self.env = {
            "CASCET_KEY_PATH": path,
            "CASCET_ALLOWED_PAYTO": SELLER,
            "CASCET_ALLOWED_ASSETS": f"hash-{TOKEN},hash-{WCSPR}",
            "CASCET_MAX_PER_CALL": "500000000",
            "CASCET_MAX_SESSION": "1000000000",
        }

    def from_env(self, env, **kwargs):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", x402.InsecurePaymentConfigWarning)
            return x402.PayingClient.from_env(env, **kwargs)

    def test_prefer_styles_variable(self):
        self.assertEqual(self.from_env(self.env).prefer_styles, ())
        client = self.from_env({**self.env, "CASCET_PREFER_STYLES": " cep3009-value , legacy-amount "})
        self.assertEqual(client.prefer_styles, ("cep3009-value", "legacy-amount"))
        payload = client.create_payment_payload(make_payment_required(legacy_requirements(), wcspr_requirements()))
        self.assertEqual(payload["accepted"]["asset"], WCSPR)
        self.assertEqual(self.from_env({**self.env, "CASCET_PREFER_STYLES": " "}).prefer_styles, ())
        # An explicit argument wins over the environment.
        explicit = self.from_env({**self.env, "CASCET_PREFER_STYLES": "cep3009-value"}, prefer_styles=["legacy-amount"])
        self.assertEqual(explicit.prefer_styles, ("legacy-amount",))

    def test_unknown_style_names_the_variable(self):
        for value in ("value", "cep3009-value,amount", "CEP3009-VALUE"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError) as ctx:
                    self.from_env({**self.env, "CASCET_PREFER_STYLES": value})
                self.assertIn("CASCET_PREFER_STYLES", str(ctx.exception))

    def test_contract_package_payee_names_the_variable(self):
        with self.assertRaises(ValueError) as ctx:
            self.from_env({**self.env, "CASCET_ALLOWED_PAYTO": f"{SELLER},hash-{'cd' * 32}"})
        self.assertIn("CASCET_ALLOWED_PAYTO", str(ctx.exception))
        self.assertIn("contract-package payee", str(ctx.exception))


class TestHostedFacilitatorUrl(unittest.TestCase):
    def test_recognizes_the_hosted_facilitator(self):
        for url in (
            "https://x402-facilitator.cspr.cloud",
            "https://x402-facilitator.cspr.cloud/",
            "https://X402-Facilitator.CSPR.cloud/settle",
            "https://x402-facilitator.cspr.cloud.:443",
            " https://x402-facilitator.cspr.cloud ",
            "http://x402-facilitator.cspr.cloud",
        ):
            with self.subTest(url=url):
                self.assertTrue(x402.is_hosted_facilitator_url(url))

    def test_everything_else(self):
        for url in (
            "http://127.0.0.1:4501",
            "https://x402-facilitator.cspr.cloud.evil.test",
            "https://evil.test/x402-facilitator.cspr.cloud",
            "https://x402-facilitator.cspr.cloud@evil.test",
            "https://evil-x402-facilitator.cspr.cloud",
            "x402-facilitator.cspr.cloud",
            "https://[::1",
            "",
            None,
            42,
        ):
            with self.subTest(url=url):
                self.assertFalse(x402.is_hosted_facilitator_url(url))


if __name__ == "__main__":
    unittest.main()
