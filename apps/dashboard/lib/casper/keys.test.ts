import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountHashOf,
  checkGatewayUrl,
  isLoopbackHostname,
  parseAssetInput,
  parsePayeeInput,
  payToValue,
  resolvePayTo,
} from "./keys";
import {
  accountHashFromPublicKey,
  conversionError,
  createAccountHashConverter,
  KeyConverterUnavailableError,
} from "./account-hash";

const H = "fcf6bc94cef41aab24599669d62e919f0c65382a1bb734ae5e57706b997093ca";
// Real testnet payee from lib/casper/constants.ts: this ed25519 key hashes to H.
const ED_KEY = "01dd710d5083920b20c706a92d742c7bf9162d09c96fa373bd0a67b0bf51d3f183";
const SECP_KEY = "0203865a0caf734d1620e8b938c0f086f2ab4c459e461bb0f9254d10d8ca5a05c172";
const SECP_HASH = "a88a12ab6f3f7942ec3f9ddcc4c5fcc552a535604942f46cf712ddcdb40f903f";

test("account hashes are accepted with the 00 or account-hash- prefix, any case", () => {
  assert.deepEqual(parsePayeeInput(`00${H}`), { kind: "account", hash: H });
  assert.deepEqual(parsePayeeInput(`  account-hash-${H.toUpperCase()} `), { kind: "account", hash: H });
});

test("contract package payees need an explicit hash- / package-hash- prefix", () => {
  assert.deepEqual(parsePayeeInput(`hash-${H}`), { kind: "package", hash: H });
  assert.deepEqual(parsePayeeInput(`package-hash-${H}`), { kind: "package", hash: H });
});

test("public keys are recognised as keys to convert, never used as a payTo (M01)", () => {
  assert.deepEqual(parsePayeeInput(ED_KEY), { kind: "public-key", publicKey: ED_KEY, algorithm: "ed25519" });
  assert.deepEqual(parsePayeeInput(SECP_KEY), { kind: "public-key", publicKey: SECP_KEY, algorithm: "secp256k1" });
});

test("bare 64-hex, wrong lengths and junk are rejected with a reason", () => {
  for (const bad of [H, `00${H}ff`, `01${H.slice(2)}`, "hello", `03${H}`]) {
    const r = parsePayeeInput(bad);
    assert.equal(r.kind, "invalid", bad);
  }
  assert.deepEqual(parsePayeeInput("   "), { kind: "empty" });
});

test("payees are written as 00… or hash-…, never as a raw 01… that reads as a public key", () => {
  // The config schema normalises with core's normalizePayTo, which stores hash-… as the 01 Key and rejects a
  // raw 01… (M01). Only the account form can be paid today: /build blocks hash-… and /connect refuses it.
  assert.equal(payToValue({ kind: "account", hash: H }), `00${H}`);
  assert.equal(payToValue({ kind: "package", hash: H }), `hash-${H}`);
  // What payToValue writes parses back to the same payee (the /build → /connect hand-over).
  for (const target of [{ kind: "account", hash: H }, { kind: "package", hash: H }] as const) {
    assert.deepEqual(parsePayeeInput(payToValue(target)), target);
  }
});

test("/build writes a payTo only from an account hash, never from the raw input (M01)", () => {
  assert.deepEqual(resolvePayTo(parsePayeeInput(`account-hash-${H}`)), { payTo: `00${H}`, issue: null });
  const key = parsePayeeInput(ED_KEY);
  // Converted: the account hash, never the key.
  assert.deepEqual(resolvePayTo(key, { hash: H }), { payTo: `00${H}`, issue: null });
  // Pending, failed to load, or invalid: no payTo at all, so the raw 01… can never reach the config.
  assert.deepEqual(resolvePayTo(key), { payTo: null, issue: "converting the public key…" });
  assert.deepEqual(resolvePayTo(key, { pending: true }), { payTo: null, issue: "converting the public key…" });
  const offline = { error: "could not load the key converter: check your connection and retry", retryable: true };
  assert.deepEqual(resolvePayTo(key, offline), { payTo: null, issue: offline.error });
  assert.equal(resolvePayTo(key, { error: "not a valid Casper public key", retryable: false }).payTo, null);
  // A contract package cannot be paid by x402 today.
  const pkg = resolvePayTo(parsePayeeInput(`hash-${H}`));
  assert.equal(pkg.payTo, null);
  assert.match(pkg.issue ?? "", /account hash/);
  assert.equal(resolvePayTo(parsePayeeInput(H)).payTo, null, "an ambiguous bare 64-hex value");
  assert.equal(resolvePayTo(parsePayeeInput("")).payTo, null);
});

