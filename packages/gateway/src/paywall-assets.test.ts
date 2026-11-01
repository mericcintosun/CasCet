import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { ExactCasperScheme } from "@x402/casper/exact/client";
import casperSdk from "casper-js-sdk";
import { DEFAULT_FACILITATOR_URL, type CascetConfig } from "@cascet/core";
import {
  assetAmountFor,
  buildToolTable,
  createPaymentRail,
  gatewayAssets,
  gatewayTimeouts,
  maxTimeoutSecondsFor,
  requiredValiditySeconds,
  resolveToolPolicy,
  type PaymentRail,
} from "./paywall.js";
import { startFakeFacilitator } from "./testing/fake-facilitator.js";
import {
  ASSET,
  callPaid,
  challengeOf,
  LEGACY_PRICE_RAW,
  LEGACY_TOKEN,
  receipts,
  startHarness,
  testConfig,
  twoAssetConfig,
  WCSPR_PRICE_RAW,
  WCSPR_TOKEN,
} from "./testing/harness.js";

const LEGACY_TESTNET = LEGACY_TOKEN;
const testAsset = { packageHash: `hash-${ASSET}`, name: "Test Token", symbol: "TST", decimals: 9, version: "1", tokensPerUsd: 50 };

interface SeenRequest {
  url: string;
  path: string;
  authorization: string | null;
  body?: Record<string, unknown>;
}

/**
 * A fetch that plays every facilitator in memory: /supported answers "exact"
 * on casper-test (unless `supported` says otherwise for that origin), verify
 * and settle succeed. Records every request; never touches the network.
 */
function memoryFacilitators(supported: (origin: string) => unknown = () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: "casper:casper-test" }] })) {
  const seen: SeenRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    seen.push({ url: url.href, path: url.pathname, authorization: new Headers(init?.headers).get("authorization"), body });
    const json =
      url.pathname === "/supported"
        ? supported(url.origin)
        : url.pathname === "/verify"
          ? { isValid: true }
          : { success: true, transaction: "ab".repeat(32), network: "casper:casper-test" };
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { seen, fetch: fetchImpl };
}

/** A fetch that fails the test if anything calls it. */
const noFetch = (async () => {
  throw new Error("no facilitator may be contacted");
}) as typeof fetch;

const SELF = "http://127.0.0.1:4501";
const CEP = "http://127.0.0.1:4502";

describe("accepts entries carry the asset's authorization style", () => {
  it("assetAmountFor builds the x402 price with the EIP-712 domain, display fields and style", () => {
    const cfg = testConfig();
    assert.deepEqual(assetAmountFor(cfg.asset, "500000000"), {
      asset: ASSET,
      amount: "500000000",
      extra: { name: "Test Token", symbol: "TST", version: "1", decimals: "9", authorizationStyle: "cep3009-value" },
    });
  });

  it("the 402 challenge advertises cep3009-value for a CEP-3009 token and legacy-amount for CasCet's token", async () => {
    const cep = await startHarness();
    try {
      const challenge = challengeOf(await cep.rpc("tools/call", { name: "paid_tool", arguments: {} }));
      assert.equal(challenge.accepts.length, 1);
      assert.equal(challenge.accepts[0]?.extra?.authorizationStyle, "cep3009-value");
    } finally {
      await cep.close();
    }
    const legacy = await startHarness({
      config: { asset: { ...testAsset, packageHash: `hash-${LEGACY_TESTNET}`, name: "CasCet X402 Token", symbol: "WCSPR" } },
    });
    try {
      const challenge = challengeOf(await legacy.rpc("tools/call", { name: "paid_tool", arguments: {} }));
      assert.equal(challenge.accepts[0]?.asset, LEGACY_TESTNET);
      assert.equal(challenge.accepts[0]?.extra?.authorizationStyle, "legacy-amount");
    } finally {
      await legacy.close();
    }
  });
});

