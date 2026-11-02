import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkGatewayUrl, DEFAULT_CONNECT_TIMEOUT_MS, resolveConnectConfig, type ConnectInputs } from "./connect-config.js";
import { checkArgs, CONNECT_FLAGS, parseArgs } from "./args.js";

const SELLER = "00" + "a1".repeat(32);
const ASSET = "hash-" + "d4".repeat(32);
const DIGEST_A = "ab".repeat(32);
const DIGEST_B = "cd".repeat(32);

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
    flags: parseArgs(["connect", ...flags]).flags,
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
    assert.deepEqual(cfg.bridge, { timeoutMs: 45000, toolPins: { path: "/home/agent/pins.json", acceptDigests: [] } });
    assert.match(cfg.notices.join("\n"), /MAINNET payments enabled/);
  });

  it("defaults to testnet, a 180 s deadline (paid calls settle on-chain) and ~/.cascet/tool-pins.json", () => {
    const cfg = resolveConnectConfig(inputs());
    assert.deepEqual(cfg.paying.networks, ["casper:casper-test"]);
    assert.equal(DEFAULT_CONNECT_TIMEOUT_MS, 200_000);
    assert.equal(cfg.paying.timeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    assert.equal(cfg.bridge.timeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
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

  it("passes CASCET_PREFER_STYLES as an ordered, de-duplicated preference, and nothing when it is unset", () => {
    const cfg = resolveConnectConfig(inputs({ CASCET_PREFER_STYLES: " cep3009-value, legacy-amount,cep3009-value " }));
    assert.deepEqual(cfg.paying.preferStyles, ["cep3009-value", "legacy-amount"]);
    assert.match(cfg.summary, /\| prefer cep3009-value > legacy-amount \|/);
    for (const unset of [undefined, "", " , "]) {
      const plain = resolveConnectConfig(inputs({ CASCET_PREFER_STYLES: unset }));
      assert.equal("preferStyles" in plain.paying, false, JSON.stringify(unset));
      assert.doesNotMatch(plain.summary, /prefer/);
    }
  });

  it("rejects malformed values and names the env var", () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ CASCET_MAX_PER_CALL: "-1" }, /CASCET_MAX_PER_CALL must be a whole number/],
      [{ CASCET_MAX_SESSION: "5e9" }, /CASCET_MAX_SESSION must be a whole number/],
      [{ CASCET_MAX_PER_CALL: "0" }, /CASCET_MAX_PER_CALL must be greater than zero/],
      [{ CASCET_ALLOWED_PAYTO: "01" + "ab".repeat(32) }, /CASCET_ALLOWED_PAYTO: .*public key.*account-hash/],
      [
        { CASCET_ALLOWED_PAYTO: `${SELLER},hash-${"c3".repeat(32)}` },
        /CASCET_ALLOWED_PAYTO: .*contract-package payee: contract-package payees are not paid: @make-software\/casper-x402 1\.0\.0 facilitators credit the payment to an account nobody controls/,
      ],
      [{ CASCET_ALLOWED_ASSETS: "hash-123" }, /CASCET_ALLOWED_ASSETS: invalid asset/],
      [{ CASCET_NETWORK: "casper:*" }, /CASCET_NETWORK: invalid network/],
      [{ CASCET_KEY_ALGO: "rsa" }, /CASCET_KEY_ALGO must be/],
      [{ CASCET_TIMEOUT_MS: "30s" }, /CASCET_TIMEOUT_MS must be a whole number/],
      [{ CASCET_KEY_PATH: "" }, /CASCET_KEY_PATH .* is required/],
      [
        { CASCET_PREFER_STYLES: "cep3009-value,permit2" },
        /CliError: CASCET_PREFER_STYLES: unknown authorization style "permit2"; known styles: legacy-amount, cep3009-value$/,
      ],
      [{ CASCET_PREFER_STYLES: "CEP3009-VALUE" }, /CASCET_PREFER_STYLES: unknown authorization style "CEP3009-VALUE"/],
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

  it("passes the reviewed digests of --accept-tool-changes=<sha256>,... to the pin guard", () => {
    const cfg = resolveConnectConfig(
      inputs({}, [`--accept-tool-changes=${DIGEST_A.toUpperCase()}, ${DIGEST_B}`, `--accept-tool-changes=${DIGEST_A}`]),
    );
    assert.deepEqual(cfg.bridge.toolPins.acceptDigests, [DIGEST_A, DIGEST_B]);
    assert.match(cfg.notices.join("\n"), /2 reviewed definition\(s\) will be pinned .* every other change stays quarantined/);
    assert.match(cfg.summary, /accepting 2 reviewed definition\(s\)/);
  });

  it("refuses a bare --accept-tool-changes and asks for the digest", () => {
    for (const flag of ["--accept-tool-changes", "--accept-tool-changes=", "--accept-tool-changes=,"]) {
      assert.throws(
        () => resolveConnectConfig(inputs({}, [flag])),
        /--accept-tool-changes needs the sha256 of each definition you reviewed and accept: --accept-tool-changes=<sha256>/,
        flag,
      );
    }
    assert.throws(
      () => resolveConnectConfig(inputs({}, [`--accept-tool-changes=${DIGEST_A},latest`])),
      /--accept-tool-changes: "latest" is not a sha256 digest/,
    );
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
    const args = parseArgs(["connect", "--allow-any-seller", "http://localhost:4402/mcp", `--accept-tool-changes=${DIGEST_A}`]);
    assert.equal(args.command, "connect");
    assert.deepEqual(args.positionals, ["http://localhost:4402/mcp"]);
    assert.deepEqual([...args.flags], [
      ["--allow-any-seller", undefined],
      ["--accept-tool-changes", DIGEST_A],
    ]);
    assert.equal(parseArgs(["--help"]).help, true);
    assert.equal(parseArgs(["wrap", "-v"]).version, true);
  });

  it("keeps everything after the first = and joins repeated values", () => {
    assert.equal(parseArgs(["connect", "--accept-tool-changes=a=b"]).flags.get("--accept-tool-changes"), "a=b");
    const repeated = parseArgs(["connect", "--accept-tool-changes", "--accept-tool-changes=a", "--accept-tool-changes=b"]);
    assert.equal(repeated.flags.get("--accept-tool-changes"), "a,b");
  });

  it("rejects unknown flags, values on switches and extra arguments", () => {
    assert.throws(() => checkArgs(parseArgs(["connect", "--allow-everything", "u"]), CONNECT_FLAGS, 1), /unknown option --allow-everything/);
    assert.throws(() => checkArgs(parseArgs(["connect", "--allow-any-seller=no", "u"]), CONNECT_FLAGS, 1), /--allow-any-seller does not take a value/);
    assert.throws(() => checkArgs(parseArgs(["init", "--constructor"]), {}, 1), /unknown option --constructor/);
    assert.throws(() => checkArgs(parseArgs(["init", "a", "b"]), {}, 1), /unexpected argument "b"/);
    assert.doesNotThrow(() => checkArgs(parseArgs(["connect", "u", `--accept-tool-changes=${DIGEST_A}`]), CONNECT_FLAGS, 1));
  });
});

