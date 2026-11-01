import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkGatewayUrl, resolveConnectConfig, type ConnectInputs } from "./connect-config.js";
import { checkArgs, parseArgs } from "./args.js";

const SELLER = "00" + "a1".repeat(32);
const ASSET = "hash-" + "d4".repeat(32);

function inputs(env: Record<string, string | undefined> = {}, flags: string[] = [], url = "http://localhost:4402/mcp"): ConnectInputs {
  return {
    url,
    env: {
      CASCET_KEY_PATH: "/keys/agent.pem",
      CASCET_ALLOWED_PAYTO: SELLER,
      CASCET_ALLOWED_ASSETS: ASSET,
      CASCET_MAX_PER_CALL: "1000000000",
      CASCET_MAX_SESSION: "5000000000",
      ...env,
    },
    flags: new Set(flags),
    cwd: "/work",
    home: "/home/agent",
    exists: () => true,
  };
}

describe("resolveConnectConfig", () => {
  it("forwards every safety option to the paying fetch and the bridge (M13/M23)", () => {
    const cfg = resolveConnectConfig(
      inputs({
        CASCET_NETWORK: "casper:casper-test, casper:casper",
        CASCET_ALLOWED_PAYTO: `${SELLER}, account-hash-${"b2".repeat(32)}`,
        CASCET_KEY_ALGO: "secp256k1",
        CASCET_TIMEOUT_MS: "45000",
        CASCET_TOOL_PINS: "~/pins.json",
      }),
    );
    assert.deepEqual(cfg.paying, {
      privateKeyPath: "/keys/agent.pem",
      keyAlgorithm: "secp256k1",
      networks: ["casper:casper-test", "casper:casper"],
      allowedPayTo: [SELLER, `account-hash-${"b2".repeat(32)}`],
      allowedAssets: [ASSET],
      budget: { maxPerCallRaw: "1000000000", maxSessionRaw: "5000000000" },
      timeoutMs: 45000,
    });
    assert.deepEqual(cfg.bridge, { timeoutMs: 45000, toolPins: { path: "/home/agent/pins.json", acceptChanges: false } });
    assert.match(cfg.notices.join("\n"), /MAINNET payments enabled/);
  });

  it("defaults to testnet, a 30 s timeout and ~/.cascet/tool-pins.json", () => {
    const cfg = resolveConnectConfig(inputs());
    assert.deepEqual(cfg.paying.networks, ["casper:casper-test"]);
    assert.equal(cfg.paying.timeoutMs, 30_000);
    assert.equal(cfg.bridge.toolPins.path, "/home/agent/.cascet/tool-pins.json");
    assert.deepEqual(cfg.notices, []);
  });

  it("requires both allowlists unless --allow-any-seller or CASCET_ALLOW_ANY_SELLER=1 (M02)", () => {
    assert.throws(
      () => resolveConnectConfig(inputs({ CASCET_ALLOWED_PAYTO: undefined, CASCET_ALLOWED_ASSETS: " " })),
      /CASCET_ALLOWED_PAYTO and CASCET_ALLOWED_ASSETS are required.*--allow-any-seller/,
    );
    assert.throws(() => resolveConnectConfig(inputs({ CASCET_ALLOWED_ASSETS: undefined })), /CASCET_ALLOWED_ASSETS is required/);

    const viaFlag = resolveConnectConfig(inputs({ CASCET_ALLOWED_PAYTO: undefined, CASCET_ALLOWED_ASSETS: undefined }, ["--allow-any-seller"]));
    assert.equal(viaFlag.paying.allowedPayTo, undefined);
    assert.match(viaFlag.notices.join("\n"), /WARNING: --allow-any-seller/);
    const viaEnv = resolveConnectConfig(inputs({ CASCET_ALLOWED_PAYTO: undefined, CASCET_ALLOW_ANY_SELLER: "1" }));
    assert.equal(viaEnv.paying.allowedPayTo, undefined);
    assert.deepEqual(viaEnv.paying.allowedAssets, [ASSET], "a list that is set still applies");
  });

  it("requires both budgets unless --allow-unlimited-budget or CASCET_ALLOW_UNLIMITED_BUDGET=1 (LLM06)", () => {
    assert.throws(
      () => resolveConnectConfig(inputs({ CASCET_MAX_PER_CALL: undefined, CASCET_MAX_SESSION: undefined })),
      /CASCET_MAX_PER_CALL and CASCET_MAX_SESSION are required.*--allow-unlimited-budget/,
    );
    assert.throws(() => resolveConnectConfig(inputs({ CASCET_MAX_SESSION: "" })), /CASCET_MAX_SESSION is required/);

    const unlimited = resolveConnectConfig(inputs({ CASCET_MAX_PER_CALL: undefined }, ["--allow-unlimited-budget"]));
    assert.deepEqual(unlimited.paying.budget, { maxSessionRaw: "5000000000" });
    assert.match(unlimited.notices.join("\n"), /WARNING: --allow-unlimited-budget: CASCET_MAX_PER_CALL not set/);
    const viaEnv = resolveConnectConfig(
      inputs({ CASCET_MAX_PER_CALL: undefined, CASCET_MAX_SESSION: undefined, CASCET_ALLOW_UNLIMITED_BUDGET: "true" }),
    );
    assert.deepEqual(viaEnv.paying.budget, {});
  });

  it("rejects malformed values and names the env var", () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ CASCET_MAX_PER_CALL: "-1" }, /CASCET_MAX_PER_CALL must be a whole number/],
      [{ CASCET_MAX_SESSION: "5e9" }, /CASCET_MAX_SESSION must be a whole number/],
      [{ CASCET_MAX_PER_CALL: "0" }, /CASCET_MAX_PER_CALL must be greater than zero/],
      [{ CASCET_ALLOWED_PAYTO: "01" + "ab".repeat(32) }, /CASCET_ALLOWED_PAYTO: .*public key.*account-hash/],
      [{ CASCET_ALLOWED_ASSETS: "hash-123" }, /CASCET_ALLOWED_ASSETS: invalid asset/],
      [{ CASCET_NETWORK: "casper:*" }, /CASCET_NETWORK: invalid network/],
      [{ CASCET_KEY_ALGO: "rsa" }, /CASCET_KEY_ALGO must be/],
      [{ CASCET_TIMEOUT_MS: "30s" }, /CASCET_TIMEOUT_MS must be a whole number/],
      [{ CASCET_KEY_PATH: "" }, /CASCET_KEY_PATH .* is required/],
    ];
    for (const [env, pattern] of cases) assert.throws(() => resolveConnectConfig(inputs(env)), pattern, JSON.stringify(env));
  });

  it("resolves a relative key path and reports a missing key file", () => {
    const cfg = resolveConnectConfig(inputs({ CASCET_KEY_PATH: "./agent.pem" }));
    assert.equal(cfg.paying.privateKeyPath, "/work/agent.pem");
    assert.throws(
      () => resolveConnectConfig({ ...inputs({ CASCET_KEY_PATH: "./agent.pem" }), exists: () => false }),
      /no file at \/work\/agent\.pem/,
    );
  });

  it("passes --accept-tool-changes to the pin guard with a notice", () => {
    const cfg = resolveConnectConfig(inputs({}, ["--accept-tool-changes"]));
    assert.equal(cfg.bridge.toolPins.acceptChanges, true);
    assert.match(cfg.notices.join("\n"), /--accept-tool-changes/);
  });
});