describe("the payment rail uses the asset's own facilitator", () => {
  it("sends a named facilitator's key with its auth scheme and never contacts the unused default", async () => {
    const fake = await startFakeFacilitator();
    try {
      const cfg = testConfig({
        asset: undefined,
        assets: [{ ...testAsset, facilitator: "self" }],
        facilitator: { url: "http://127.0.0.1:9" },
        facilitators: { self: { url: fake.url, apiKey: "secret-token", authScheme: "bearer" } },
      });
      const rail = await createPaymentRail(cfg);
      assert.deepEqual(
        rail.assets.map(asset => asset.packageHash),
        [ASSET],
      );
      assert.deepEqual(
        fake.calls.map(call => [call.op, call.authorization]),
        [["supported", "Bearer secret-token"]],
      );
    } finally {
      await fake.close();
    }
  });

  it("sends the raw key by default (what the hosted facilitator expects)", async () => {
    const fake = await startFakeFacilitator();
    try {
      await createPaymentRail(testConfig({ facilitator: { url: fake.url, apiKey: "cspr-cloud-key" } }));
      assert.equal(fake.calls[0]?.authorization, "cspr-cloud-key");
    } finally {
      await fake.close();
    }
  });

  it("routes two assets to their two facilitators: one /supported call each, each with its own key and scheme", async () => {
    const memory = memoryFacilitators();
    const rail = await createPaymentRail(twoAssetConfig(SELF, CEP), { fetch: memory.fetch });
    assert.deepEqual(
      rail.assets.map(asset => [asset.id, asset.packageHash, asset.authorization, asset.facilitator]),
      [
        ["cascet", LEGACY_TOKEN, "legacy-amount", "self"],
        ["wcspr", WCSPR_TOKEN, "cep3009-value", "default"],
      ],
    );
    assert.deepEqual(
      memory.seen.map(request => [request.url, request.authorization]).sort(),
      [
        [`${SELF}/supported`, "Bearer self-key"],
        [`${CEP}/supported`, "cep-key"],
      ],
    );
  });

  it("asks a facilitator that settles several assets for its kinds once", async () => {
    const memory = memoryFacilitators();
    const cfg = testConfig({
      asset: undefined,
      assets: [
        { id: "cascet", packageHash: `hash-${LEGACY_TOKEN}`, name: "CasCet X402 Token", symbol: "CASCET" },
        { id: "wcspr", packageHash: `hash-${WCSPR_TOKEN}`, name: "Wrapped CSPR", symbol: "WCSPR", tokensPerUsd: 20 },
      ],
      facilitator: { url: CEP, apiKey: "cep-key" },
    });
    const rail = await createPaymentRail(cfg, { fetch: memory.fetch });
    assert.equal(rail.assets.length, 2);
    assert.deepEqual(
      memory.seen.map(request => request.url),
      [`${CEP}/supported`],
    );
  });

  it("sizes the signing window with a facilitator's own timeout", () => {
    const own = testConfig({ facilitator: { url: "http://127.0.0.1:9", timeoutMs: 120_000 }, timeouts: { upstreamMs: 60_000 } });
    assert.deepEqual(gatewayTimeouts(own), { facilitatorMs: 120_000, settleMs: 120_000, upstreamMs: 60_000 });
    assert.equal(requiredValiditySeconds(own, false), 120 + 60 + 30);
    assert.equal(maxTimeoutSecondsFor(own), 120 + 60 + 120 + 30);
    assert.deepEqual(gatewayTimeouts(testConfig()), { facilitatorMs: 15_000, settleMs: 90_000, upstreamMs: 60_000 });
  });

  it("sizes the signing window with the slowest of several facilitators, so it holds in every asset", () => {
    const cfg = twoAssetConfig(SELF, CEP, {
      facilitators: { self: { url: SELF, apiKey: "self-key", authScheme: "bearer", timeoutMs: 120_000 } },
    });
    assert.deepEqual(gatewayTimeouts(cfg), { facilitatorMs: 120_000, settleMs: 120_000, upstreamMs: 60_000 });
    assert.equal(maxTimeoutSecondsFor(cfg), 120 + 60 + 120 + 30);
  });
});

