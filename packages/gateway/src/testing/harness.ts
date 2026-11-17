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
  h: Harness,
  tool: string,
  overrides: PaymentOverrides = {},
): Promise<{ header: string; nonce: string; accepted: PaymentRequirements }> {
  const unpaid = await h.rpc("tools/call", { name: tool, arguments: {} });
  if (unpaid.status !== 402) throw new Error(`expected a 402 challenge for ${tool}, got HTTP ${unpaid.status}`);
  const accepted = challengeOf(unpaid).accepts[0];
  if (!accepted) throw new Error("challenge has no accepts");
  return { ...paymentHeader(accepted, overrides), accepted };
}

export function callPaid(h: Harness, tool: string, header: string, extraHeaders: Record<string, string> = {}): Promise<RpcResponse> {
  return h.rpc("tools/call", { name: tool, arguments: {} }, { "payment-signature": header, ...extraHeaders });
}

export async function receipts(h: Harness): Promise<Array<Record<string, unknown>>> {
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
