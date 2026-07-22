#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { cascetConfigSchema, DEFAULT_FACILITATOR_URL, NETWORK_CASPER_TESTNET } from "@cascet/core";
import { startGateway } from "@cascet/gateway";
import { createPayingFetch, runBridge } from "@cascet/client";

const [, , command, ...rest] = process.argv;

switch (command) {
  case "wrap":
    await wrap(rest[0]);
    break;
  case "connect":
    await connect(rest[0]);
    break;
  case "init":
    init(rest[0]);
    break;
  default:
    help();
    process.exit(command ? 1 : 0);
}

/** `cascet wrap [config path]` — start a paid-MCP gateway in front of the configured upstream. */
async function wrap(configArg?: string): Promise<void> {
  const configPath = resolve(configArg ?? "cascet.config.json");
  if (!existsSync(configPath)) {
    console.error(`❌ config not found: ${configPath}\n   Run "cascet init" to create one.`);
    process.exit(1);
  }
  const cfg = cascetConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  const gateway = await startGateway(cfg);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void gateway.close().finally(() => process.exit(0)));
  }
}

/** `cascet connect <gateway mcp url>` — stdio bridge that pays x402 challenges transparently. */
async function connect(url?: string): Promise<void> {
  if (!url) {
    console.error("❌ usage: cascet connect <gateway-mcp-url>");
    process.exit(1);
  }
  const keyPath = process.env.CASCET_KEY_PATH;
  if (!keyPath) {
    console.error("❌ CASCET_KEY_PATH env var (PEM private key path) is required");
    process.exit(1);
  }
  // A remote gateway over plain http:// can be MITM'd to inject a 402 that
  // redirects your payment to an attacker. Require TLS off-localhost.
  try {
    const u = new URL(url);
    const isLocal = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
    if (u.protocol === "http:" && !isLocal) {
      console.error(`❌ refusing insecure http:// to remote host ${u.hostname} — use https:// (a MITM could redirect your payment).`);
      process.exit(1);
    }
  } catch {
    console.error(`❌ invalid gateway URL: ${url}`);
    process.exit(1);
  }
  const splitEnv = (v?: string) => v?.split(",").map(s => s.trim()).filter(Boolean);
  const paying = await createPayingFetch({
    privateKeyPath: keyPath,
    keyAlgorithm: process.env.CASCET_KEY_ALGO === "secp256k1" ? "secp256k1" : "ed25519",
    budget: {
      maxPerCallRaw: process.env.CASCET_MAX_PER_CALL,
      maxSessionRaw: process.env.CASCET_MAX_SESSION,
    },
    allowedPayTo: splitEnv(process.env.CASCET_ALLOWED_PAYTO),
    allowedAssets: splitEnv(process.env.CASCET_ALLOWED_ASSETS),
    onPayment: info =>
      console.error(`[cascet] 💸 authorized ${info.amountRaw} raw units → ${info.payTo.slice(0, 10)}…`),
  });
  console.error(`[cascet] bridge up → ${url} (budget: per-call=${process.env.CASCET_MAX_PER_CALL ?? "∞"}, session=${process.env.CASCET_MAX_SESSION ?? "∞"})`);
  await runBridge(url, paying);
}

/** `cascet init [name]` — write a starter config. */
function init(name = "my-paid-mcp"): void {
  const path = resolve("cascet.config.json");
  if (existsSync(path)) {
    console.error(`❌ ${path} already exists`);
    process.exit(1);
  }
  const template = {
    name,
    upstream: { type: "stdio", command: "node", args: ["./my-mcp-server.js"] },
    network: NETWORK_CASPER_TESTNET,
    payTo: "<your Casper public key>",
    asset: {
      packageHash: "<CEP-18 package hash>",
      name: "Wrapped CSPR",
      symbol: "WCSPR",
      decimals: 9,
      version: "1",
      tokensPerUsd: 50,
    },
    facilitator: { url: DEFAULT_FACILITATOR_URL, apiKey: "<CSPR.cloud access token>" },
    pricing: { tools: { my_tool: { price: "$0.01", description: "example priced tool" } } },
    port: 4402,
  };
  writeFileSync(path, `${JSON.stringify(template, null, 2)}\n`);
  console.log(`✅ wrote ${path} — fill in payTo, asset.packageHash and facilitator.apiKey`);
}

function help(): void {
  console.log(`CasCet — monetize MCP servers with x402 micropayments on Casper

usage:
  cascet init [name]              create a starter cascet.config.json
  cascet wrap [config]            start the paid gateway (default: ./cascet.config.json)
  cascet connect <mcp-url>        stdio bridge for MCP hosts; pays per call

connect env vars:
  CASCET_KEY_PATH                 PEM private key path (required)
  CASCET_KEY_ALGO                 ed25519 | secp256k1 (default ed25519)
  CASCET_MAX_PER_CALL             per-call budget in raw token units
  CASCET_MAX_SESSION              session budget in raw token units (per asset)
  CASCET_ALLOWED_PAYTO            comma-separated payTo allowlist (pin your sellers)
  CASCET_ALLOWED_ASSETS           comma-separated CEP-18 package-hash allowlist`);
}
