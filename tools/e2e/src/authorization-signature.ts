import casperSdk from "casper-js-sdk";
import { buildTransferWithAuthorizationDigest, isCanonicalSecp256k1Signature } from "@x402/casper";
import type { Network, PaymentPayload, PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { ed25519StrictProblem } from "./ed25519-strict.js";

const { PublicKey } = casperSdk;

/**
 * Cryptographic check of an x402 `exact` Casper payment, the same for both
 * authorization styles: `legacy-amount` and `cep3009-value` tokens verify the
 * same EIP-712 message,
 *
 *   TransferWithAuthorization(address from, address to, uint256 value,
 *     uint256 validAfter, uint256 validBefore, bytes32 nonce)
 *
 * under the domain (name, version, chain_name = CAIP-2 network,
 * contract_package_hash). The digest is @x402/casper 2.29's own
 * (`buildTransferWithAuthorizationDigest`, checked against the migration test
 * vectors and the signature of settled testnet tx 04e54a95…); the checks are
 * those of @x402/casper's facilitator without its RPC preflight (the facilitator
 * core runs its own, with deadlines and the correct dictionary keys):
 *  - the payload's network matches the requirements;
 *  - the requirements name the EIP-712 domain (`extra.name`, `extra.version`);
 *  - the public key's account hash is the payer (`authorization.from`);
 *  - the signature is 65 bytes, its algorithm tag matches the key, and a
 *    secp256k1 signature is canonical (low s);
 *  - the signature verifies over the digest;
 *  - an ed25519 signature also passes the token's own check, ed25519-dalek's
 *    `verify_strict` (ed25519-strict.ts): casper-js-sdk's check is cofactored
 *    and accepts signatures the token refuses (a small-order key or R, a
 *    mixed-order R), whose settle reverts and burns the whole gas limit.
 * Reason codes are @x402/casper's, so x402 clients classify them as failures
 * that happened before anything was submitted.
 *
 * Shape, amount, payee, validity window and nonce format are checked by the
 * facilitator core before this runs.
 */

export const SignatureReason = {
  networkMismatch: "invalid_exact_casper_facilitator_network_mismatch",
  malformedPayload: "invalid_exact_casper_facilitator_invalid_scheme",
  missingTokenName: "invalid_exact_casper_facilitator_missing_token_name",
  missingTokenVersion: "invalid_exact_casper_facilitator_missing_token_version",
  failedToHash: "invalid_exact_casper_facilitator_failed_to_hash",
  invalidSignature: "invalid_exact_casper_facilitator_invalid_signature",
  nonCanonicalSignature: "invalid_exact_casper_facilitator_non_canonical_signature",
  publicKeyMismatch: "invalid_exact_casper_facilitator_publickey_mismatch",
} as const;

const HEX = /^[0-9a-fA-F]*$/;

interface ExactCasperPayloadShape {
  signature: string;
  publicKey: string;
  authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
}

function shapeOf(payload: PaymentPayload): ExactCasperPayloadShape | undefined {
  const p = payload.payload as Partial<ExactCasperPayloadShape> | undefined;
  const a = p?.authorization;
  if (
    !p ||
    typeof p.signature !== "string" ||
    typeof p.publicKey !== "string" ||
    !a ||
    typeof a.from !== "string" ||
    typeof a.to !== "string" ||
    typeof a.value !== "string" ||
    typeof a.validAfter !== "string" ||
    typeof a.validBefore !== "string" ||
    typeof a.nonce !== "string"
  ) {
    return undefined;
  }
  return p as ExactCasperPayloadShape;
}

const invalid = (invalidReason: string, payer: string | undefined, invalidMessage: string): VerifyResponse => ({
  isValid: false,
  invalidReason,
  invalidMessage,
  ...(payer ? { payer } : {}),
});

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);

/** Verify the payer's signature over the payment's EIP-712 digest (no RPC). */
export function verifyPaymentSignature(payload: PaymentPayload, requirements: PaymentRequirements): VerifyResponse {
  if (payload.accepted?.network !== requirements.network) {
    return invalid(SignatureReason.networkMismatch, undefined, "the payload was signed for another network");
  }
  const p = shapeOf(payload);
  if (!p) return invalid(SignatureReason.malformedPayload, undefined, "malformed payload");
  const payer = p.authorization.from;

  const name = requirements.extra?.["name"];
  const version = requirements.extra?.["version"];
  if (typeof name !== "string" || name === "") return invalid(SignatureReason.missingTokenName, payer, "extra.name is required");
  if (typeof version !== "string" || version === "") {
    return invalid(SignatureReason.missingTokenVersion, payer, "extra.version is required");
  }

  // The same normalization as the facilitator core (and the settlement it builds): an optional 0x.
  const signatureHex = p.signature.replace(/^0x/i, "");
  if (signatureHex.length !== 130 || !HEX.test(signatureHex)) {
    return invalid(SignatureReason.invalidSignature, payer, "signature must be 65 bytes of hex");
  }
  const signature = Uint8Array.from(Buffer.from(signatureHex, "hex"));
  if (p.publicKey.slice(0, 2).toLowerCase() !== signatureHex.slice(0, 2).toLowerCase()) {
    return invalid(SignatureReason.invalidSignature, payer, "public key and signature algorithm tags do not match");
  }
  if (!isCanonicalSecp256k1Signature(signature)) {
    return invalid(SignatureReason.nonCanonicalSignature, payer, "secp256k1 signature is not in low-s form");
  }

  let publicKey: InstanceType<typeof PublicKey>;
  try {
    publicKey = PublicKey.fromHex(p.publicKey);
  } catch (err) {
    return invalid(SignatureReason.invalidSignature, payer, `invalid public key: ${describe(err)}`);
  }
  if (`00${publicKey.accountHash().toHex()}`.toLowerCase() !== payer.toLowerCase()) {
    return invalid(SignatureReason.publicKeyMismatch, payer, "public key does not match authorization.from");
  }

  let digest: Uint8Array;
  try {
    digest = buildTransferWithAuthorizationDigest({
      name,
      version,
      network: requirements.network as Network,
      asset: requirements.asset.toLowerCase().replace(/^hash-/, ""),
      authorization: { ...p.authorization, nonce: p.authorization.nonce.replace(/^0x/i, "") },
    });
  } catch (err) {
    return invalid(SignatureReason.failedToHash, payer, describe(err));
  }

  try {
    if (!publicKey.verifySignature(digest, signature)) {
      return invalid(SignatureReason.invalidSignature, payer, "signature verification failed");
    }
  } catch (err) {
    return invalid(SignatureReason.invalidSignature, payer, describe(err));
  }
  // The token verifies ed25519 cofactorless and refuses small-order points; the
  // check above does neither. Checked on the payload's own key bytes, the ones
  // the settlement sends.
  if (signatureHex.slice(0, 2) === "01") {
    const problem = ed25519StrictProblem(Buffer.from(p.publicKey.slice(2), "hex"), digest, signature.subarray(1));
    if (problem) {
      return invalid(SignatureReason.invalidSignature, payer, `the token's ed25519 check (verify_strict) refuses this signature: ${problem}`);
    }
  }
  return { isValid: true, payer };
}
