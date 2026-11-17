import { createHash } from "node:crypto";

/**
 * ed25519 verification as the chain runs it. The tokens check a payment's
 * signature with casper-types 6.1 `crypto::verify` (Wrapped CSPR through
 * Odra's `verify_signature` host call; CasCet's legacy-amount token has the
 * same function compiled into its wasm), which calls ed25519-dalek 2.x
 * `VerifyingKey::verify_strict`:
 *  - s must be below the group order L;
 *  - R and the public key A must decode to curve points (any y below 2^255 is
 *    reduced mod p, and the sign bit of x = 0 is ignored, as curve25519-dalek
 *    decompresses);
 *  - neither R nor A may have small order ([8]P is the identity);
 *  - with k = SHA-512(R ‖ A ‖ message) mod L over the bytes as given, the
 *    encoding of [s]B − [k]A must be R's bytes exactly (cofactorless).
 *
 * casper-js-sdk verifies with @noble/ed25519 1.7, which accepts any signature
 * with [8](R + [k]A − [s]B) = 0: a mixed-order R (rB plus a torsion point), a
 * small-order R, or a small-order ("weak") public key passes there and is
 * refused on-chain, where the settle reverts and burns the fee payer's whole
 * gas limit. Checked against ed25519-dalek 2.2.0 / casper-types 6.1.0
 * (ed25519-strict.test.ts).
 *
 * Variable-time BigInt arithmetic: it only ever sees public values.
 */

const P = 2n ** 255n - 19n;
/** Order of the base point's subgroup. */
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

const mod = (a: bigint, m = P): bigint => {
  const r = a % m;
  return r >= 0n ? r : r + m;
};

function pow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  for (let e = exponent; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
  }
  return result;
}

const invert = (a: bigint): bigint => pow(a, P - 2n);

/** Curve constant d = −121665/121666. */
const D = mod(-121665n * invert(121666n));
const D2 = mod(2n * D);
/** A square root of −1 mod p. */
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

/** Extended coordinates: x = X/Z, y = Y/Z, xy = T/Z. */
interface Point {
  X: bigint;
  Y: bigint;
  Z: bigint;
  T: bigint;
}

const IDENTITY: Point = { X: 0n, Y: 1n, Z: 1n, T: 0n };

/** RFC 8032 §5.1.4 addition (a = −1); complete, so it also doubles and adds the identity. */
function add(p: Point, q: Point): Point {
  const a = mod((p.Y - p.X) * (q.Y - q.X));
  const b = mod((p.Y + p.X) * (q.Y + q.X));
  const c = mod(mod(p.T * D2) * q.T);
  const d = mod(2n * p.Z * q.Z);
  const e = b - a;
  const f = d - c;
  const g = d + c;
  const h = b + a;
  return { X: mod(e * f), Y: mod(g * h), Z: mod(f * g), T: mod(e * h) };
}

/** RFC 8032 §5.1.4 doubling (a = −1). */
function double(p: Point): Point {
  const a = mod(p.X * p.X);
  const b = mod(p.Y * p.Y);
  const c = mod(2n * p.Z * p.Z);
  const h = a + b;
  const e = h - mod((p.X + p.Y) * (p.X + p.Y));
  const g = a - b;
  const f = c + g;
  return { X: mod(e * f), Y: mod(g * h), Z: mod(f * g), T: mod(e * h) };
}

const negate = (p: Point): Point => ({ X: mod(-p.X), Y: p.Y, Z: p.Z, T: mod(-p.T) });

function multiply(p: Point, scalar: bigint): Point {
  let result = IDENTITY;
  let addend = p;
  for (let n = scalar; n > 0n; n >>= 1n) {
    if (n & 1n) result = add(result, addend);
    addend = double(addend);
  }
  return result;
}

const isIdentity = (p: Point): boolean => mod(p.X) === 0n && mod(p.Y - p.Z) === 0n;
const hasSmallOrder = (p: Point): boolean => isIdentity(double(double(double(p))));

function littleEndian(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}

/** The canonical 32-byte encoding: y (reduced) little-endian, x's low bit in the top bit. */
function encode(p: Point): Uint8Array {
  const zInv = invert(p.Z);
  const x = mod(p.X * zInv);
  let y = mod(p.Y * zInv);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++, y >>= 8n) out[i] = Number(y & 0xffn);
  out[31] = out[31]! | (Number(x & 1n) << 7);
  return out;
}

/** √(u/v), the even ("nonnegative") root as curve25519-dalek's sqrt_ratio_i returns it; undefined when u/v is not a square. */
function sqrtRatio(u: bigint, v: bigint): bigint | undefined {
  const w = mod(u * invert(v));
  let x = pow(w, (P + 3n) / 8n);
  if (mod(x * x - w) !== 0n) {
    x = mod(x * SQRT_M1);
    if (mod(x * x - w) !== 0n) return undefined;
  }
  return x & 1n ? P - x : x;
}

/**
 * curve25519-dalek's `CompressedEdwardsY::decompress`: the low 255 bits are y
 * (reduced mod p, so a non-canonical y is accepted), the top bit picks x's sign
 * (negating x = 0 leaves it 0); refused only when no x exists.
 */
function decode(bytes: Uint8Array): Point | undefined {
  const yBytes = Uint8Array.from(bytes);
  yBytes[31] = bytes[31]! & 0x7f;
  const y = mod(littleEndian(yBytes));
  const yy = mod(y * y);
  let x = sqrtRatio(mod(yy - 1n), mod(D * yy + 1n));
  if (x === undefined) return undefined;
  if (bytes[31]! & 0x80) x = mod(-x);
  return { X: x, Y: y, Z: 1n, T: mod(x * y) };
}

/** The base point B: y = 4/5, x even. */
const BASE = decode(Uint8Array.from([0x58, ...new Array<number>(31).fill(0x66)]))!;

/**
 * Why the chain's ed25519 check (ed25519-dalek `verify_strict`) refuses this
 * signature, or undefined when it accepts it. `publicKey` is the 32-byte key
 * and `signature` the 64-byte R ‖ s, both without Casper's algorithm tag.
 */
export function ed25519StrictProblem(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): string | undefined {
  if (publicKey.length !== 32) return "the public key is not 32 bytes";
  if (signature.length !== 64) return "the signature is not 64 bytes";
  const rBytes = signature.subarray(0, 32);
  const s = littleEndian(signature.subarray(32, 64));
  if (s >= L) return "s is not below the group order";
  const a = decode(publicKey);
  if (!a) return "the public key is not a curve point";
  const r = decode(rBytes);
  if (!r) return "R is not a curve point";
  if (hasSmallOrder(r)) return "R has small order";
  if (hasSmallOrder(a)) return "the public key has small order";
  const digest = createHash("sha512").update(rBytes).update(publicKey).update(message).digest();
  const k = mod(littleEndian(digest), L);
  const expected = encode(add(multiply(BASE, s), multiply(negate(a), k)));
  if (!expected.every((byte, i) => byte === rBytes[i])) return "[s]B − [k]A is not R";
  return undefined;
}

/** True when the chain's ed25519 check accepts the signature (see {@link ed25519StrictProblem}). */
export function verifyEd25519Strict(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  return ed25519StrictProblem(publicKey, message, signature) === undefined;
}
