import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyAlgorithm, PrivateKey } from "casper-js-sdk";
import { hexToBytesStrict, SignatureFormatError, toApprovalSignature } from "./signature";
import { attachWalletSignature, buildUnsignedReleaseTx, RelayRejectedError } from "./release-core";

const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

const PACKAGE = "fa21efb406a8151d15a393bc366e51192a9ea15fd7fe23faffc54f021b32883c";
const PAYEE = `account-hash-${"ab".repeat(32)}`;
const POLICY = { packageHash: PACKAGE, chainName: "casper-test", allowedPayees: [PAYEE] };
const PARAMS = { packageHash: PACKAGE, chainName: "casper-test", paymentMotes: 5_000_000_000 };

/** What the /withdraw page round-trips through the browser: the prepared tx as plain JSON. */
function prepare(key: PrivateKey, payee = PAYEE, params = PARAMS) {
  const tx = buildUnsignedReleaseTx(payee, key.publicKey.toHex(), params);
  const hash = tx.getTransactionV1()!.hash.toBytes();
  return { txJson: JSON.parse(JSON.stringify(tx.toJSON())) as unknown, hash };
}

// ── toApprovalSignature ─────────────────────────────────────────────────────

test("a raw 64-byte signature gets the key's algorithm tag prepended", () => {
  const raw = "11".repeat(64);
  const ed = toApprovalSignature(raw, 1);
  assert.equal(ed.length, 65);
  assert.equal(ed[0], 1);
  assert.equal(toHex(ed.slice(1)), raw);
  assert.equal(toApprovalSignature(raw, 2)[0], 2);
});

test("a tagged 65-byte signature is kept as-is (the old code stripped its tag)", () => {
  const tagged = `01${"22".repeat(64)}`;
  assert.equal(toHex(toApprovalSignature(tagged, 1)), tagged);
});

test("a 0x prefix and upper-case hex are tolerated", () => {
  const sig = toApprovalSignature(`0x${"AB".repeat(64)}`, 1);
  assert.equal(sig.length, 65);
  assert.equal(sig[1], 0xab);
});

test("a tagged signature whose tag does not match the key is rejected", () => {
  assert.throws(() => toApprovalSignature(`02${"22".repeat(64)}`, 1), SignatureFormatError);
});

test("any other length, odd-length or non-hex input is rejected", () => {
  for (const bad of ["", "1", "abc", "zz".repeat(64), "11".repeat(63), "11".repeat(66), "11".repeat(32)]) {
    assert.throws(() => toApprovalSignature(bad, 1), SignatureFormatError, `should reject ${bad.length} chars`);
  }
  assert.throws(() => hexToBytesStrict("0x"), SignatureFormatError);
});

// ── attachWalletSignature (offline, real casper-js-sdk) ─────────────────────

for (const [name, alg, tag] of [
  ["ed25519", KeyAlgorithm.ED25519, 1],
  ["secp256k1", KeyAlgorithm.SECP256K1, 2],
] as const) {
  test(`${name}: a raw wallet signature becomes a valid tagged approval`, () => {
    const key = PrivateKey.generate(alg);
    const { txJson, hash } = prepare(key);
    const raw = key.sign(hash);
    assert.equal(raw.length, 64, "wallets return the raw signature");

    const tx = attachWalletSignature(txJson, toHex(raw), key.publicKey.toHex(), POLICY);
    assert.equal(tx.approvals.length, 1);
    const stored = tx.approvals[0]!.signature.bytes;
    assert.equal(stored.length, 65);
    assert.equal(stored[0], tag);
    assert.equal(tx.validate(), true);
  });
}

test("an already tagged signature (sdk signAndAddAlgorithmBytes) is accepted unchanged", () => {
  const key = PrivateKey.generate(KeyAlgorithm.ED25519);
  const { txJson, hash } = prepare(key);
  const tagged = key.signAndAddAlgorithmBytes(hash);
  const tx = attachWalletSignature(txJson, toHex(tagged), key.publicKey.toHex(), POLICY);
  assert.equal(toHex(tx.approvals[0]!.signature.bytes), toHex(tagged));
});

test("a signature from another key, or over another message, does not verify", () => {
  const key = PrivateKey.generate(KeyAlgorithm.ED25519);
  const other = PrivateKey.generate(KeyAlgorithm.ED25519);
  const { txJson, hash } = prepare(key);
  assert.throws(
    () => attachWalletSignature(txJson, toHex(other.sign(hash)), key.publicKey.toHex(), POLICY),
    (e: unknown) => e instanceof RelayRejectedError && /does not verify/.test(e.message),
  );
  const wrongMessage = key.sign(new Uint8Array(32).fill(7));
  assert.throws(
    () => attachWalletSignature(txJson, toHex(wrongMessage), key.publicKey.toHex(), POLICY),
    RelayRejectedError,
  );
});

test("a malformed signature is a client error, not a crash", () => {
  const key = PrivateKey.generate(KeyAlgorithm.ED25519);
  const { txJson } = prepare(key);
  assert.throws(() => attachWalletSignature(txJson, "nothex", key.publicKey.toHex(), POLICY), RelayRejectedError);
  assert.throws(() => attachWalletSignature(txJson, "11".repeat(70), key.publicKey.toHex(), POLICY), RelayRejectedError);
});

test("only the prepared RevenueSplit release is relayed", () => {
  const key = PrivateKey.generate(KeyAlgorithm.ED25519);
  const pub = key.publicKey.toHex();

  const foreign = prepare(key, PAYEE, { ...PARAMS, packageHash: "cd".repeat(32) });
  assert.throws(
    () => attachWalletSignature(foreign.txJson, toHex(key.sign(foreign.hash)), pub, POLICY),
    /does not target the RevenueSplit/,
  );

  const otherChain = prepare(key, PAYEE, { ...PARAMS, chainName: "casper" });
  assert.throws(
    () => attachWalletSignature(otherChain.txJson, toHex(key.sign(otherChain.hash)), pub, POLICY),
    /chain "casper"/,
  );

  const strangerPayee = prepare(key, `account-hash-${"ef".repeat(32)}`);
  assert.throws(
    () => attachWalletSignature(strangerPayee.txJson, toHex(key.sign(strangerPayee.hash)), pub, POLICY),
    /unknown payee/,
  );

  const ok = prepare(key);
  const someoneElse = PrivateKey.generate(KeyAlgorithm.ED25519);
  assert.throws(
    () => attachWalletSignature(ok.txJson, toHex(someoneElse.sign(ok.hash)), someoneElse.publicKey.toHex(), POLICY),
    /initiator is not the signing key/,
  );

  assert.throws(() => attachWalletSignature({ nope: true }, "11".repeat(64), pub, POLICY), /malformed transaction/);
  assert.throws(() => attachWalletSignature(ok.txJson, "11".repeat(64), "01abcd", POLICY), /invalid public key/);
});

test("a transaction that already carries approvals is refused", () => {
  const key = PrivateKey.generate(KeyAlgorithm.ED25519);
  const tx = buildUnsignedReleaseTx(PAYEE, key.publicKey.toHex(), PARAMS);
  tx.sign(key);
  const hash = tx.getTransactionV1()!.hash.toBytes();
  assert.throws(
    () => attachWalletSignature(JSON.parse(JSON.stringify(tx.toJSON())), toHex(key.sign(hash)), key.publicKey.toHex(), POLICY),
    /already carries approvals/,
  );
});
