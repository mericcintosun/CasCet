import { test } from "node:test";
import assert from "node:assert/strict";
import type { PaymentReceipt } from "@cascet/core";
import {
  allowedPayToOf,
  buildMcpConfig,
  buildShellCommand,
  CLI_SPEC,
  CLI_VERSION,
  cliCommand,
  connectEnv,
  connectWarnings,
  CONTRACT_SELLER_ERROR,
  rawToTokens,
  readConnectPrefill,
  sanitizeServerName,
  sellerRow,
  shellQuote,
  tokensToRaw,
  type ConnectSettings,
} from "./connect-config";
import { parsePayeeInput } from "./casper/keys";
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

test("generated commands pin the hardened CLI release exactly, never latest or 0.1.0 (M13)", () => {
  // npm's latest is 0.1.0, which ignores CASCET_NETWORK, the allowlists and the tool pins.
  assert.notEqual(CLI_VERSION, "latest");
  assert.notEqual(CLI_VERSION, "0.1.0");
  assert.match(CLI_VERSION, /^\d+\.\d+\.\d+$/, "an exact version, not a tag or a range");
  assert.equal(CLI_SPEC, `@cascet/cli@${CLI_VERSION}`);
  assert.equal(buildShellCommand(base).split("\n").at(-1), `npx ${shellQuote(CLI_SPEC)} connect https://gw.example.com/mcp`);
  assert.deepEqual(buildMcpConfig(base).mcpServers["my-gateway"]!.args.slice(0, 2), ["-y", CLI_SPEC]);
  // The spec goes through shell quoting, so a range can never act as a redirect or glob.
  assert.equal(cliCommand("connect x", "@cascet/cli@>0.1.0"), "npx '@cascet/cli@>0.1.0' connect x");
  assert.equal(cliCommand("init x", "@cascet/cli@^0.1.1"), "npx '@cascet/cli@^0.1.1' init x");
  assert.equal(cliCommand("wrap"), `npx ${CLI_SPEC} wrap`);
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
  const SELLER2 = `account-hash-${"ef".repeat(32)}`;
  const env = new Map(connectEnv({ ...base, allowedPayTo: [SELLER, SELLER2], allowedAssets: [ASSET, "ef".repeat(32)] }));
  assert.equal(env.get("CASCET_ALLOWED_PAYTO"), `${SELLER},${SELLER2}`);
  assert.equal(env.get("CASCET_ALLOWED_ASSETS"), `${ASSET},${"ef".repeat(32)}`);
});

test("contract-package sellers are rejected and never reach CASCET_ALLOWED_PAYTO", () => {
  // cascet connect refuses a contract package in CASCET_ALLOWED_PAYTO, and no facilitator can settle one.
  const pkgHash = "ef".repeat(32);
  for (const input of [`hash-${pkgHash}`, `package-hash-${pkgHash}`, `contract-package-${pkgHash}`, `HASH-${pkgHash.toUpperCase()}`]) {
    const row = sellerRow(input, parsePayeeInput(input));
    assert.equal(row.value, null, input);
    assert.equal(row.error, CONTRACT_SELLER_ERROR, input);
    assert.equal(row.pending, false);
  }
  const rows = [SELLER, `hash-${pkgHash}`].map((input) => sellerRow(input, parsePayeeInput(input)));
  assert.deepEqual(allowedPayToOf(rows), [SELLER]);
  assert.ok(rows.some((r) => r.error), "the page blocks the output while any line has an error");
});

test("seller lines: account hashes as 00…, public keys once converted, the rest are errors", () => {
  const H = "ab".repeat(32);
  assert.deepEqual(sellerRow(`account-hash-${H}`, parsePayeeInput(`account-hash-${H}`)), {
    input: `account-hash-${H}`,
    value: `00${H}`,
    note: "account",
    error: null,
    pending: false,
    retryable: false,
  });
  const key = `01${"cd".repeat(32)}`;
  const parsed = parsePayeeInput(key);
  assert.equal(sellerRow(key, parsed).pending, true, "no conversion yet");
  assert.equal(sellerRow(key, parsed, { pending: true }).pending, true);
  const converted = sellerRow(key, parsed, { hash: H });
  assert.equal(converted.value, `00${H}`);
  assert.equal(converted.note, "converted from public key");
  const invalid = sellerRow(key, parsed, { error: "not a valid Casper public key", retryable: false });
  assert.deepEqual([invalid.value, invalid.error, invalid.retryable], [null, "not a valid Casper public key", false]);
  const offline = sellerRow(key, parsed, { error: "could not load the key converter", retryable: true });
  assert.equal(offline.retryable, true);
  assert.equal(sellerRow(H, parsePayeeInput(H)).value, null, "a bare 64-hex value is ambiguous");
  // Never a raw 01… public key on the allowlist (M01).
  assert.deepEqual(allowedPayToOf([sellerRow(key, parsed)]), []);
  // Duplicates collapse.
  assert.deepEqual(allowedPayToOf([sellerRow(`00${H}`, parsePayeeInput(`00${H}`)), converted]), [`00${H}`]);
});