describe("checkGatewayUrl", () => {
  it("allows https anywhere and http on loopback, including IPv6 [::1] (L06)", () => {
    assert.equal(checkGatewayUrl("https://gw.example.com/mcp"), "https://gw.example.com/mcp");
    assert.equal(checkGatewayUrl("http://localhost:4402/mcp"), "http://localhost:4402/mcp");
    assert.equal(checkGatewayUrl("http://127.0.0.1:4402/mcp"), "http://127.0.0.1:4402/mcp");
    assert.equal(checkGatewayUrl("http://[::1]:4402/mcp"), "http://[::1]:4402/mcp");
  });

  it("refuses plain http to a remote host and odd schemes", () => {
    assert.throws(() => checkGatewayUrl("http://gw.example.com/mcp"), /refusing insecure http/);
    assert.throws(() => checkGatewayUrl("http://127.evil.example/mcp"), /refusing insecure http/);
    assert.throws(() => checkGatewayUrl("ftp://localhost/mcp"), /unsupported gateway URL scheme/);
    assert.throws(() => checkGatewayUrl("not a url"), /invalid gateway URL/);
  });
});

describe("parseArgs", () => {
  it("separates the command, positionals and flags in any order", () => {
    const args = parseArgs(["connect", "--allow-any-seller", "http://localhost:4402/mcp", "--accept-tool-changes"]);
    assert.equal(args.command, "connect");
    assert.deepEqual(args.positionals, ["http://localhost:4402/mcp"]);
    assert.deepEqual([...args.flags], ["--allow-any-seller", "--accept-tool-changes"]);
    assert.equal(parseArgs(["--help"]).help, true);
    assert.equal(parseArgs(["wrap", "-v"]).version, true);
  });

  it("rejects unknown flags and extra arguments", () => {
    assert.throws(() => checkArgs(parseArgs(["connect", "--allow-everything", "u"]), ["--allow-any-seller"], 1), /unknown option --allow-everything/);
    assert.throws(() => checkArgs(parseArgs(["init", "a", "b"]), [], 1), /unexpected argument "b"/);
  });
});