test("asset package hashes normalise to bare lower-case hex", () => {
  assert.deepEqual(parseAssetInput(`hash-${H.toUpperCase()}`), { ok: true, hash: H });
  assert.deepEqual(parseAssetInput(`contract-package-${H}`), { ok: true, hash: H });
  assert.deepEqual(parseAssetInput(H), { ok: true, hash: H });
  assert.equal(parseAssetInput(`00${H}`).ok, false);
  const empty = parseAssetInput("");
  assert.equal(empty.ok, false);
  assert.equal(!empty.ok && empty.empty, true);
});

test("receipt payers in account-hash form normalise; public keys need conversion", () => {
  assert.equal(accountHashOf(`00${H}`), H);
  assert.equal(accountHashOf(`account-hash-${H}`), H);
  assert.equal(accountHashOf(ED_KEY), null);
});

test("public key → account hash with casper-js-sdk matches the known testnet payees", async () => {
  assert.equal(await accountHashFromPublicKey(ED_KEY), H);
  assert.equal(await accountHashFromPublicKey(SECP_KEY.toUpperCase()), SECP_HASH);
  await assert.rejects(accountHashFromPublicKey(`01${H.slice(2)}`));
});

test("a converter that fails to load is retryable and not cached; an invalid key is a final error", async () => {
  let loads = 0;
  const convert = createAccountHashConverter(async () => {
    loads += 1;
    if (loads === 1) throw new Error("ChunkLoadError: loading chunk failed");
    return import("casper-js-sdk");
  });
  // First load fails (offline, blocked chunk): reported as unavailable, which the UI offers to retry.
  const offline = await convert(ED_KEY).catch((e: unknown) => e);
  assert.ok(offline instanceof KeyConverterUnavailableError);
  assert.deepEqual(conversionError(offline), {
    error: "could not load the key converter: check your connection and retry",
    retryable: true,
  });
  // The rejected load was not cached: the next conversion loads the SDK again and works.
  assert.equal(await convert(ED_KEY), H);
  assert.equal(await convert(SECP_KEY), SECP_HASH);
  assert.equal(loads, 2, "a good load is cached");
  // A bad key is not a load failure: final, not retryable.
  const bad = await convert(`01${H.slice(2)}`).catch((e: unknown) => e);
  assert.ok(bad instanceof Error && !(bad instanceof KeyConverterUnavailableError));
  assert.deepEqual(conversionError(bad), { error: "not a valid Casper public key", retryable: false });
  // A module without PublicKey is treated as a failed load.
  const broken = createAccountHashConverter(async () => ({}));
  await assert.rejects(broken(ED_KEY), KeyConverterUnavailableError);
});

test("gateway URLs: https anywhere, http only on loopback, no credentials", () => {
  assert.deepEqual(checkGatewayUrl("https://gw.example.com/mcp"), { ok: true, url: "https://gw.example.com/mcp", local: false });
  assert.equal(checkGatewayUrl("http://localhost:4402/mcp").ok, true);
  assert.equal(checkGatewayUrl("http://127.0.0.1:4402/mcp").ok, true);
  assert.equal(checkGatewayUrl("http://[::1]:4402/mcp").ok, true, "URL.hostname is bracketed for IPv6 (L06)");
  assert.equal(checkGatewayUrl("http://gw.example.com/mcp").ok, false);
  assert.equal(checkGatewayUrl("http://192.168.1.10:4402/mcp").ok, false);
  assert.equal(checkGatewayUrl("https://user:pw@gw.example.com/mcp").ok, false);
  assert.equal(checkGatewayUrl("ftp://gw.example.com").ok, false);
  assert.equal(checkGatewayUrl("not a url").ok, false);
  assert.equal(checkGatewayUrl("").ok, false);
  // Exactly the hosts cascet connect accepts over http, so a URL accepted here never fails at its startup.
  assert.equal(isLoopbackHostname("app.localhost"), false);
  assert.equal(isLoopbackHostname("localhost.example.com"), false);
  assert.equal(isLoopbackHostname("127.0.0.53"), true);
});
