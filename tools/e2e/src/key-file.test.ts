import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import casperSdk from "casper-js-sdk";
import { accountHashOfKeyFile, loadSecretKeyFile } from "./key-file.js";

const { PrivateKey, KeyAlgorithm } = casperSdk;

describe("secret key files", () => {
  const dir = mkdtempSync(join(tmpdir(), "cascet-keyfile-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("loads a PEM and yields its account hash; the role label names the file in errors", () => {
    const key = PrivateKey.generate(KeyAlgorithm.ED25519);
    const path = join(dir, "recorder_secret_key.pem");
    writeFileSync(path, key.toPem(), { mode: 0o600 });
    const warnings: string[] = [];
    assert.equal(accountHashOfKeyFile(path, "ed25519", "recorder", m => warnings.push(m)), key.publicKey.accountHash().toHex());
    assert.deepEqual(warnings, []);

    assert.throws(() => loadSecretKeyFile(join(dir, "missing.pem"), "ed25519", "recorder"), /recorder key file .*ENOENT/);
    const garbage = join(dir, "garbage.pem");
    writeFileSync(garbage, "not a key", { mode: 0o600 });
    assert.throws(() => loadSecretKeyFile(garbage, "ed25519", "fee-payer"), /fee-payer key file .* not a valid ed25519 PEM/);
  });

  test("warns when the key file is readable by group or others", () => {
    const path = join(dir, "open_secret_key.pem");
    writeFileSync(path, PrivateKey.generate(KeyAlgorithm.ED25519).toPem());
    chmodSync(path, 0o644);
    const warnings: string[] = [];
    loadSecretKeyFile(path, "ed25519", "fee-payer", m => warnings.push(m));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /chmod 600/);
  });
});
