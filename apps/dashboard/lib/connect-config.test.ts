import { test } from "node:test";
import assert from "node:assert/strict";
import type { PaymentReceipt } from "@cascet/core";
import {
  buildMcpConfig,
  buildShellCommand,
  CLI_SPEC,
  connectEnv,
  connectWarnings,
  rawToTokens,
  sanitizeServerName,
  shellQuote,
  tokensToRaw,
  type ConnectSettings,
} from "./connect-config";
import { spendByAsset } from "./spend";

const SELLER = `00${"ab".repeat(32)}`;
const ASSET = "cd".repeat(32);

const base: ConnectSettings = {
  gatewayUrl: "https://gw.example.com/mcp",
  network: "testnet",
  keyPath: "/home/me/keys/agent.pem",
  keyAlgorithm: "ed25519",
  allowedPayTo: [SELLER],
  allowedAssets: [ASSET],
  maxPerCallRaw: "50000000",
  maxSessionRaw: "5000000000",
  allowAnySeller: false,
  allowUnlimitedBudget: false,
  toolPinsPath: null,
  serverName: "My Gateway!",
};

test("the shell command carries every safety env var and the pinned CLI spec", () => {
  assert.equal(
    buildShellCommand(base),
    [
      "CASCET_KEY_PATH=/home/me/keys/agent.pem \\",
      "CASCET_NETWORK=casper:casper-test \\",
      `CASCET_ALLOWED_PAYTO=${SELLER} \\`,
      `CASCET_ALLOWED_ASSETS=${ASSET} \\`,
      "CASCET_MAX_PER_CALL=50000000 \\",
      "CASCET_MAX_SESSION=5000000000 \\",
      `npx ${CLI_SPEC} connect https://gw.example.com/mcp`,
    ].join("\n"),
  );
  assert.deepEqual(connectWarnings(base), []);
});

test("the MCP client config is the Claude Desktop / Claude Code mcpServers shape", () => {
  const cfg = buildMcpConfig({ ...base, network: "mainnet", keyAlgorithm: "secp256k1", toolPinsPath: "/home/me/.cascet/pins.json" });
  assert.deepEqual(Object.keys(cfg.mcpServers), ["my-gateway"]);
  const entry = cfg.mcpServers["my-gateway"]!;
  assert.equal(entry.command, "npx");
  assert.deepEqual(entry.args, ["-y", CLI_SPEC, "connect", "https://gw.example.com/mcp"]);
  assert.deepEqual(entry.env, {
    CASCET_KEY_PATH: "/home/me/keys/agent.pem",
    CASCET_KEY_ALGO: "secp256k1",
    CASCET_NETWORK: "casper:casper",
    CASCET_ALLOWED_PAYTO: SELLER,
    CASCET_ALLOWED_ASSETS: ASSET,
    CASCET_MAX_PER_CALL: "50000000",
    CASCET_MAX_SESSION: "5000000000",
    CASCET_TOOL_PINS: "/home/me/.cascet/pins.json",
  });
  // valid JSON round trip
  assert.deepEqual(JSON.parse(JSON.stringify(cfg)), cfg);
});

test("lists are comma-joined", () => {
  const env = new Map(connectEnv({ ...base, allowedPayTo: [SELLER, `01${"ef".repeat(32)}`] }));
  assert.equal(env.get("CASCET_ALLOWED_PAYTO"), `${SELLER},01${"ef".repeat(32)}`);
});

test("empty safety fields warn and add NO opt-out unless the user explicitly chose it", () => {
  const open = { ...base, allowedPayTo: [], allowedAssets: [], maxPerCallRaw: null, maxSessionRaw: null };
  const env = new Map(connectEnv(open));
  assert.equal(env.has("CASCET_ALLOW_ANY_SELLER"), false);
  assert.equal(env.has("CASCET_ALLOW_UNLIMITED_BUDGET"), false);
  const fields = connectWarnings(open).map((w) => `${w.level}:${w.field}`);
  assert.deepEqual(fields, ["danger:sellers", "danger:assets", "danger:budget"]);
  assert.match(connectWarnings(open)[0]!.message, /refuses to start/);

  const optedOut = { ...open, allowAnySeller: true, allowUnlimitedBudget: true };
  const env2 = new Map(connectEnv(optedOut));
  assert.equal(env2.get("CASCET_ALLOW_ANY_SELLER"), "1");
  assert.equal(env2.get("CASCET_ALLOW_UNLIMITED_BUDGET"), "1");
  assert.match(connectWarnings(optedOut)[0]!.message, /CASCET_ALLOW_ANY_SELLER=1/);
});

