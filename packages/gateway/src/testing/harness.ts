import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import casperSdk from "casper-js-sdk";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { cascetConfigSchema, type CascetConfig } from "@cascet/core";
import { startGateway, type GatewayOptions, type RunningGateway } from "../server.js";
import { startFakeFacilitator, type FakeFacilitator } from "./fake-facilitator.js";
import { createFakeUpstream, type FakeTool, type FakeUpstream } from "./fake-upstream.js";

export const PAY_TO = `00${"11".repeat(32)}`;
export const ASSET = "22".repeat(32);
/** Placeholder ed25519 public key of the test buyer (the fake facilitator checks no signature). */
export const PAYER_PUBLIC_KEY = `01${"44".repeat(32)}`;
/** The test buyer's account address: "00" + the account hash of PAYER_PUBLIC_KEY. */
export const PAYER = `00${casperSdk.PublicKey.fromHex(PAYER_PUBLIC_KEY).accountHash().toHex()}`;
/** $0.01 at 50 tokens/USD with 9 decimals. */
export const PRICE_RAW = "500000000";

/** Parse a gateway config the same way `cascet wrap` does, with test defaults. */
export function testConfig(input: Record<string, unknown> = {}): CascetConfig {
  return cascetConfigSchema.parse({
    name: "test-gateway",
    upstream: { type: "stdio", command: "node", args: [] },
    network: "casper:casper-test",
    payTo: PAY_TO,
    asset: { packageHash: `hash-${ASSET}`, name: "Test Token", symbol: "TST", decimals: 9, version: "1", tokensPerUsd: 50 },
    facilitator: { url: "http://127.0.0.1:9" },
    pricing: { tools: { paid_tool: { price: "$0.01" } }, freeTools: ["free_tool"] },
    port: 0,
    ...input,
  });
}

export interface Harness {
  gateway: RunningGateway;
  facilitator: FakeFacilitator;
  upstream: FakeUpstream;
  /** Ordered "verify" / "settle" / "exec:<tool>" events. */
  events: string[];
  /** Gateway base URL (without /mcp). */
  base: string;
  receiptsPath: string;
  rpc(method: string, params?: Record<string, unknown>, headers?: Record<string, string>): Promise<RpcResponse>;
  close(): Promise<void>;
}

export interface RpcResponse {
  status: number;
  headers: Headers;
  body: {
    jsonrpc?: string;
    id?: unknown;
    result?: Record<string, unknown> & { content?: Array<{ type: string; text?: string }>; tools?: Array<{ name: string }> };
    error?: { code: number; message: string; data?: Record<string, unknown> };
  };
}

let nextId = 1;

export async function rpcCall(
  url: string,
  method: string,
  params?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<RpcResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? (JSON.parse(text) as RpcResponse["body"]) : {} };
}

