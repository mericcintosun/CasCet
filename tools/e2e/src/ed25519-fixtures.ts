/**
 * ed25519 vectors for ed25519-strict.ts, with the verdicts of the two checks
 * that disagree:
 *  - `chain`: casper-types 6.1.0 `crypto::verify` (ed25519-dalek 2.2.0
 *    `verify_strict`), the check the tokens run on-chain. Recorded offline on
 *    2026-11-02 with a small Rust program built against those crates (no
 *    network, no keys of any account).
 *  - `sdk`: casper-js-sdk 5.3.0 `PublicKey.verifySignature` (@noble/ed25519
 *    1.7.5, cofactored), the check payments went through before.
 * Hex without Casper's algorithm tag; `message` is the signed bytes (for a
 * payment, its EIP-712 digest).
 */

export interface Ed25519Vector {
  label: string;
  publicKey: string;
  message: string;
  signature: string;
  chain: boolean;
  sdk: boolean;
}

/** An order-8 point: a "weak" public key or R (libsodium's blocklist). */
export const ORDER_8_POINT = "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a";

/** RFC 8032 §7.1 TEST 1. */
const RFC8032_TEST1 = {
  publicKey: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  signature: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
};

export const ED25519_VECTORS: readonly Ed25519Vector[] = [
  { label: "RFC 8032 TEST 1", ...RFC8032_TEST1, message: "", chain: true, sdk: true },
  {
    label: "RFC 8032 TEST 2",
    publicKey: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    message: "72",
    signature: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
    chain: true,
    sdk: true,
  },
  { label: "TEST 1 over another message", ...RFC8032_TEST1, message: "00", chain: false, sdk: false },
  {
    label: "TEST 1 with s + L (non-canonical s)",
    publicKey: RFC8032_TEST1.publicKey,
    message: "",
    signature: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901554c8c7872aa064e049dbb3013fbf29380d25bf5f0595bbe24655141438e7a101b",
    chain: false,
    sdk: false,
  },
  {
    label: "TEST 1 with R's sign bit flipped",
    publicKey: RFC8032_TEST1.publicKey,
    message: "",
    signature: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901d55fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    chain: false,
    sdk: false,
  },
  {
    label: "weak key, small-order R, s = 0 (any message)",
    publicKey: ORDER_8_POINT,
    message: "",
    signature: `${ORDER_8_POINT}${"00".repeat(32)}`,
    chain: false,
    sdk: true,
  },
  {
    label: "identity key encoded with x's sign bit set, small-order R, s = 0",
    publicKey: `01${"00".repeat(30)}80`,
    message: "",
    signature: `${ORDER_8_POINT}${"00".repeat(32)}`,
    chain: false,
    sdk: true,
  },
  {
    // The chain accepts it: verify_strict refuses small-order points, not mixed-order ones, and 8 divides k here, so
    // the order-8 part of the key vanishes from the equation. A check that also wanted a torsion-free key would be
    // stricter than the chain.
    label: "mixed-order key (aB + an order-8 point), 8 divides k",
    publicKey: "2b2c88c3abb0bf48d16c56f48241055901155fa503fc5a180bfc96d368280fde",
    message: "0000000000000000000000000000000000000000000000000000000000000000",
    signature: "ae9f778ed1919d8f5ff31a22b6c2fd0e273abc752daa709c2a7506858ef373e827f3d4cc673fe488580c281a8d58a818bad7cf4b5a1f67a35c5085d30cdb8a05",
    chain: true,
    sdk: true,
  },
  {
    label: "mixed-order R (rB + an order-8 point), s = r + k·a",
    publicKey: "f9f8fa92fe5a2790752ea0ec1f356c739ac3a1fa603b5c972fe39225332e0592",
    message: "ba32d4630961b5b18345af763d155115c778eebfd87f5a362de63c09b49687bc",
    signature: "199c69e0b8bec9792c92c7b3ea8d06f17d8805619b076d5a2eacb747e93c1dd6ba623e77cbf6c8debc3fe201b11f36e0f269f3ac2472a101d8cd447fe8ab5d0c",
    chain: false,
    sdk: true,
  },
  {
    label: "small-order R, s = k·a",
    publicKey: "a67f37e9cf764e0fa0daf7e927caab4a8f43667360e14c6a1b66965c0fb3d52c",
    message: "d8178c98ef43ed9a3fbb4edc725ea70e1f9a90b62be282d2ee1dca61baa36a25",
    signature: `${ORDER_8_POINT}6d46da6afa95e752f8790d9613cd584fc08dc0d00854e570d06f69d0522ccd05`,
    chain: false,
    sdk: true,
  },
  {
    label: "weak key, R = [s]B (any message)",
    publicKey: ORDER_8_POINT,
    message: "0bfd327f231a240f371fa75a0dd4cd3f76978d3b42cf4d4b3c87d5d1549b5d2d",
    signature: "7be7b1301ef7411bab5078d9051ff70f9e31eb1a62d23ca1d5d7efffb5d179a9be7215321eec736af05ce5de8a5395a663064de6f57dc8ffbbf7b71816c6e604",
    chain: false,
    sdk: true,
  },
];

/**
 * A signature for the weak key {@link ORDER_8_POINT} that casper-js-sdk accepts
 * over EVERY message, with no private key: R = [s]B, so R + [k]A − [s]B is
 * [k]A, an order-8 point the cofactor clears. Tagged, as in an x402 payload.
 */
export const WEAK_KEY_SIGNATURE =
  "017be7b1301ef7411bab5078d9051ff70f9e31eb1a62d23ca1d5d7efffb5d179a9be7215321eec736af05ce5de8a5395a663064de6f57dc8ffbbf7b71816c6e604";

/**
 * x402 payloads of the forged vectors above: Wrapped CSPR on casper:casper-test
 * (`extra.name` "Wrapped CSPR", version "1"), 0.5 WCSPR to `00` + 88…88, valid
 * from 0 to 1893456000. casper-js-sdk accepts each signature; the token would
 * revert each settle with InvalidSignature.
 */
export const FORGED_WCSPR_PAYMENTS = [
  {
    label: "mixed-order R",
    publicKey: "01f9f8fa92fe5a2790752ea0ec1f356c739ac3a1fa603b5c972fe39225332e0592",
    signature:
      "01199c69e0b8bec9792c92c7b3ea8d06f17d8805619b076d5a2eacb747e93c1dd6ba623e77cbf6c8debc3fe201b11f36e0f269f3ac2472a101d8cd447fe8ab5d0c",
    from: "004a4afd1a38468321abce9fb75c7b0c9cbf5c7f9a14729b915d914155333fd87a",
    nonce: "a1".repeat(32),
    problem: "[s]B − [k]A is not R",
  },
  {
    label: "small-order R",
    publicKey: "01a67f37e9cf764e0fa0daf7e927caab4a8f43667360e14c6a1b66965c0fb3d52c",
    signature: `01${ORDER_8_POINT}6d46da6afa95e752f8790d9613cd584fc08dc0d00854e570d06f69d0522ccd05`,
    from: "00b9850655a2864dc49379891941daca72fbeb49f2921286819c0b2bb04ca577d7",
    nonce: "a2".repeat(32),
    problem: "R has small order",
  },
  {
    label: "weak key",
    publicKey: `01${ORDER_8_POINT}`,
    signature: WEAK_KEY_SIGNATURE,
    from: "0007ea913b04b76330f8dc7578d14f9d22ebc23e4ef60bbe115a758d87be7f6a70",
    nonce: "a3".repeat(32),
    problem: "the public key has small order",
  },
] as const;
