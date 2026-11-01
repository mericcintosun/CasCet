import crypto from "node:crypto";

/**
 * Shared-secret authentication between a gateway and the facilitator.
 *
 * The gateway sends its `facilitator.apiKey` verbatim as the `Authorization`
 * header, so both `Authorization: <token>` and `Authorization: Bearer <token>`
 * are accepted. Comparison is constant-time: both sides are hashed to equal
 * length (SHA-256) and compared with `crypto.timingSafeEqual`, so neither the
 * token's content nor its length leaks through response timing.
 */

/** Minimum token length enforced on mainnet (e.g. `openssl rand -hex 32` gives 64). */
export const MIN_MAINNET_TOKEN_LENGTH = 32;

const digest = (s: string): Buffer => crypto.createHash("sha256").update(s, "utf8").digest();

/** Constant-time check of an `Authorization` header value against the expected token. */
export function authorizationMatches(header: string | undefined, expected: string): boolean {
  if (expected.length === 0) throw new Error("facilitator token must not be empty");
  const raw = header ?? "";
  const bearer = /^bearer\s+/i.test(raw) ? raw.replace(/^bearer\s+/i, "") : "";
  const want = digest(expected);
  // Evaluate both forms unconditionally (no short-circuit on the secret).
  const rawOk = crypto.timingSafeEqual(digest(raw), want);
  const bearerOk = crypto.timingSafeEqual(digest(bearer), want);
  return raw.length > 0 && (rawOk || bearerOk);
}

/** Throws when a token is too weak for the given network. */
export function assertUsableToken(token: string | undefined, opts: { required: boolean; minLength: number; label: string }): void {
  if (token === undefined || token === "") {
    if (opts.required) throw new Error(`${opts.label} is required (generate one with: openssl rand -hex 32)`);
    return;
  }
  if (/\s/.test(token)) throw new Error(`${opts.label} must not contain whitespace`);
  if (token.length < opts.minLength) {
    throw new Error(`${opts.label} must be at least ${opts.minLength} characters (generate one with: openssl rand -hex 32)`);
  }
}
