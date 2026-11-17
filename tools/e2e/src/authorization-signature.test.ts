import assert from "node:assert/strict";
import { describe, test } from "node:test";
import casperSdk from "casper-js-sdk";
import { toClientCasperSigner } from "@make-software/casper-x402";
import { ExactCasperScheme as MakeClientScheme } from "@make-software/casper-x402/exact/client";
import { ExactCasperScheme as MakeFacilitatorScheme } from "@make-software/casper-x402/exact/facilitator";
import { buildTransferWithAuthorizationDigest } from "@x402/casper";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { clientSignerFromPem, createCasperClientScheme } from "@cascet/client";
import { SignatureReason, verifyPaymentSignature } from "./authorization-signature.js";
import { FORGED_WCSPR_PAYMENTS } from "./ed25519-fixtures.js";
import * as fx from "./rpc-fixtures.js";

const { PrivateKey, PublicKey, KeyAlgorithm } = casperSdk;

const NETWORK = "casper:casper-test" as const;
const LEGACY_TOKEN = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
const WCSPR = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";
const SELLER = `00${"88".repeat(32)}`;
const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

type Auth = { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
type Payload = { signature: string; publicKey: string; authorization: Auth };

const requirements = (asset: string, name: string, extra: Record<string, unknown> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: NETWORK,
  asset,
  amount: "500000000",
  payTo: SELLER,
  maxTimeoutSeconds: 300,
  extra: { name, version: "1", ...extra },
});

const paymentOf = (reqs: PaymentRequirements, payload: Payload): PaymentPayload =>
  ({ x402Version: 2, accepted: reqs, payload }) as unknown as PaymentPayload;

/** A payment signed by CasCet's @x402/casper 2.29 buyer (both styles sign the same way). */
async function signedByBuyer(reqs: PaymentRequirements, algorithm: "ed25519" | "secp256k1" = "ed25519") {
  const key = PrivateKey.generate(algorithm === "secp256k1" ? KeyAlgorithm.SECP256K1 : KeyAlgorithm.ED25519);
  const scheme = createCasperClientScheme(clientSignerFromPem(key.toPem(), algorithm));
  const result = await scheme.createPaymentPayload(2, reqs);
  return { key, payload: result.payload as unknown as Payload };
}

/** A payment signed by MAKE's casper-x402 1.0.0 client (the buyers CasCet shipped before 2.29). */
async function signedByMake(reqs: PaymentRequirements) {
  const key = PrivateKey.generate(KeyAlgorithm.ED25519);
  const client = new MakeClientScheme(toClientCasperSigner(key as unknown as Parameters<typeof toClientCasperSigner>[0]));
  const result = await client.createPaymentPayload(2, reqs as unknown as Parameters<typeof client.createPaymentPayload>[1]);
  return { key, payload: result.payload as unknown as Payload };
}

/** The authorization and signature a recorded settlement carried. */
function recordedPayment(tx: { payload: { fields: { args: { Named: ReadonlyArray<readonly [string, { bytes: string; parsed: unknown }]> } } } }) {
  const args = Object.fromEntries(tx.payload.fields.args.Named.map(([n, v]) => [n, v])) as Record<string, { bytes: string; parsed: unknown }>;
  return {
    signature: args["signature"]!.bytes.slice(8),
    publicKey: args["public_key"]!.bytes,
    authorization: {
      from: args["from"]!.bytes,
      to: args["to"]!.bytes,
      value: String((args["amount"] ?? args["value"])!.parsed),
      validAfter: String(args["valid_after"]!.parsed),
      validBefore: String(args["valid_before"]!.parsed),
      nonce: args["nonce"]!.bytes.slice(8),
    },
  };
}

describe("EIP-712 digest: the migration's test vectors (both styles sign the same message)", () => {
  const authorization: Auth = {
    from: "0065190126b1ca282f041fad6b74b845a3c48e0c8411392b13c640a16a1438faf9",
    to: "00881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36",
    value: "500000000",
    validAfter: "0",
    validBefore: "1893456000",
    nonce: "11".repeat(32),
  };
  const digest = (name: string, asset: string) =>
    Buffer.from(buildTransferWithAuthorizationDigest({ name, version: "1", network: NETWORK, asset, authorization })).toString("hex");

  test("legacy-amount domain (CasCet X402 Token, cb65a928…)", () => {
    assert.equal(digest("CasCet X402 Token", LEGACY_TOKEN), "fa7f8fb8a4baf5f10c417995ed89ef3e4a187827d0b390da72ea6fc8473c019f");
  });

  test("cep3009-value domain (Wrapped CSPR, 3d80df21…)", () => {
    assert.equal(digest("Wrapped CSPR", WCSPR), "7018efb474af3db4090555b34126928be63ef25e57af57c3be95050bb210ca55");
  });
});

