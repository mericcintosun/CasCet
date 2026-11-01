import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountHashOf,
  checkGatewayUrl,
  isLoopbackHostname,
  parseAssetInput,
  parsePayeeInput,
  payToAllowlistValue,
  payToConfigValue,
} from "./keys";
import { accountHashFromPublicKey } from "./account-hash";

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

test("config payTo and buyer allowlist forms", () => {
  assert.equal(payToConfigValue({ kind: "account", hash: H }), `00${H}`);
  assert.equal(payToConfigValue({ kind: "package", hash: H }), `hash-${H}`);
  assert.equal(payToAllowlistValue({ kind: "account", hash: H }), `00${H}`);
  assert.equal(payToAllowlistValue({ kind: "package", hash: H }), `01${H}`);
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
  assert.equal(isLoopbackHostname("app.localhost"), true);
  assert.equal(isLoopbackHostname("localhost.example.com"), false);
});