test("an opt-out is dropped once the safety fields are filled in", () => {
  const env = new Map(connectEnv({ ...base, allowAnySeller: true, allowUnlimitedBudget: true }));
  assert.equal(env.has("CASCET_ALLOW_ANY_SELLER"), false);
  assert.equal(env.has("CASCET_ALLOW_UNLIMITED_BUDGET"), false);
});

test("other warnings: per-call above session, mainnet, local gateway, relative key path", () => {
  const w = connectWarnings({ ...base, maxPerCallRaw: "10", maxSessionRaw: "5", network: "mainnet", keyPath: "./agent.pem" }, true);
  assert.deepEqual(
    w.map((x) => `${x.level}:${x.field}`),
    ["warning:budget", "warning:network", "info:gateway", "info:key"],
  );
});

test("shell quoting keeps injection out of the copied command", () => {
  assert.equal(shellQuote("./agent.pem"), "./agent.pem");
  assert.equal(shellQuote("~/keys/agent.pem"), "~/keys/agent.pem");
  assert.equal(shellQuote("/tmp/my key.pem"), "'/tmp/my key.pem'");
  assert.equal(shellQuote("$(rm -rf ~)"), "'$(rm -rf ~)'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote("https://gw.example.com/mcp?a=1&b=2"), "'https://gw.example.com/mcp?a=1&b=2'");
  assert.equal(shellQuote(""), "''");
  const cmd = buildShellCommand({ ...base, keyPath: "/tmp/$(whoami).pem" });
  assert.match(cmd, /^CASCET_KEY_PATH='\/tmp\/\$\(whoami\)\.pem' \\$/m);
});

test("token amounts convert exactly to raw units", () => {
  assert.deepEqual(tokensToRaw("0.05", 9), { ok: true, raw: "50000000" });
  assert.deepEqual(tokensToRaw("5", 9), { ok: true, raw: "5000000000" });
  assert.deepEqual(tokensToRaw(" 1.000000001 ", 9), { ok: true, raw: "1000000001" });
  assert.deepEqual(tokensToRaw("3", 0), { ok: true, raw: "3" });
  for (const bad of ["", "0", "0.0", "-1", "1e3", ".5", "1.", "abc", "0x10", "1.0000000001"]) {
    assert.equal(tokensToRaw(bad, 9).ok, false, bad);
  }
  assert.equal(tokensToRaw("1", 19).ok, false);
  assert.equal(tokensToRaw("9".repeat(41), 0).ok, false);
  assert.equal(rawToTokens("50000000", 9), "0.05");
  assert.equal(rawToTokens(5_000_000_000n, 9), "5");
  assert.equal(rawToTokens("7", 0), "7");
});

test("server names are safe mcpServers keys", () => {
  assert.equal(sanitizeServerName("  CasCet Data (prod) "), "cascet-data-prod");
  assert.equal(sanitizeServerName("!!!"), "cascet");
});

test("session spend sums settled receipts per asset for the matching payer", () => {
  const r = (payer: string, asset: string, amountRaw: string, status: "settled" | "failed" = "settled"): PaymentReceipt => ({
    id: Math.random().toString(36),
    createdAt: "2026-10-01T00:00:00Z",
    network: "casper:casper-test",
    server: "s",
    tool: "t",
    payer,
    payTo: SELLER,
    amountRaw,
    asset,
    assetSymbol: "WCSPR",
    status,
  });
  const me = `00${"11".repeat(32)}`;
  const rows = spendByAsset(
    [r(me, `hash-${ASSET}`, "10"), r(me, ASSET.toUpperCase(), "5"), r(me, "ee".repeat(32), "100"), r("other", ASSET, "999"), r(me, ASSET, "7", "failed")],
    (p) => p === me,
  );
  assert.deepEqual(
    rows.map((x) => [x.asset, x.raw, x.calls]),
    [
      ["ee".repeat(32), 100n, 1],
      [ASSET, 15n, 2],
    ],
  );
});