describe("signature verification", () => {
  test("the signature of settled testnet tx 04e54a95 verifies (a legacy-amount payment the token accepted)", () => {
    const payload = recordedPayment(fx.testnetSettledTransaction);
    const reqs = { ...requirements(LEGACY_TOKEN, "CasCet X402 Token"), payTo: payload.authorization.to, amount: payload.authorization.value };
    assert.deepEqual(verifyPaymentSignature(paymentOf(reqs, payload), reqs), { isValid: true, payer: payload.authorization.from });
    // The same signature under the Wrapped CSPR domain is not a valid payment.
    const wrongDomain = { ...requirements(WCSPR, "Wrapped CSPR"), payTo: payload.authorization.to, amount: payload.authorization.value };
    assert.equal(verifyPaymentSignature(paymentOf(wrongDomain, payload), wrongDomain).invalidReason, SignatureReason.invalidSignature);
  });

  test("the buyer's payments verify for both styles, ed25519 and secp256k1", async () => {
    for (const [asset, name, style] of [
      [LEGACY_TOKEN, "CasCet X402 Token", "legacy-amount"],
      [WCSPR, "Wrapped CSPR", "cep3009-value"],
    ] as const) {
      for (const algorithm of ["ed25519", "secp256k1"] as const) {
        const reqs = requirements(asset, name, { authorizationStyle: style });
        const { key, payload } = await signedByBuyer(reqs, algorithm);
        const verdict = verifyPaymentSignature(paymentOf(reqs, payload), reqs);
        assert.deepEqual(verdict, { isValid: true, payer: `00${key.publicKey.accountHash().toHex()}` }, `${style} ${algorithm}`);
      }
    }
  });

  test("a 0x prefix on the signature or the nonce is accepted, as the core and the settlement accept it", async () => {
    const reqs = requirements(LEGACY_TOKEN, "CasCet X402 Token");
    const { payload } = await signedByBuyer(reqs);
    const prefixed = { ...payload, signature: `0x${payload.signature}`, authorization: { ...payload.authorization, nonce: `0x${payload.authorization.nonce}` } };
    assert.equal(verifyPaymentSignature(paymentOf(reqs, prefixed), reqs).isValid, true);
  });

  test("tampering with any signed field or the domain breaks the signature", async () => {
    const reqs = requirements(WCSPR, "Wrapped CSPR");
    const { payload } = await signedByBuyer(reqs);
    const tamper = (change: (p: Payload, r: PaymentRequirements) => void) => {
      const p = structuredClone(payload);
      const r = structuredClone(reqs);
      change(p, r);
      return verifyPaymentSignature(paymentOf(r, p), r).invalidReason;
    };
    const cases: Array<(p: Payload, r: PaymentRequirements) => void> = [
      p => (p.authorization.nonce = "77".repeat(32)),
      p => (p.authorization.value = "500000001"),
      p => (p.authorization.to = `00${"89".repeat(32)}`),
      p => (p.authorization.validBefore = String(Number(p.authorization.validBefore) + 1)),
      (_p, r) => (r.extra = { ...r.extra, name: "CasCet X402 Token" }),
      (_p, r) => (r.extra = { ...r.extra, version: "2" }),
      (_p, r) => (r.asset = LEGACY_TOKEN),
    ];
    for (const change of cases) assert.equal(tamper(change), SignatureReason.invalidSignature);
  });

  test("the key must be the payer's, its algorithm tag the signature's, and secp256k1 signatures canonical", async () => {
    const reqs = requirements(LEGACY_TOKEN, "CasCet X402 Token");
    const { payload } = await signedByBuyer(reqs);
    const other = PrivateKey.generate(KeyAlgorithm.ED25519).publicKey.toHex();
    const swappedKey = { ...payload, publicKey: other };
    assert.equal(verifyPaymentSignature(paymentOf(reqs, swappedKey), reqs).invalidReason, SignatureReason.publicKeyMismatch);
    const wrongTag = { ...payload, signature: `02${payload.signature.slice(2)}` };
    assert.equal(verifyPaymentSignature(paymentOf(reqs, wrongTag), reqs).invalidReason, SignatureReason.invalidSignature);

    // A secp256k1 signature with s replaced by n − s verifies mathematically but is malleable: refused.
    const secp = await signedByBuyer(reqs, "secp256k1");
    const s = BigInt(`0x${secp.payload.signature.slice(66)}`);
    const highS = `${secp.payload.signature.slice(0, 66)}${(SECP256K1_N - s).toString(16).padStart(64, "0")}`;
    const malleated = { ...secp.payload, signature: highS };
    assert.equal(verifyPaymentSignature(paymentOf(reqs, malleated), reqs).invalidReason, SignatureReason.nonCanonicalSignature);
  });

  test("an ed25519 signature only the cofactored check accepts is refused: the token's verify_strict would revert the settle", () => {
    // Small-order points and a mixed-order R (ed25519-fixtures.ts): casper-js-sdk accepts each signature,
    // casper-types' crypto::verify refuses it, and the reverted settle would burn the fee payer's gas limit.
    const reqs = requirements(WCSPR, "Wrapped CSPR");
    for (const forged of FORGED_WCSPR_PAYMENTS) {
      const authorization: Auth = { from: forged.from, to: SELLER, value: "500000000", validAfter: "0", validBefore: "1893456000", nonce: forged.nonce };
      const payload: Payload = { signature: forged.signature, publicKey: forged.publicKey, authorization };
      const key = PublicKey.fromHex(forged.publicKey);
      assert.equal(`00${key.accountHash().toHex()}`, forged.from);
      const digest = buildTransferWithAuthorizationDigest({ name: "Wrapped CSPR", version: "1", network: NETWORK, asset: WCSPR, authorization });
      assert.equal(key.verifySignature(digest, Buffer.from(forged.signature, "hex")), true, `${forged.label}: the sdk's check passes`);
      assert.deepEqual(
        verifyPaymentSignature(paymentOf(reqs, payload), reqs),
        {
          isValid: false,
          invalidReason: SignatureReason.invalidSignature,
          invalidMessage: `the token's ed25519 check (verify_strict) refuses this signature: ${forged.problem}`,
          payer: forged.from,
        },
        forged.label,
      );
    }
  });

  test("the payload's network, the domain fields and the payload shape are required", async () => {
    const reqs = requirements(LEGACY_TOKEN, "CasCet X402 Token");
    const { payload } = await signedByBuyer(reqs);
    const otherNetwork = { x402Version: 2, accepted: { ...reqs, network: "casper:casper" }, payload } as unknown as PaymentPayload;
    assert.equal(verifyPaymentSignature(otherNetwork, reqs).invalidReason, SignatureReason.networkMismatch);
    const noName = { ...reqs, extra: { version: "1" } };
    assert.equal(verifyPaymentSignature(paymentOf(noName, payload), noName).invalidReason, SignatureReason.missingTokenName);
    const noVersion = { ...reqs, extra: { name: "CasCet X402 Token" } };
    assert.equal(verifyPaymentSignature(paymentOf(noVersion, payload), noVersion).invalidReason, SignatureReason.missingTokenVersion);
    const malformed = { ...payload, authorization: { ...payload.authorization, nonce: 7 } } as unknown as Payload;
    assert.equal(verifyPaymentSignature(paymentOf(reqs, malformed), reqs).invalidReason, SignatureReason.malformedPayload);
    const shortSig = { ...payload, signature: payload.signature.slice(0, 128) };
    assert.equal(verifyPaymentSignature(paymentOf(reqs, shortSig), reqs).invalidReason, SignatureReason.invalidSignature);
  });

  test("agrees with casper-x402 1.0.0's verification on payments from both buyer generations", async () => {
    // MAKE's facilitator scheme only signs/submits through the signer; verification is local.
    const notUsed = async (): Promise<never> => {
      throw new Error("not used");
    };
    const make = new MakeFacilitatorScheme({
      getNetworkConfig: async (n: string) => ({ chainName: n.split(":")[1]!, rpcUrl: "http://127.0.0.1:9/rpc" }),
      getAddresses: () => ["fe".repeat(32)],
      getPublicKeyHex: () => `01${"fe".repeat(32)}`,
      signTransaction: notUsed,
      putTransaction: notUsed,
      waitForTransaction: notUsed,
    } as unknown as ConstructorParameters<typeof MakeFacilitatorScheme>[0]);
    const reqs = requirements(LEGACY_TOKEN, "CasCet X402 Token");
    for (const sign of [signedByBuyer, signedByMake]) {
      const { payload } = await sign(reqs);
      const variants: Array<[Payload, PaymentRequirements]> = [
        [payload, reqs],
        [{ ...payload, authorization: { ...payload.authorization, nonce: "66".repeat(32) } }, reqs],
        [payload, { ...reqs, extra: { name: "Wrapped CSPR", version: "1" } }],
      ];
      for (const [p, r] of variants) {
        const ours = verifyPaymentSignature(paymentOf(r, p), r);
        const theirs = await make.verify(paymentOf(r, p) as never, r as never);
        assert.equal(ours.isValid, theirs.isValid);
        if (!ours.isValid) assert.equal(ours.invalidReason, theirs.invalidReason);
      }
    }
  });
});
