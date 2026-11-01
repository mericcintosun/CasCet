import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildTransferWithAuthorizationDigest } from "@x402/casper";
import type { PaymentRequirements } from "@x402/core/types";
import casperSdk from "casper-js-sdk";
import { clientSignerFromPem, createCasperClientScheme, loadClientSigner } from "./casper-scheme.js";
import { DEFAULT_MAX_AUTHORIZATION_SECONDS } from "./policy.js";

const { KeyAlgorithm, PrivateKey, PublicKey } = casperSdk;

const LEGACY_TESTNET = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
const WCSPR_TESTNET = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";
const SELLER = "00881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const fromHex = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "hex"));

describe("EIP-712 digest vectors (DESIGN section 8): both styles sign the same message", () => {
  const authorization = {
    from: "0065190126b1ca282f041fad6b74b845a3c48e0c8411392b13c640a16a1438faf9",
    to: SELLER,
    value: "500000000",
    validAfter: "0",
    validBefore: "1893456000",
    nonce: "11".repeat(32),
  };

  it("legacy-amount domain (CasCet X402 Token, testnet)", () => {
    const digest = buildTransferWithAuthorizationDigest({
      name: "CasCet X402 Token",
      version: "1",
      network: "casper:casper-test",
      asset: LEGACY_TESTNET,
      authorization,
    });
    assert.equal(hex(digest), "fa7f8fb8a4baf5f10c417995ed89ef3e4a187827d0b390da72ea6fc8473c019f");
  });

  it("cep3009-value domain (Wrapped CSPR, testnet)", () => {
    const digest = buildTransferWithAuthorizationDigest({
      name: "Wrapped CSPR",
      version: "1",
      network: "casper:casper-test",
      asset: WCSPR_TESTNET,
      authorization,
    });
    assert.equal(hex(digest), "7018efb474af3db4090555b34126928be63ef25e57af57c3be95050bb210ca55");
  });
});

describe("structural signer and @x402/casper client scheme", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cascet-signer-test-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  for (const [label, algorithm, tag] of [
    ["ed25519", KeyAlgorithm.ED25519, "01"],
    ["secp256k1", KeyAlgorithm.SECP256K1, "02"],
  ] as const) {
    it(`builds a plain-object signer from a ${label} PEM file`, async () => {
      // A throwaway key generated for this test run only.
      const key = PrivateKey.generate(algorithm);
      const path = join(dir, `throwaway-${label}.pem`);
      writeFileSync(path, key.toPem(), { mode: 0o600 });
      const signer = await loadClientSigner(path, label);
      assert.equal(signer.accountAddress(), `00${key.publicKey.accountHash().toHex()}`);
      assert.equal(signer.publicKey(), key.publicKey.toHex());
      assert.match(signer.publicKey(), new RegExp(`^${tag}`));
      const digest = fromHex("ab".repeat(32));
      const signature = await signer.signEIP712(digest);
      assert.equal(signature.length, 65, "algorithm tag + 64 bytes");
      assert.equal(signature[0], Number.parseInt(tag, 16));
      assert.equal(PublicKey.fromHex(signer.publicKey()).verifySignature(digest, signature), true);
    });
  }

  it("signs every style through one scheme without default-asset lookup", async () => {
    const key = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = clientSignerFromPem(key.toPem());
    const scheme = createCasperClientScheme(signer);
    assert.equal(scheme.scheme, "exact");
    assert.equal(scheme.findDefaultAsset, undefined, "x402 must not treat csprUSD as allowed by default");
    for (const [asset, name, style] of [
      [LEGACY_TESTNET, "CasCet X402 Token", "legacy-amount"],
      [WCSPR_TESTNET, "Wrapped CSPR", "cep3009-value"],
    ] as const) {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "casper:casper-test",
        asset,
        amount: "500000000",
        payTo: SELLER,
        maxTimeoutSeconds: 300,
        extra: { name, version: "1", authorizationStyle: style },
      };
      const before = Math.floor(Date.now() / 1000);
      const result = await scheme.createPaymentPayload(2, requirements);
      const payload = result.payload as {
        signature: string;
        publicKey: string;
        authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
      };
      assert.equal(payload.authorization.from, signer.accountAddress());
      assert.equal(payload.authorization.to, SELLER);
      assert.equal(payload.authorization.value, "500000000");
      assert.equal(payload.authorization.validAfter, "0");
      assert.ok(Number(payload.authorization.validBefore) >= before + 300);
      assert.match(payload.authorization.nonce, /^[0-9a-f]{64}$/);
      const digest = buildTransferWithAuthorizationDigest({ name, version: "1", network: "casper:casper-test", asset, authorization: payload.authorization });
      assert.equal(PublicKey.fromHex(payload.publicKey).verifySignature(digest, fromHex(payload.signature)), true, style);
    }
    await assert.rejects(
      scheme.createPaymentPayload(2, {
        scheme: "exact",
        network: "casper:casper-test",
        asset: WCSPR_TESTNET,
        amount: "1",
        payTo: SELLER,
        maxTimeoutSeconds: 300,
        extra: { version: "1" },
      }),
      /missing_token_name/,
    );
  });
});

