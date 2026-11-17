import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import casperSdk from "casper-js-sdk";
import { wcsprDepositResult } from "./gas-fixtures.js";
import {
  buildProxySession,
  EMPTY_RUNTIME_ARGS,
  loadOdraProxyWasm,
  locateOdraProxyWasm,
  ODRA_PROXY_WASM,
  odraProxyWasmCandidates,
  proxyCallArgs,
  verifyOdraProxyWasm,
} from "./odra-proxy.js";

const { Args, CLValue, PrivateKey, KeyAlgorithm, TransactionWrapper } = casperSdk;

const recorded = wcsprDepositResult.transaction.Version1;
const recordedArgs = recorded.payload.fields.args.Named;
const WCSPR = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";

type ArgJson = { cl_type: unknown; bytes: string };
type TxJson = {
  Version1: {
    hash: string;
    payload: {
      chain_name: string;
      initiator_addr: { PublicKey: string };
      pricing_mode: { PaymentLimited: { payment_amount: number; gas_price_tolerance: number; standard_payment: boolean } };
      fields: {
        args: { Named: Array<[string, ArgJson]> };
        entry_point: unknown;
        scheduling: unknown;
        target: { Session: { is_install_upgrade: boolean; runtime: string; module_bytes: string } };
      };
    };
  };
};

const argsJson = (args: InstanceType<typeof Args>): Array<[string, ArgJson]> =>
  [...args.args.entries()].map(([name, value]) => [name, { cl_type: JSON.parse(JSON.stringify(value.type.toJSON())), bytes: Buffer.from(value.bytes()).toString("hex") }]);

