/**
 * Public key → account hash, with casper-js-sdk loaded on first use so the SDK
 * (about 0.8 MB in the browser build) is not part of any page's first load.
 */

type SdkModule = typeof import("casper-js-sdk");

/**
 * casper-js-sdk could not be loaded (offline, a blocked or failed chunk). Unlike
 * an invalid key, a retry can fix this, so the UI offers one.
 */
export class KeyConverterUnavailableError extends Error {
  override name = "KeyConverterUnavailableError";
}

/** A conversion failure as the UI reports it. */
export function conversionError(e: unknown): { error: string; retryable: boolean } {
  return e instanceof KeyConverterUnavailableError
    ? { error: "could not load the key converter: check your connection and retry", retryable: true }
    : { error: "not a valid Casper public key", retryable: false };
}

/**
 * A converter over an injectable SDK loader (tests inject a failing one). A
 * failed load is not cached: the next conversion loads the SDK again.
 */
export function createAccountHashConverter(importSdk: () => Promise<unknown>): (publicKeyHex: string) => Promise<string> {
  let sdkPromise: Promise<SdkModule> | null = null;

  const loadSdk = (): Promise<SdkModule> => {
    sdkPromise ??= importSdk()
      .then((mod) => {
        // CommonJS interop: bundlers expose the exports directly, Node puts them on `default`.
        const ns = mod as Partial<SdkModule> & { default?: Partial<SdkModule> };
        const sdk = ns.PublicKey ? ns : ns.default;
        if (!sdk?.PublicKey) throw new Error("casper-js-sdk has no PublicKey export");
        return sdk as SdkModule;
      })
      .catch((e: unknown) => {
        sdkPromise = null;
        throw new KeyConverterUnavailableError(`could not load casper-js-sdk: ${e instanceof Error ? e.message : String(e)}`);
      });
    return sdkPromise;
  };

  return async (publicKeyHex) => {
    const { PublicKey } = await loadSdk();
    return PublicKey.fromHex(publicKeyHex.trim().toLowerCase()).accountHash().toHex().toLowerCase();
  };
}

/**
 * Convert a Casper public key ("01" + 64 hex for ed25519, "02" + 66 hex for
 * secp256k1) to its 32-byte account hash as bare lower-case hex. Throws
 * KeyConverterUnavailableError when the SDK cannot load, and another error for
 * an invalid key.
 */
export const accountHashFromPublicKey = createAccountHashConverter(() => import("casper-js-sdk"));