describe("createCasperClientScheme: last checks before a signature", () => {
  const signer = clientSignerFromPem(PrivateKey.generate(KeyAlgorithm.ED25519).toPem());
  const requirements = (overrides: Record<string, unknown> = {}): PaymentRequirements =>
    ({
      scheme: "exact",
      network: "casper:casper-test",
      asset: WCSPR_TESTNET,
      amount: "400",
      payTo: SELLER,
      maxTimeoutSeconds: 300,
      extra: { name: "Wrapped CSPR", version: "1", authorizationStyle: "cep3009-value" },
      ...overrides,
    }) as PaymentRequirements;
  /** A signer that fails the test if it is ever asked to sign. */
  const neverSigns = {
    accountAddress: signer.accountAddress,
    publicKey: signer.publicKey,
    signEIP712: async (): Promise<Uint8Array> => assert.fail("nothing may be signed"),
  };

  it("signs only for its own network, and never takes a wildcard", async () => {
    const scheme = createCasperClientScheme(signer, { network: "casper:casper-test" });
    assert.equal((await scheme.createPaymentPayload(2, requirements())).x402Version, 2);
    await assert.rejects(
      createCasperClientScheme(neverSigns, { network: "casper:casper-test" }).createPaymentPayload(2, requirements({ network: "casper:casper" })),
      /^Error: refusing to sign: the requirements name network "casper:casper", but this scheme signs for casper:casper-test only$/,
    );
    assert.throws(() => createCasperClientScheme(signer, { network: "casper:*" }), /wildcards are not allowed/);
  });

  it("refuses a payee that is not an account hash, contract packages included", async () => {
    const scheme = createCasperClientScheme(neverSigns);
    for (const payTo of [`01${"c3".repeat(32)}`, `account-hash-${SELLER.slice(2)}`, "00abc", 7]) {
      await assert.rejects(scheme.createPaymentPayload(2, requirements({ payTo })), /refusing to sign: payTo .* is not an account hash/);
    }
  });

  it("refuses a validity window that is malformed or longer than its limit (default 900 s)", async () => {
    assert.equal(DEFAULT_MAX_AUTHORIZATION_SECONDS, 900);
    const scheme = createCasperClientScheme(neverSigns, { network: "casper:casper-test", maxAmountPerPayment: 1000n });
    // "300" would be concatenated by @x402/casper (validBefore = now + "300"), 1e9 s is about 31 years.
    for (const maxTimeoutSeconds of ["300", 1e9, 0, -1, 1.5, null, undefined, Number.NaN, DEFAULT_MAX_AUTHORIZATION_SECONDS + 1]) {
      await assert.rejects(
        scheme.createPaymentPayload(2, requirements({ maxTimeoutSeconds })),
        /^Error: refusing to sign: (malformed validity window|validity window .* is longer than 900 s)/,
        `maxTimeoutSeconds ${String(maxTimeoutSeconds)}`,
      );
    }
    await assert.rejects(
      scheme.createPaymentPayload(2, requirements({ maxTimeoutSeconds: "300" })),
      /refusing to sign: malformed validity window maxTimeoutSeconds "300"/,
    );
    await assert.rejects(
      scheme.createPaymentPayload(2, requirements({ maxTimeoutSeconds: 901 })),
      /refusing to sign: validity window 901 s is longer than 900 s$/,
    );

    const before = Math.floor(Date.now() / 1000);
    const signed = await createCasperClientScheme(signer).createPaymentPayload(2, requirements({ maxTimeoutSeconds: 300 }));
    const validBefore = Number((signed.payload as { authorization: { validBefore: string } }).authorization.validBefore);
    assert.ok(validBefore >= before + 300 && validBefore <= Math.floor(Date.now() / 1000) + 300, `validBefore ${validBefore}`);
    assert.equal(
      (await createCasperClientScheme(signer).createPaymentPayload(2, requirements({ maxTimeoutSeconds: 900 }))).x402Version,
      2,
    );
  });

  it("takes a tighter validity-window limit, and validates it when it is built", async () => {
    const tight = createCasperClientScheme(neverSigns, { maxAuthorizationSeconds: 60 });
    await assert.rejects(
      tight.createPaymentPayload(2, requirements({ maxTimeoutSeconds: 61 })),
      /refusing to sign: validity window 61 s is longer than 60 s/,
    );
    assert.equal(
      (await createCasperClientScheme(signer, { maxAuthorizationSeconds: 60 }).createPaymentPayload(2, requirements({ maxTimeoutSeconds: 60 })))
        .x402Version,
      2,
    );
    for (const maxAuthorizationSeconds of [0, -1, 1.5, "900", Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => createCasperClientScheme(signer, { maxAuthorizationSeconds: maxAuthorizationSeconds as number }),
        /maxAuthorizationSeconds must be a positive whole number of seconds/,
        String(maxAuthorizationSeconds),
      );
    }
  });

  it("refuses malformed amounts (M32)", async () => {
    const scheme = createCasperClientScheme(neverSigns);
    for (const amount of ["-1000000", "0x10", "1e5", "", "5.0", " 5", "0", "000", "9".repeat(41), 100, null]) {
      await assert.rejects(
        scheme.createPaymentPayload(2, requirements({ amount })),
        /refusing to sign: malformed amount/,
        `amount ${JSON.stringify(amount)}`,
      );
    }
  });

  it("refuses above its own per-payment cap and above the cap x402's spend controls pass in", async () => {
    const capped = createCasperClientScheme(signer, { maxAmountPerPayment: 400n });
    assert.equal((await capped.createPaymentPayload(2, requirements({ amount: "400" }))).x402Version, 2);
    await assert.rejects(
      createCasperClientScheme(neverSigns, { maxAmountPerPayment: "400" }).createPaymentPayload(2, requirements({ amount: "401" })),
      /refusing to sign: amount 401 exceeds the per-payment cap 400/,
    );
    const open = createCasperClientScheme(neverSigns);
    await assert.rejects(
      open.createPaymentPayload(2, requirements({ amount: "400" }), { maxAmountPerPayment: "300" }),
      /refusing to sign: amount 400 exceeds the spend-control cap 300/,
    );
    await assert.rejects(
      open.createPaymentPayload(2, requirements({ amount: "400" }), { maxAmountPerPayment: "$1" }),
      /refusing to sign: malformed spend-control cap/,
    );
    assert.throws(() => createCasperClientScheme(signer, { maxAmountPerPayment: "-1" }), /maxAmountPerPayment must be a whole number/);
  });

  it("refuses an authorization style it does not know", async () => {
    await assert.rejects(
      createCasperClientScheme(neverSigns).createPaymentPayload(2, requirements({ extra: { name: "Wrapped CSPR", version: "1", authorizationStyle: "permit2" } })),
      /refusing to sign: unknown authorization style "permit2"/,
    );
  });
});