describe("startup refuses what could never settle, even in a config built in code", () => {
  const valid = () => twoAssetConfig(SELF, CEP);

  it("refuses a legacy-amount token routed to the hosted facilitator before any facilitator is contacted", async () => {
    const cfg = valid();
    const hosted = { ...cfg, facilitators: { ...cfg.facilitators, self: { url: DEFAULT_FACILITATOR_URL, authScheme: "raw" as const } } };
    await assert.rejects(createPaymentRail(hosted, { fetch: noFetch }), /asset "cascet" is a legacy-amount token.*hosted.*64658/);
  });

  it("refuses the bearer scheme on the hosted facilitator", async () => {
    const cfg = valid();
    const bearer = {
      ...cfg,
      facilitator: { url: DEFAULT_FACILITATOR_URL, apiKey: "k", authScheme: "bearer" as const },
      facilitators: { ...cfg.facilitators, default: { url: DEFAULT_FACILITATOR_URL, apiKey: "k", authScheme: "bearer" as const } },
    };
    await assert.rejects(createPaymentRail(bearer, { fetch: noFetch }), /facilitator "default" is the hosted one.*authScheme "raw"/);
  });

  it("refuses a known legacy token declared cep3009-value, duplicate tokens and malformed hashes", () => {
    const cfg = valid();
    const [legacy, wcspr] = cfg.assets;
    const patch = (assets: unknown[]) => ({ ...cfg, assets }) as CascetConfig;
    assert.throws(() => gatewayAssets(patch([{ ...legacy, authorization: "cep3009-value" }, wcspr])), /CasCet's x402 token.*"legacy-amount"/);
    assert.throws(() => gatewayAssets(patch([legacy, { ...wcspr, packageHash: `hash-${LEGACY_TOKEN.toUpperCase()}` }])), /listed twice/);
    assert.throws(() => gatewayAssets(patch([legacy, { ...wcspr, id: "cascet" }])), /asset id "cascet" is used twice/);
    assert.throws(() => gatewayAssets(patch([legacy, { ...wcspr, packageHash: "hash-abc" }])), /packageHash must be 64 hex/);
    assert.throws(() => gatewayAssets(patch([])), /lists no asset/);
    assert.deepEqual(
      gatewayAssets(patch([legacy, { ...wcspr, packageHash: `hash-${WCSPR_TOKEN.toUpperCase()}` }])).map(asset => asset.packageHash),
      [LEGACY_TOKEN, WCSPR_TOKEN],
      "hashes come back bare and lower-case",
    );
  });

  it("refuses a price that rounds to zero in one of its assets, naming the price and the asset", async () => {
    const cfg = twoAssetConfig(SELF, CEP, {
      assets: [
        { id: "cascet", packageHash: `hash-${LEGACY_TOKEN}`, name: "CasCet X402 Token", symbol: "CASCET", decimals: 9, facilitator: "self" },
        { id: "wcspr", packageHash: `hash-${WCSPR_TOKEN}`, name: "Wrapped CSPR", symbol: "WCSPR", decimals: 0, tokensPerUsd: 20 },
      ],
    });
    await assert.rejects(createPaymentRail(cfg, { fetch: noFetch }), /pricing\.tools\.paid_tool: asset "wcspr": price \$0\.01 rounds to 0/);
  });

  it("refuses a price that accepts none of the configured assets", async () => {
    const cfg = valid();
    const orphan = { ...cfg, pricing: { ...cfg.pricing, tools: { paid_tool: { price: "$0.01", settleBeforeExecute: false, assets: ["gone"] } } } };
    await assert.rejects(createPaymentRail(orphan, { fetch: noFetch }), /pricing\.tools\.paid_tool: price \$0\.01 accepts none of the configured assets/);
  });
});

describe("a facilitator that cannot serve its asset stops the gateway", () => {
  it("names the facilitator that does not support the network", async () => {
    const memory = memoryFacilitators(origin =>
      origin === SELF ? { kinds: [{ x402Version: 2, scheme: "exact", network: "casper:casper" }] } : { kinds: [{ x402Version: 2, scheme: "exact", network: "casper:casper-test" }] },
    );
    await assert.rejects(
      createPaymentRail(twoAssetConfig(SELF, CEP), { fetch: memory.fetch }),
      new RegExp(`facilitator "self" \\(${SELF.replace(/\./g, "\\.")}\\) does not support x402 v2 "exact" payments on casper:casper-test, which asset ${LEGACY_TOKEN} needs`),
    );
  });

  it("names the facilitator whose /supported fails", async () => {
    const failing = (async (input: string | URL | Request) => {
      if (String(input).startsWith(SELF)) return new Response("down", { status: 503 });
      return new Response(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "casper:casper-test" }] }), { status: 200 });
    }) as typeof fetch;
    await assert.rejects(createPaymentRail(twoAssetConfig(SELF, CEP), { fetch: failing }), /supported payment kinds.*facilitator "self".*HTTP 503/);
  });
});

