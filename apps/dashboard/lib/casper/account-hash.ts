/**
 * Public key → account hash, with casper-js-sdk loaded on first use so the SDK
 * (about 0.8 MB in the browser build) is not part of any page's first load.
 */

type SdkModule = typeof import("casper-js-sdk");

let sdkPromise: Promise<SdkModule> | null = null;

function loadSdk(): Promise<SdkModule> {
  sdkPromise ??= import("casper-js-sdk").then((mod) => {
    // CommonJS interop: bundlers expose the exports directly, Node puts them on `default`.
    const ns = mod as SdkModule & { default?: SdkModule };
    return ns.PublicKey ? ns : (ns.default as SdkModule);
  });
  return sdkPromise;
}

/**
 * Convert a Casper public key ("01" + 64 hex for ed25519, "02" + 66 hex for
 * secp256k1) to its 32-byte account hash as bare lower-case hex. Throws for an
 * invalid key.
 */
export async function accountHashFromPublicKey(publicKeyHex: string): Promise<string> {
  const { PublicKey } = await loadSdk();
  return PublicKey.fromHex(publicKeyHex.trim().toLowerCase()).accountHash().toHex().toLowerCase();
}