export async function startHarness(
  opts: {
    config?: Record<string, unknown>;
    tools?: FakeTool[];
    pageSize?: number;
    gateway?: GatewayOptions;
    /** Adjust the fake upstream before the gateway connects to it. */
    onUpstream?: (upstream: FakeUpstream) => void;
  } = {},
): Promise<Harness> {
  const events: string[] = [];
  const facilitator = await startFakeFacilitator({ events });
  const upstream = createFakeUpstream({
    tools: opts.tools ?? [{ name: "paid_tool" }, { name: "free_tool" }, { name: "secret_tool" }],
    pageSize: opts.pageSize,
    events,
  });
  opts.onUpstream?.(upstream);
  const dir = mkdtempSync(join(tmpdir(), "cascet-gateway-test-"));
  const receiptsPath = join(dir, "receipts.jsonl");
  const cfg = testConfig({ facilitator: { url: facilitator.url }, ...opts.config });
  let gateway: RunningGateway;
  try {
    gateway = await startGateway(cfg, {
      createUpstreamTransport: () => upstream.createTransport(),
      receiptsPath,
      preemptionChecker: null,
      ...opts.gateway,
    });
  } catch (err) {
    await facilitator.close();
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    gateway,
    facilitator,
    upstream,
    events,
    base: gateway.url.replace(/\/mcp$/, ""),
    receiptsPath,
    rpc: (method, params, headers) => rpcCall(gateway.url, method, params, headers),
    close: async () => {
      await gateway.close();
      await facilitator.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** CasCet's x402 token on testnet: its transfer_with_authorization takes `amount` (legacy-amount). */
export const LEGACY_TOKEN = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
/** The official Wrapped CSPR on testnet: CEP-3009, takes `value` (cep3009-value). */
export const WCSPR_TOKEN = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";
/** $0.01 of the legacy token at 50 tokens/USD, 9 decimals. */
export const LEGACY_PRICE_RAW = "500000000";
/** $0.01 of Wrapped CSPR at 20 tokens/USD, 9 decimals. */
export const WCSPR_PRICE_RAW = "200000000";
/** Settlement transaction hashes of the two fake facilitators. */
export const LEGACY_SETTLE_TX = "1e".repeat(32);
export const WCSPR_SETTLE_TX = "3c".repeat(32);

/**
 * A gateway config that sells in two tokens, one per authorization style, each
 * settled by its own facilitator: the legacy token (first, so preferred) by a
 * self-hosted facilitator named "self" (bearer key), Wrapped CSPR by the
 * default facilitator (raw key).
 */
export function twoAssetConfig(legacyUrl: string, cepUrl: string, input: Record<string, unknown> = {}): CascetConfig {
  return testConfig({
    asset: undefined,
    assets: [
      {
        id: "cascet",
        packageHash: `hash-${LEGACY_TOKEN}`,
        name: "CasCet X402 Token",
        symbol: "CASCET",
        decimals: 9,
        version: "1",
        tokensPerUsd: 50,
        facilitator: "self",
      },
      { id: "wcspr", packageHash: `hash-${WCSPR_TOKEN}`, name: "Wrapped CSPR", symbol: "WCSPR", decimals: 9, version: "1", tokensPerUsd: 20 },
    ],
    facilitator: { url: cepUrl, apiKey: "cep-key" },
    facilitators: { self: { url: legacyUrl, apiKey: "self-key", authScheme: "bearer" } },
    ...input,
  });
}

export interface TwoAssetHarness extends Omit<Harness, "facilitator"> {
  /** Facilitator of the legacy-amount token. Its events are "legacy:verify" / "legacy:settle". */
  legacy: FakeFacilitator;
  /** Facilitator of the cep3009-value token. Its events are "cep:verify" / "cep:settle". */
  cep: FakeFacilitator;
}

/** A gateway built from {@link twoAssetConfig}, with one fake facilitator per token. */
export async function startTwoAssetHarness(
  opts: {
    /** Config overrides; a function receives the URLs of the two fake facilitators. */
    config?: Record<string, unknown> | ((urls: { legacy: string; cep: string }) => Record<string, unknown>);
    tools?: FakeTool[];
    gateway?: GatewayOptions;
    /** Adjust the fake facilitators before the gateway starts (e.g. what /supported answers). */
    onFacilitators?: (facilitators: { legacy: FakeFacilitator; cep: FakeFacilitator }) => void;
  } = {},
): Promise<TwoAssetHarness> {
  const events: string[] = [];
  const legacy = await startFakeFacilitator({ events, label: "legacy", settleTx: LEGACY_SETTLE_TX });
  const cep = await startFakeFacilitator({ events, label: "cep", settleTx: WCSPR_SETTLE_TX });
  opts.onFacilitators?.({ legacy, cep });
  const upstream = createFakeUpstream({
    tools: opts.tools ?? [{ name: "paid_tool" }, { name: "free_tool" }, { name: "secret_tool" }],
    events,
  });
  const dir = mkdtempSync(join(tmpdir(), "cascet-gateway-test-"));
  const receiptsPath = join(dir, "receipts.jsonl");
  const input = typeof opts.config === "function" ? opts.config({ legacy: legacy.url, cep: cep.url }) : opts.config;
  let gateway: RunningGateway;
  try {
    gateway = await startGateway(twoAssetConfig(legacy.url, cep.url, input), {
      createUpstreamTransport: () => upstream.createTransport(),
      receiptsPath,
      preemptionChecker: null,
      ...opts.gateway,
    });
  } catch (err) {
    await legacy.close();
    await cep.close();
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    gateway,
    legacy,
    cep,
    upstream,
    events,
    base: gateway.url.replace(/\/mcp$/, ""),
    receiptsPath,
    rpc: (method, params, headers) => rpcCall(gateway.url, method, params, headers),
    close: async () => {
      await gateway.close();
      await legacy.close();
      await cep.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Ask for the tool unpaid, then build a payment for its accepts entry in `asset`. */
export async function payInAsset(
  h: Pick<Harness, "rpc">,
  tool: string,
  asset: string,
  overrides: PaymentOverrides = {},
): Promise<{ header: string; nonce: string; accepted: PaymentRequirements }> {
  const unpaid = await h.rpc("tools/call", { name: tool, arguments: {} });
  if (unpaid.status !== 402) throw new Error(`expected a 402 challenge for ${tool}, got HTTP ${unpaid.status}`);
  const accepted = challengeOf(unpaid).accepts.find(entry => entry.asset === asset);
  if (!accepted) throw new Error(`the challenge for ${tool} has no entry in ${asset}`);
  return { ...paymentHeader(accepted, overrides), accepted };
}

/** Decode the PAYMENT-REQUIRED header of a 402 answer. */
export function challengeOf(response: RpcResponse): PaymentRequired {
  const header = response.headers.get("payment-required");
  if (!header) throw new Error(`no PAYMENT-REQUIRED header (HTTP ${response.status})`);
  return decodePaymentRequiredHeader(header);
}

export interface PaymentOverrides {
  signature?: string;
  publicKey?: string;
  from?: string;
  to?: string;
  value?: string;
  nonce?: string;
  validAfter?: number;
  validBefore?: number;
}

/**
 * A PAYMENT-SIGNATURE header for `accepted`. The fake facilitator does not
 * check signatures, so the signature is a placeholder; the public key does
 * hash to PAYER, as the gateway's local checks require.
 */
export function paymentHeader(accepted: PaymentRequirements, overrides: PaymentOverrides = {}): { header: string; nonce: string } {
  const now = Math.floor(Date.now() / 1_000);
  const nonce = overrides.nonce ?? randomBytes(32).toString("hex");
  const header = encodePaymentSignatureHeader({
    x402Version: 2,
    accepted,
    payload: {
      signature: overrides.signature ?? `01${"00".repeat(64)}`,
      publicKey: overrides.publicKey ?? PAYER_PUBLIC_KEY,
      authorization: {
        from: overrides.from ?? PAYER,
        to: overrides.to ?? accepted.payTo,
        value: overrides.value ?? accepted.amount,
        validAfter: String(overrides.validAfter ?? now - 600),
        validBefore: String(overrides.validBefore ?? now + accepted.maxTimeoutSeconds),
        nonce,
      },
    },
  });
  return { header, nonce };
}

/** Ask for the tool unpaid, then build a payment for its first accepted requirement. */
export async function payFor(
  h: Pick<Harness, "rpc">,
  tool: string,
  overrides: PaymentOverrides = {},
): Promise<{ header: string; nonce: string; accepted: PaymentRequirements }> {
  const unpaid = await h.rpc("tools/call", { name: tool, arguments: {} });
  if (unpaid.status !== 402) throw new Error(`expected a 402 challenge for ${tool}, got HTTP ${unpaid.status}`);
  const accepted = challengeOf(unpaid).accepts[0];
  if (!accepted) throw new Error("challenge has no accepts");
  return { ...paymentHeader(accepted, overrides), accepted };
}

export function callPaid(
  h: Pick<Harness, "rpc">,
  tool: string,
  header: string,
  extraHeaders: Record<string, string> = {},
): Promise<RpcResponse> {
  return h.rpc("tools/call", { name: tool, arguments: {} }, { "payment-signature": header, ...extraHeaders });
}

export async function receipts(h: Pick<Harness, "base">): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${h.base}/receipts`);
  return ((await response.json()) as { receipts: Array<Record<string, unknown>> }).receipts;
}

/** Poll until `check` passes or the timeout expires. */
export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 3_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
