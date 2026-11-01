#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { cascetConfigSchema } from "@cascet/core";
import { accountHashFromPublicKey, createPayingFetch, readPinFile, runBridge } from "@cascet/client";
import { checkArgs, CliError, CONNECT_FLAGS, parseArgs, type ParsedArgs } from "./args.js";
import { resolveConnectConfig } from "./connect-config.js";
import { initNextSteps, initTemplate } from "./init-template.js";
import { formatConfigIssues, wrapWarnings } from "./wrap-check.js";

try {
  await main(parseArgs(process.argv.slice(2)));
} catch (err) {
  fail(err);
}

async function main(args: ParsedArgs): Promise<void> {
  if (args.version) {
    console.log(version());
    return;
  }
  if (args.help || args.command === undefined || args.command === "help") {
    help();
    return;
  }
  switch (args.command) {
    case "init":
      checkArgs(args, [], 1);
      init(args.positionals[0]);
      return;
    case "wrap":
      checkArgs(args, [], 1);
      await wrap(args.positionals[0]);
      return;
    case "connect":
      checkArgs(args, CONNECT_FLAGS, 1);
      await connect(args);
      return;
    case "account-hash":
      checkArgs(args, [], 1);
      accountHash(args.positionals[0]);
      return;
    default:
      throw new CliError(`unknown command "${args.command}" (see cascet --help)`);
  }
}

/** `cascet wrap [config path]`: start a paid-MCP gateway in front of the configured upstream. */
async function wrap(configArg?: string): Promise<void> {
  const configPath = resolve(configArg ?? "cascet.config.json");
  if (!existsSync(configPath)) {
    throw new CliError(`config not found: ${configPath}\n   Run "cascet init" to create one.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new CliError(`${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = cascetConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliError(`invalid config ${configPath}:\n${formatConfigIssues(parsed.error.issues)}`);
  }
  const cfg = parsed.data;
  for (const warning of wrapWarnings(cfg)) console.error(`[cascet] ${warning}`);

  // Loaded lazily so buyers (connect, account-hash) never load the gateway stack.
  const { startGateway } = await import("@cascet/gateway");
  const gateway = await startGateway(cfg);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void gateway.close().finally(() => process.exit(0)));
  }
}

/** `cascet connect <gateway mcp url>`: stdio bridge that pays x402 challenges within mandatory limits. */
async function connect(args: ParsedArgs): Promise<void> {
  const cfg = resolveConnectConfig({
    url: args.positionals[0],
    env: process.env,
    flags: args.flags,
    cwd: process.cwd(),
    home: homedir(),
  });
  readPinFile(cfg.bridge.toolPins.path); // fail before starting on an unreadable pin file
  for (const notice of cfg.notices) console.error(notice);
  const paying = await createPayingFetch({
    ...cfg.paying,
    onPayment: info =>
      console.error(
        `[cascet] 💸 authorized ${info.amountRaw} raw units of ${info.asset.slice(0, 10)}… → ${info.payTo.slice(0, 12)}…`,
      ),
  });
  console.error(cfg.summary);
  await runBridge(cfg.url, paying, cfg.bridge);
}

/** `cascet account-hash <public key>`: print the "00"-prefixed payTo for a Casper public key. */
function accountHash(publicKey?: string): void {
  if (!publicKey) throw new CliError("usage: cascet account-hash <public-key-hex>");
  console.log(accountHashFromPublicKey(publicKey));
  console.error('[cascet] use this value as "payTo" in cascet.config.json, and buyers use it in CASCET_ALLOWED_PAYTO.');
}

/** `cascet init [name]`: write a starter config. */
function init(name = "my-paid-mcp"): void {
  const path = resolve("cascet.config.json");
  if (existsSync(path)) throw new CliError(`${path} already exists`);
  writeFileSync(path, `${JSON.stringify(initTemplate(name), null, 2)}\n`, { flag: "wx" });
  console.log(`✅ wrote ${path}\n`);
  console.log(initNextSteps());
}

function help(): void {
  console.log(`CasCet: monetize MCP servers with x402 micropayments on Casper

usage:
  cascet init [name]                  create a starter cascet.config.json
  cascet wrap [config]                start the paid gateway (default: ./cascet.config.json)
  cascet connect <mcp-url> [flags]    stdio bridge for MCP hosts; pays per call within your limits
  cascet account-hash <public-key>    print the payTo value ("00" + account hash) for a public key
  cascet --version | --help

connect env vars:
  CASCET_KEY_PATH                 PEM private key of the paying wallet (required; prefer an absolute path)
  CASCET_KEY_ALGO                 ed25519 | secp256k1 (default ed25519)
  CASCET_NETWORK                  comma-separated CAIP-2 networks to pay on (default casper:casper-test;
                                  add casper:casper for mainnet)
  CASCET_ALLOWED_PAYTO            comma-separated payTo account hashes to pay (required*)
  CASCET_ALLOWED_ASSETS           comma-separated CEP-18 package hashes to pay in (required*)
  CASCET_MAX_PER_CALL             largest single payment, raw token units (required**)
  CASCET_MAX_SESSION              session total per token, raw token units (required**)
  CASCET_TIMEOUT_MS               deadline per call in ms (default 30000)
  CASCET_TOOL_PINS                tool pin file (default ~/.cascet/tool-pins.json)
  CASCET_ALLOW_ANY_SELLER=1       same as --allow-any-seller
  CASCET_ALLOW_UNLIMITED_BUDGET=1 same as --allow-unlimited-budget

connect flags:
  --allow-any-seller              * run without the payTo/asset allowlists (not recommended)
  --allow-unlimited-budget        ** run without the per-call/session limits (not recommended)
  --accept-tool-changes           trust and re-pin tool definitions that changed since they were pinned

Set CASCET_DEBUG=1 to print stack traces.`);
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function fail(err: unknown): never {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  if (process.env.CASCET_DEBUG && err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
}
