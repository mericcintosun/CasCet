/**
 * Wallet signature → Casper approval signature (finding M15).
 *
 * A Casper approval stores the signature with a one-byte key-algorithm tag in
 * front of it (1 = ed25519, 2 = secp256k1), 65 bytes in total. Casper Wallet's
 * provider returns the RAW 64-byte signature, and casper-js-sdk
 * `Transaction.setSignature(bytes, pub)` stores the bytes verbatim (only `sign()`
 * adds the tag), so the tag has to be added here or the node rejects the
 * approval.
 */

export class SignatureFormatError extends Error {
  override name = "SignatureFormatError";
}

/** Parse an even-length hex string (an optional 0x prefix is tolerated). Throws on anything else. */
export function hexToBytesStrict(hex: string): Uint8Array {
  const h = hex.trim().replace(/^0x/i, "");
  if (h.length === 0 || h.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(h)) {
    throw new SignatureFormatError("signature must be an even-length hex string");
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Normalise a wallet signature into the 65-byte tagged form:
 *   - 64 bytes: a raw signature, the key's algorithm tag is prepended;
 *   - 65 bytes: already tagged, kept as-is (the tag must match the key);
 *   - any other length is rejected.
 */
export function toApprovalSignature(signatureHex: string, algorithmTag: number): Uint8Array {
  const sig = hexToBytesStrict(signatureHex);
  if (sig.length === 64) {
    const tagged = new Uint8Array(65);
    tagged[0] = algorithmTag;
    tagged.set(sig, 1);
    return tagged;
  }
  if (sig.length === 65) {
    if (sig[0] !== algorithmTag) {
      throw new SignatureFormatError(
        `signature algorithm tag ${sig[0]} does not match the signing key (expected ${algorithmTag})`,
      );
    }
    return sig;
  }
  throw new SignatureFormatError(`unexpected signature length ${sig.length} bytes (expected 64 raw or 65 tagged)`);
}
