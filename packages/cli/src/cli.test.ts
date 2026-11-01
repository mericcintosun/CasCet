import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** Run the CLI entry point in a child process (through tsx) with a controlled environment. */
function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("cascet CLI", () => {
  it("--help and --version exit 0 (L18)", () => {
    const help = run(["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /cascet account-hash <public-key>/);
    assert.match(help.stdout, /--allow-any-seller/);
    const version = run(["--version"]);
    assert.equal(version.status, 0);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);
  });

  it("account-hash prints only the 00-prefixed payTo on stdout", () => {
    const result = run(["account-hash", "01" + "11".repeat(32)]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "0033b261261c76ab5a249ae145461cadc722dc67ed59cf0e9c538b6c2b366ec463");
  });

  it("account-hash rejects garbage without a stack trace", () => {
    const result = run(["account-hash", "not-a-key"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /expected a Casper public key/);
    assert.doesNotMatch(result.stderr, /\bat .*\(.*:\d+:\d+\)/);
  });

  it("connect refuses to start without allowlists and budgets", () => {
    const result = run(["connect", "http://localhost:4402/mcp"], { CASCET_KEY_PATH: CLI });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CASCET_ALLOWED_PAYTO and CASCET_ALLOWED_ASSETS are required/);
  });

  it("rejects unknown commands and options", () => {
    assert.equal(run(["bogus"]).status, 1);
    const flag = run(["connect", "--allow-everything", "http://localhost:4402/mcp"]);
    assert.equal(flag.status, 1);
    assert.match(flag.stderr, /unknown option --allow-everything/);
  });
});