test("a /connect link prefills fields and lists them, but never switches to mainnet", () => {
  const p = readConnectPrefill(
    new URLSearchParams({
      gateway: " https://gw.example.com/mcp ",
      seller: `${SELLER},${SELLER} 00${"ef".repeat(32)}`,
      asset: ASSET,
      decimals: "9",
      perCall: "0.5",
      network: "mainnet",
    }),
  );
  assert.equal(p.gatewayUrl, "https://gw.example.com/mcp");
  assert.deepEqual(p.sellers, [SELLER, `00${"ef".repeat(32)}`]);
  assert.deepEqual(p.assets, [ASSET]);
  assert.equal(p.decimals, "9");
  assert.equal(p.perCall, "0.5");
  assert.equal(p.session, "");
  // The network is not a prefilled field: the page starts on testnet and only the notice mentions the request.
  assert.equal(p.requestedMainnet, true);
  assert.equal("network" in p, false);
  assert.deepEqual(p.applied, ["gateway URL", "sellers", "token", "token decimals", "per-call cap"]);
  assert.deepEqual(p.appliedFields, ["gatewayUrl", "sellers", "assets", "decimals", "perCall"]);

  assert.deepEqual(readConnectPrefill(null).applied, []);
  assert.deepEqual(readConnectPrefill(new URLSearchParams()).applied, []);
  assert.deepEqual(readConnectPrefill(new URLSearchParams({ network: "mainnet" })).applied, [], "nothing filled in");
  // Out-of-range decimals are ignored, not applied.
  assert.equal(readConnectPrefill(new URLSearchParams({ decimals: "19" })).decimals, null);
  assert.deepEqual(readConnectPrefill(new URLSearchParams({ decimals: "x" })).applied, []);
  assert.deepEqual(readConnectPrefill(new URLSearchParams({ session: "5" })).applied, ["session cap"]);
  assert.deepEqual(readConnectPrefill(new URLSearchParams({ session: "5" })).appliedFields, ["session"]);
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

test("other warnings: per-call above session, mainnet, local gateway, relative key and pin paths", () => {
  const w = connectWarnings(
    { ...base, maxPerCallRaw: "10", maxSessionRaw: "5", network: "mainnet", keyPath: "./agent.pem", toolPinsPath: "pins.json" },
    true,
  );
  assert.deepEqual(
    w.map((x) => `${x.level}:${x.field}`),
    ["warning:budget", "warning:network", "info:gateway", "info:key", "info:key"],
  );
  assert.deepEqual(connectWarnings({ ...base, keyPath: "C:\\keys\\agent.pem", toolPinsPath: "/home/me/pins.json" }), []);
  // The CLI expands ~/ in CASCET_TOOL_PINS itself (not in CASCET_KEY_PATH), so only the key path warns.
  assert.deepEqual(
    connectWarnings({ ...base, keyPath: "~/agent.pem", toolPinsPath: "~/.cascet/pins.json" }).map((x) => x.message.slice(0, 20)),
    ["MCP clients start th"],
  );
});

test("the session cap is per token: several allowlisted tokens, or any token, multiply what one bridge can pay", () => {
  const OTHER = "ef".repeat(32);
  const two = connectWarnings({ ...base, allowedAssets: [ASSET, OTHER] });
  assert.deepEqual(
    two.map((w) => `${w.level}:${w.field}`),
    ["warning:budget"],
  );
  assert.match(two[0]!.message, /applies to each token on its own/);
  assert.match(two[0]!.message, /2 tokens allowlisted, one running bridge can pay up to 2 × the session cap \(10000000000 raw units\)/);
  // Any token (explicit opt-out): the cap bounds no total at all.
  const any = connectWarnings({ ...base, allowedAssets: [], allowAnySeller: true });
  assert.ok(any.some((w) => w.field === "budget" && /bounds no total/.test(w.message)));
  // One token, or no session cap: nothing to add.
  assert.deepEqual(connectWarnings(base), []);
  assert.equal(
    connectWarnings({ ...base, allowedAssets: [ASSET, OTHER], maxSessionRaw: null, allowUnlimitedBudget: true }).some((w) => /each token/.test(w.message)),
    false,
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