describe("Odra proxy session (payable calls from an account)", () => {
  test("builds the args of recorded testnet WCSPR deposit 77fb850a… byte for byte", () => {
    const args = proxyCallArgs({ packageHash: WCSPR, entryPoint: "deposit", attachedMotes: 1_000_000_000n });
    const built = argsJson(args);
    assert.deepEqual(
      built.map(([name]) => name),
      recordedArgs.map(([name]) => name),
      "same names in the same order",
    );
    for (const [i, [name, value]] of recordedArgs.entries()) {
      assert.equal(built[i]![1].bytes, value.bytes, `${name} bytes`);
      assert.deepEqual(built[i]![1].cl_type, value.cl_type, `${name} type`);
    }
    assert.equal(Buffer.from(EMPTY_RUNTIME_ARGS).toString("hex"), Buffer.from(Args.fromMap({}).toBytes()).toString("hex"));
  });

  test("passes serialized inner args through and keeps amount = attached_value (the session's spending limit)", () => {
    const inner = Args.fromMap({ recipient: CLValue.newCLString("x") }).toBytes();
    const args = proxyCallArgs({ packageHash: WCSPR.toUpperCase(), entryPoint: "pay_to", innerArgs: inner, attachedMotes: 42n });
    const list = args.getByName("args")!;
    assert.equal(Buffer.from(list.bytes()).toString("hex"), Buffer.concat([Buffer.from([inner.length, 0, 0, 0]), Buffer.from(inner)]).toString("hex"));
    assert.equal(args.getByName("attached_value")!.toString(), "42");
    assert.equal(args.getByName("amount")!.toString(), "42");
  });

  test("refuses malformed calls", () => {
    assert.throws(() => proxyCallArgs({ packageHash: "abc", entryPoint: "deposit", attachedMotes: 1n }), /64 hex/);
    assert.throws(() => proxyCallArgs({ packageHash: `hash-${WCSPR}`, entryPoint: "deposit", attachedMotes: 1n }), /64 hex/);
    assert.throws(() => proxyCallArgs({ packageHash: WCSPR, entryPoint: "de posit", attachedMotes: 1n }), /entry point/);
    assert.throws(() => proxyCallArgs({ packageHash: WCSPR, entryPoint: "deposit", attachedMotes: -1n }), /negative/);
  });

  test("builds an install/upgrade VmCasperV1 session with standard payment, like Odra's livenet client", () => {
    const key = PrivateKey.generate(KeyAlgorithm.ED25519); // throwaway, in memory only
    const wasm = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);
    const tx = buildProxySession(wasm, { packageHash: WCSPR, entryPoint: "deposit", attachedMotes: 1_000_000_000n }, {
      initiatorPublicKey: key.publicKey.toHex(),
      chainName: "casper-test",
      paymentMotes: 5_000_000_000n,
      ttlMs: 30 * 60_000,
      timestamp: new Date("2026-11-02T00:00:00.000Z"),
    });
    const json = TransactionWrapper.toJSON(tx.getTransactionWrapper()) as TxJson;
    const payload = json.Version1.payload;
    assert.equal(payload.chain_name, "casper-test");
    assert.equal(payload.initiator_addr.PublicKey, key.publicKey.toHex());
    assert.deepEqual(payload.pricing_mode, recorded.payload.pricing_mode);
    assert.deepEqual(payload.fields.entry_point, recorded.payload.fields.entry_point);
    assert.deepEqual(payload.fields.scheduling, recorded.payload.fields.scheduling);
    assert.equal(payload.fields.target.Session.is_install_upgrade, true);
    assert.equal(payload.fields.target.Session.runtime, "VmCasperV1");
    assert.equal(payload.fields.target.Session.module_bytes, "0061736d01000000");
    assert.deepEqual(payload.fields.args.Named.map(([name, v]) => [name, v.bytes]), recordedArgs.map(([name, v]) => [name, v.bytes]));
    assert.equal(tx.approvals.length, 0, "built unsigned");
    assert.throws(() => buildProxySession(wasm, { packageHash: WCSPR, entryPoint: "deposit", attachedMotes: 1n }, { initiatorPublicKey: key.publicKey.toHex(), chainName: "casper-test", paymentMotes: 0n }), /positive/);
  });

  test("accepts only the pinned proxy wasm (size and SHA-256)", () => {
    const wrongSize = new Uint8Array(10);
    assert.throws(() => verifyOdraProxyWasm(wrongSize), /refusing the proxy wasm: 10 bytes/);
    const rightSizeWrongBytes = new Uint8Array(ODRA_PROXY_WASM.bytes);
    assert.throws(() => verifyOdraProxyWasm(rightSizeWrongBytes), new RegExp(`expected ${ODRA_PROXY_WASM.bytes} bytes`));
    assert.throws(() => loadOdraProxyWasm("/nowhere/proxy.wasm", () => rightSizeWrongBytes), /refusing the proxy wasm/);
  });

  test("finds the wasm in a cargo registry, or says how to fetch it", () => {
    const cargo = "/home/dev/.cargo";
    const index = "index.crates.io-1949cf8c6b5b557f";
    const wanted = join(cargo, "registry", "src", index, ODRA_PROXY_WASM.crate, ODRA_PROXY_WASM.file);
    assert.deepEqual(odraProxyWasmCandidates(cargo, () => [index, "github.com-1ecc6299db9ec823"]), [
      join(cargo, "registry", "src", "github.com-1ecc6299db9ec823", ODRA_PROXY_WASM.crate, ODRA_PROXY_WASM.file),
      wanted,
    ], "every registry index, in a stable (sorted) order");
    assert.deepEqual(odraProxyWasmCandidates(cargo, () => {
      throw new Error("ENOENT");
    }), []);
    assert.equal(locateOdraProxyWasm({ cargoHome: cargo, listDir: () => [index], exists: p => p === wanted }), wanted);
    assert.throws(() => locateOdraProxyWasm({ cargoHome: cargo, listDir: () => [index], exists: () => false }), /cargo fetch/);
    assert.equal(locateOdraProxyWasm({ explicitPath: "/opt/proxy.wasm", exists: p => p === "/opt/proxy.wasm" }), "/opt/proxy.wasm");
    assert.throws(() => locateOdraProxyWasm({ explicitPath: "/opt/missing.wasm", exists: () => false }), /not found/);
  });

  const local = (() => {
    try {
      return locateOdraProxyWasm();
    } catch {
      return undefined;
    }
  })();
  test("the pin matches the proxy wasm in this machine's cargo registry", { skip: local === undefined || !existsSync(local) }, () => {
    const bytes = loadOdraProxyWasm(local!);
    assert.equal(bytes.length, ODRA_PROXY_WASM.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), ODRA_PROXY_WASM.sha256);
  });
});