describe("the tool table offers every accepted asset", () => {
  async function table(input: Record<string, unknown> = {}, tools = ["paid_tool", "wcspr_only", "anything"]) {
    const memory = memoryFacilitators();
    const cfg = twoAssetConfig(SELF, CEP, input);
    const rail: PaymentRail = await createPaymentRail(cfg, { fetch: memory.fetch });
    return { cfg, rail, table: buildToolTable(cfg, rail, tools.map(name => ({ name, inputSchema: { type: "object" as const } }))) };
  }

  it("prices a tool in each accepted asset, in config order, with that asset's own conversion", async () => {
    const { cfg } = await table();
    const policy = resolveToolPolicy(cfg, "paid_tool");
    assert.equal(policy?.kind, "paid");
    assert.deepEqual(
      policy?.kind === "paid" ? policy.accepts.map(entry => [entry.asset.id, entry.amount]) : [],
      [
        ["cascet", LEGACY_PRICE_RAW],
        ["wcspr", WCSPR_PRICE_RAW],
      ],
    );
  });

  it("builds one accepts entry per accepted asset, and honours pricing.tools.<name>.assets and pricing.default.assets", async () => {
    const { table: built } = await table({
      pricing: {
        default: { price: "$0.02", assets: ["cascet"] },
        tools: { paid_tool: { price: "$0.01" }, wcspr_only: { price: "$0.01", assets: ["wcspr"] } },
        freeTools: [],
      },
    });
    const accepts = async (tool: string) => {
      const processed = await built.http.processHTTPRequest({
        adapter: {
          getHeader: () => undefined,
          getMethod: () => "POST",
          getPath: () => built.routeFor(tool),
          getUrl: () => `http://127.0.0.1${built.routeFor(tool)}`,
          getAcceptHeader: () => "application/json",
          getUserAgent: () => "test",
        },
        path: built.routeFor(tool),
        method: "POST",
      });
      assert.equal(processed.type, "payment-error");
      const header = processed.type === "payment-error" ? processed.response.headers["PAYMENT-REQUIRED"] : undefined;
      assert.ok(header, "a 402 challenge");
      return decodePaymentRequiredHeader(header).accepts as unknown as Array<Record<string, unknown>>;
    };
    const both = await accepts("paid_tool");
    assert.deepEqual(
      both.map(entry => [entry.asset, entry.amount, (entry.extra as Record<string, unknown>).authorizationStyle]),
      [
        [LEGACY_TOKEN, LEGACY_PRICE_RAW, "legacy-amount"],
        [WCSPR_TOKEN, WCSPR_PRICE_RAW, "cep3009-value"],
      ],
    );
    assert.deepEqual(both[1]?.extra, { name: "Wrapped CSPR", symbol: "WCSPR", version: "1", decimals: "9", authorizationStyle: "cep3009-value" });
    assert.deepEqual(
      (await accepts("wcspr_only")).map(entry => entry.asset),
      [WCSPR_TOKEN],
    );
    assert.deepEqual(
      (await accepts("anything")).map(entry => [entry.asset, entry.amount]),
      [[LEGACY_TOKEN, "1000000000"]],
    );
  });
});

describe("@x402 2.29 buyers pay a CasCet gateway", () => {
  it("a payment made by @x402/casper's client scheme matches the 402 (style echoed) and settles", async () => {
    const h = await startHarness();
    try {
      const key = casperSdk.PrivateKey.generate(casperSdk.KeyAlgorithm.ED25519);
      const signer = {
        accountAddress: () => `00${key.publicKey.accountHash().toHex()}`,
        publicKey: () => key.publicKey.toHex(),
        signEIP712: async (digest: Uint8Array) => key.signAndAddAlgorithmBytes(digest),
      };
      const client = new x402Client()
        .register("casper:casper-test", new ExactCasperScheme(signer))
        .setSpendControls({ allowedAssets: true, maxAmountPerPayment: false });
      const paymentRequired = challengeOf(await h.rpc("tools/call", { name: "paid_tool", arguments: {} }));
      const payment = await client.createPaymentPayload(paymentRequired);
      assert.equal(payment.accepted.extra?.authorizationStyle, "cep3009-value", "the buyer echoes the server-owned style");
      const paid = await callPaid(h, "paid_tool", encodePaymentSignatureHeader(payment));
      assert.equal(paid.status, 200, JSON.stringify(paid.body));
      assert.equal(h.facilitator.count("settle"), 1);
      const [receipt] = await receipts(h);
      assert.equal(receipt?.status, "settled");
      assert.equal(receipt?.payer, signer.accountAddress());
    } finally {
      await h.close();
    }
  });
});
