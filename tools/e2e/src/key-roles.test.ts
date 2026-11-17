import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import casperSdk from "casper-js-sdk";
import { generateRoleKeys, parseArgs, renderPlan, ROLES } from "./key-roles.js";

const { PrivateKey, KeyAlgorithm } = casperSdk;

describe("key-roles planner (M07)", () => {
  const base = mkdtempSync(join(tmpdir(), "cascet-roles-"));
  after(() => rmSync(base, { recursive: true, force: true }));

  test("generates one fresh ed25519 key per role, secret files mode 600, directory 700", () => {
    const dir = join(base, "mainnet");
    const keys = generateRoleKeys(dir);
    assert.deepEqual(keys.map(k => k.role), [...ROLES]);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const accounts = new Set<string>();
    for (const k of keys) {
      assert.equal(statSync(k.pemPath).mode & 0o777, 0o600);
      const reloaded = PrivateKey.fromPem(readFileSync(k.pemPath, "utf8"), KeyAlgorithm.ED25519);
      assert.equal(reloaded.publicKey.toHex(), k.publicKeyHex);
      assert.equal(k.accountKey, `00${reloaded.publicKey.accountHash().toHex()}`);
      accounts.add(k.accountKey);
    }
    assert.equal(accounts.size, 3, "every role gets its own key");
  });

  test("never overwrites existing key files", () => {
    const dir = join(base, "taken");
    generateRoleKeys(dir);
    const before = readFileSync(join(dir, "fee-payer_secret_key.pem"), "utf8");
    assert.throws(() => generateRoleKeys(dir), /refusing to overwrite/);
    assert.equal(readFileSync(join(dir, "fee-payer_secret_key.pem"), "utf8"), before);
  });

  test("writes nothing at all when any target file is in the way", () => {
    const dir = join(base, "partial");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "seller_public_key_hex"), "x");
    assert.throws(() => generateRoleKeys(dir), /refusing to overwrite/);
    assert.throws(() => statSync(join(dir, "fee-payer_secret_key.pem")), /ENOENT/);
  });

  test("the printed plan holds public data and the on-chain steps only", () => {
    const dir = join(base, "plan");
    const keys = generateRoleKeys(dir);
    const plan = renderPlan(keys, { network: "casper:casper", outDir: dir });
    assert.doesNotMatch(plan, /PRIVATE KEY|BEGIN/);
    for (const k of keys) {
      const secretBody = readFileSync(k.pemPath, "utf8").split("\n")[1]!;
      assert.ok(!plan.includes(secretBody), "no secret key material");
      assert.ok(plan.includes(k.publicKeyHex));
      assert.ok(plan.includes(k.accountKey));
    }
    for (const step of [
      "NOTHING has been sent",
      "testnet first",
      "Fund the fee payer",
      '"authorize"',
      '"revoke"',
      '"transfer_ownership"',
      "add_associated_key",
      "set_action_threshold",
      "hash-f86bef35062e92d06b8171cf4131fdf557463589aca9112a348e5eb24159eb93",
      "CASCET_OWNER_ACCOUNT_HASH=00b9a38c827771d6bc510dd5f1e24fee61acdd4f97f758f4d68fe1dea13a7a140d",
    ]) {
      assert.ok(plan.includes(step), `plan mentions ${step}`);
    }
  });

  test("argument parsing", () => {
    assert.deepEqual(parseArgs(["--", "--out", "/x"]), { outDir: "/x", network: "casper:casper" });
    assert.deepEqual(parseArgs(["--out", "/x", "--network", "casper-test"]), { outDir: "/x", network: "casper:casper-test" });
    assert.throws(() => parseArgs([]), /usage/);
    assert.throws(() => parseArgs(["--out", "/x", "--network", "mainnet"]), /casper or casper-test/);
    assert.throws(() => parseArgs(["--send"]), /unknown argument/);
  });
});
