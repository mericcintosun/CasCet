"""CasperKey loading, account hashes, payTo/asset normalization and the account-hash command."""
import contextlib
import io
import os
import tempfile
import unittest

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from helpers import SELLER, TEST_KEY, TOKEN, VECTORS, x402


class TestCasperKey(unittest.TestCase):
    def test_from_pem_matches_from_seed(self):
        pem = TEST_KEY._sk.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "key.pem")
            with open(path, "wb") as f:
                f.write(pem)
            key = x402.CasperKey.from_pem(path)
        self.assertEqual(key.public_key_hex(), TEST_KEY.public_key_hex())
        self.assertEqual(x402.CasperKey.from_pem_bytes(pem).account_address(), TEST_KEY.account_address())

    def test_secp256k1_pem_is_refused_clearly(self):
        pem = ec.generate_private_key(ec.SECP256K1()).private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        with self.assertRaises(ValueError) as ctx:
            x402.CasperKey.from_pem_bytes(pem)
        self.assertIn("ed25519", str(ctx.exception))

    def test_seed_length(self):
        with self.assertRaises(ValueError):
            x402.CasperKey.from_seed(b"\x01" * 31)

    def test_repr_hides_the_private_key(self):
        self.assertNotIn("_sk", repr(TEST_KEY))
        self.assertNotIn("Ed25519PrivateKey", repr(TEST_KEY))

    def test_sign_only_takes_digests(self):
        self.assertEqual(len(TEST_KEY.sign(b"\x00" * 32)), 65)
        with self.assertRaises(ValueError):
            TEST_KEY.sign(b"\x00" * 31)


class TestAccountHashHelpers(unittest.TestCase):
    def test_rejects_non_public_keys(self):
        for bad in ("00" + "ab" * 32, "01" + "ab" * 31, "02" + "ab" * 32, "zz", "", None):
            with self.subTest(value=bad):
                with self.assertRaises(ValueError):
                    x402.account_hash_from_public_key(bad)

    def test_accepts_0x_prefix(self):
        case = VECTORS["accountHashes"][0]
        self.assertEqual(x402.account_hash_from_public_key("0x" + case["publicKeyHex"]), case["accountHashHex"])

    def test_cli_account_hash(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(x402.main(["account-hash", TEST_KEY.public_key_hex()]), 0)
        self.assertEqual(out.getvalue().strip(), TEST_KEY.account_address())
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(x402.main(["account-hash", "00" + "ab" * 32]), 1)
        self.assertIn("public key", err.getvalue())


class TestNormalization(unittest.TestCase):
    def test_pay_to_forms(self):
        hexpart = SELLER[2:]
        self.assertEqual(x402.normalize_pay_to(SELLER), SELLER)
        self.assertEqual(x402.normalize_pay_to(SELLER.upper()), SELLER)
        self.assertEqual(x402.normalize_pay_to("0x" + SELLER), SELLER)
        self.assertEqual(x402.normalize_pay_to(f"account-hash-{hexpart}"), SELLER)
        self.assertEqual(x402.normalize_pay_to(f"  Account-Hash-{hexpart.upper()} "), SELLER)
        self.assertEqual(x402.normalize_pay_to(f"hash-{hexpart}"), "01" + hexpart)
        self.assertEqual(x402.normalize_pay_to(f"package-hash-{hexpart}"), "01" + hexpart)

    def test_pay_to_public_key_hint(self):
        with self.assertRaises(ValueError) as ctx:
            x402.normalize_pay_to(TEST_KEY.public_key_hex())
        message = str(ctx.exception)
        self.assertIn("public key", message)
        self.assertIn(TEST_KEY.account_address(), message)
        self.assertIn("npx @cascet/cli account-hash", message)

    def test_pay_to_rejects_garbage(self):
        for bad in ("", "00", "hash-", "account-hash-xyz", "03" + "ab" * 32, "00" + "ab" * 33, "ab" * 32):
            with self.subTest(value=bad):
                with self.assertRaises(ValueError):
                    x402.normalize_pay_to(bad)

    def test_asset_forms(self):
        for value in (TOKEN, TOKEN.upper(), "hash-" + TOKEN, "0x" + TOKEN, "package-hash-" + TOKEN,
                      "contract-package-" + TOKEN, " HASH-" + TOKEN + " "):
            with self.subTest(value=value):
                self.assertEqual(x402.normalize_asset(value), TOKEN)
        for bad in ("", "hash-", TOKEN[:-1], "hash-hash-" + TOKEN, None):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    x402.normalize_asset(bad)


if __name__ == "__main__":
    unittest.main()
