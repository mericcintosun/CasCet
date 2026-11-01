import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import casperSdk from "casper-js-sdk";
import { x402Client } from "@x402/core/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { x402HTTPResourceServer } from "@x402/core/server";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactCasperScheme } from "@x402/casper/exact/client";
import { DEFAULT_FACILITATOR_URL, type CascetConfig } from "@cascet/core";
import type { PreemptionQuery, SettlementPreemptionChecker } from "./preemption.js";
import { startGateway } from "./server.js";
import { startFakeFacilitator } from "./testing/fake-facilitator.js";
import { createFakeUpstream } from "./testing/fake-upstream.js";
import {
  callPaid,
  challengeOf,
  LEGACY_PRICE_RAW,
  LEGACY_SETTLE_TX,
  LEGACY_TOKEN,
  PAY_TO,
  PAYER,
  paymentHeader,
  payInAsset,
  receipts,
  rpcCall,
  startTwoAssetHarness,
  twoAssetConfig,
  WCSPR_PRICE_RAW,
  WCSPR_SETTLE_TX,
  WCSPR_TOKEN,
  type TwoAssetHarness,
} from "./testing/harness.js";

const CASPER_SETTLE_FAILED = "invalid_exact_casper_facilitator_settle_failed";

/** What the in-memory hosted facilitator receives. */
interface HostedBody {
  paymentPayload?: { accepted?: { extra?: Record<string, unknown> }; payload?: { authorization?: { from?: string } } };
  paymentRequirements?: { asset?: string; extra?: Record<string, unknown> };
}

async function withTwoAssets(opts: Parameters<typeof startTwoAssetHarness>[0], run: (h: TwoAssetHarness) => Promise<void>): Promise<void> {
  const h = await startTwoAssetHarness(opts);
  try {
    await run(h);
  } finally {
    await h.close();
  }
}

/** Facilitator calls other than /supported, as "<op> <asset>" lines. */
const work = (calls: Array<{ op: string; body?: { paymentRequirements?: Record<string, unknown> } }>) =>
  calls.filter(call => call.op !== "supported").map(call => `${call.op} ${String(call.body?.paymentRequirements?.asset)}`);

describe("a gateway that sells in two tokens, one per authorization style", () => {
  it("offers both tokens in config order, each with its EIP-712 domain, display fields and authorization style", async () => {
    await withTwoAssets({}, async h => {
      const res = await h.rpc("tools/call", { name: "paid_tool", arguments: {} });
      assert.equal(res.status, 402);
      const challenge = challengeOf(res);
      assert.deepEqual(challenge.accepts, (res.body.error?.data as unknown as PaymentRequired).accepts);
      const [legacy, wcspr] = challenge.accepts;
      assert.equal(challenge.accepts.length, 2);
      assert.deepEqual(
        { ...legacy, maxTimeoutSeconds: undefined },
        {
          scheme: "exact",
          network: "casper:casper-test",
          amount: LEGACY_PRICE_RAW,
          asset: LEGACY_TOKEN,
          payTo: PAY_TO,
          maxTimeoutSeconds: undefined,
          extra: { name: "CasCet X402 Token", version: "1", symbol: "CASCET", decimals: "9", authorizationStyle: "legacy-amount" },
        },
      );
      assert.deepEqual(
        { ...wcspr, maxTimeoutSeconds: undefined },
        {
          scheme: "exact",
          network: "casper:casper-test",
          amount: WCSPR_PRICE_RAW,
          asset: WCSPR_TOKEN,
          payTo: PAY_TO,
          maxTimeoutSeconds: undefined,
          extra: { name: "Wrapped CSPR", version: "1", symbol: "WCSPR", decimals: "9", authorizationStyle: "cep3009-value" },
        },
      );
      assert.equal(legacy?.maxTimeoutSeconds, wcspr?.maxTimeoutSeconds);
      assert.deepEqual([h.legacy.count("supported"), h.cep.count("supported")], [1, 1]);
      assert.deepEqual([...work(h.legacy.calls), ...work(h.cep.calls)], []);
    });
  });

  it("verifies and settles a Wrapped CSPR payment with the CEP-3009 token's facilitator only, and records that token", async () => {
    await withTwoAssets({}, async h => {
      const { header, nonce } = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(h.events, ["cep:verify", "exec:paid_tool", "cep:settle"]);
      assert.deepEqual(work(h.cep.calls), [`verify ${WCSPR_TOKEN}`, `settle ${WCSPR_TOKEN}`]);
      assert.deepEqual(work(h.legacy.calls), []);
      assert.deepEqual(
        h.cep.calls.map(call => call.authorization),
        ["cep-key", "cep-key", "cep-key"],
        "the default facilitator gets its raw key on every call",
      );
      assert.equal(h.cep.calls[2]?.body?.paymentRequirements?.amount, WCSPR_PRICE_RAW);

      const meta = (res.body.result?._meta as { cascet: Record<string, unknown> }).cascet;
      assert.deepEqual(
        [meta.asset, meta.assetSymbol, meta.amountRaw, meta.txHash],
        [WCSPR_TOKEN, "WCSPR", WCSPR_PRICE_RAW, WCSPR_SETTLE_TX],
      );
      const [receipt] = await receipts(h);
      assert.deepEqual(
        [receipt?.status, receipt?.asset, receipt?.assetSymbol, receipt?.amountRaw, receipt?.txHash, receipt?.nonce, receipt?.payer],
        ["settled", WCSPR_TOKEN, "WCSPR", WCSPR_PRICE_RAW, WCSPR_SETTLE_TX, nonce, PAYER],
      );
      assert.match(
        readFileSync(h.receiptsPath, "utf8"),
        new RegExp(`"kind":"authorization","payer":"${PAYER}","nonce":"${nonce}","validBefore":\\d+,"asset":"${WCSPR_TOKEN}"`),
        "the write-ahead record names the token",
      );
    });
  });

  it("verifies and settles a legacy-token payment with its self-hosted facilitator only", async () => {
    await withTwoAssets({}, async h => {
      const { header } = await payInAsset(h, "paid_tool", LEGACY_TOKEN);
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(h.events, ["legacy:verify", "exec:paid_tool", "legacy:settle"]);
      assert.deepEqual(work(h.cep.calls), []);
      assert.deepEqual(
        h.legacy.calls.map(call => call.authorization),
        ["Bearer self-key", "Bearer self-key", "Bearer self-key"],
      );
      const [receipt] = await receipts(h);
      assert.deepEqual(
        [receipt?.asset, receipt?.assetSymbol, receipt?.amountRaw, receipt?.txHash],
        [LEGACY_TOKEN, "CASCET", LEGACY_PRICE_RAW, LEGACY_SETTLE_TX],
      );
    });
  });

  it("settles before running the tool in the token the buyer chose (settleBeforeExecute)", async () => {
    const config = { pricing: { tools: { paid_tool: { price: "$0.01", settleBeforeExecute: true } }, freeTools: ["free_tool"] } };
    await withTwoAssets({ config }, async h => {
      const { header } = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
      assert.equal((await callPaid(h, "paid_tool", header)).status, 200);
      assert.deepEqual(h.events, ["cep:verify", "cep:settle", "exec:paid_tool"]);
    });
  });
});

describe("local checks work in the token the payment names", () => {
  const config = {
    pricing: { tools: { paid_tool: { price: "$0.01" }, wcspr_tool: { price: "$0.01", assets: ["wcspr"] } }, freeTools: ["free_tool"] },
  };
  const tools = [{ name: "paid_tool" }, { name: "wcspr_tool" }, { name: "free_tool" }];

  it("offers a tool restricted by pricing.tools.<name>.assets in its tokens only, and refuses other tokens before verification", async () => {
    await withTwoAssets({ config, tools }, async h => {
      const restricted = challengeOf(await h.rpc("tools/call", { name: "wcspr_tool", arguments: {} }));
      assert.deepEqual(
        restricted.accepts.map(entry => entry.asset),
        [WCSPR_TOKEN],
      );
      // A legacy-token payment, valid for paid_tool, presented to the WCSPR-only tool.
      const { header } = await payInAsset(h, "paid_tool", LEGACY_TOKEN);
      const refused = await callPaid(h, "wcspr_tool", header);
      assert.equal(refused.status, 402);
      assert.equal(refused.body.error?.code, -32002);
      assert.match(refused.body.error?.message ?? "", new RegExp(`unsupported_asset: this tool is not sold for token ${LEGACY_TOKEN} \\(it accepts wcspr\\)`));
      assert.deepEqual(
        challengeOf(refused).accepts.map(entry => entry.asset),
        [WCSPR_TOKEN],
        "the fresh challenge offers the tool's own tokens",
      );
      assert.deepEqual([...work(h.legacy.calls), ...work(h.cep.calls)], []);
      assert.equal(h.upstream.calls.length, 0);

      const paid = await payInAsset(h, "wcspr_tool", WCSPR_TOKEN);
      assert.equal((await callPaid(h, "wcspr_tool", paid.header)).status, 200);
    });
  });

  it("checks the amount against the price in the payment's own token", async () => {
    await withTwoAssets({ config, tools }, async h => {
      // The legacy price signed in WCSPR: 2.5× the WCSPR price.
      const { header } = await payInAsset(h, "paid_tool", WCSPR_TOKEN, { value: LEGACY_PRICE_RAW });
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 402);
      assert.match(res.body.error?.message ?? "", /authorization\.value 500000000 does not equal the price 200000000 \(WCSPR\)/);
      assert.deepEqual([...work(h.legacy.calls), ...work(h.cep.calls)], []);
    });
  });

  it("refuses a payment that names no token", async () => {
    await withTwoAssets({ config, tools }, async h => {
      const { accepted } = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
      const { header } = paymentHeader({ ...accepted, asset: "not-a-package-hash" } as PaymentRequirements);
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 402);
      assert.match(res.body.error?.message ?? "", /accepted\.asset is missing or not a contract package hash/);
      assert.deepEqual([...work(h.legacy.calls), ...work(h.cep.calls)], []);
    });
  });

  it("refuses a nonce already used in the other token (one replay key per payer and nonce)", async () => {
    await withTwoAssets({ config, tools }, async h => {
      const first = await payInAsset(h, "paid_tool", LEGACY_TOKEN);
      assert.equal((await callPaid(h, "paid_tool", first.header)).status, 200);
      const second = await payInAsset(h, "paid_tool", WCSPR_TOKEN, { nonce: first.nonce });
      const replay = await callPaid(h, "paid_tool", second.header);
      assert.equal(replay.status, 402);
      assert.match(replay.body.error?.message ?? "", /duplicate_payment/);
      assert.deepEqual(work(h.cep.calls), []);
    });
  });

  it("fails closed when x402 verified the payment in another token than the one checked locally", async () => {
    const original = x402HTTPResourceServer.prototype.processHTTPRequest;
    const patched = mock.method(
      x402HTTPResourceServer.prototype,
      "processHTTPRequest",
      async function (this: x402HTTPResourceServer, ...args: Parameters<typeof original>) {
        const result = await original.apply(this, args);
        return result.type === "payment-verified"
          ? { ...result, paymentRequirements: { ...result.paymentRequirements, asset: LEGACY_TOKEN, amount: LEGACY_PRICE_RAW } }
          : result;
      },
    );
    try {
      await withTwoAssets({ config, tools }, async h => {
        const { header } = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
        const res = await callPaid(h, "paid_tool", header);
        assert.equal(res.status, 402);
        assert.match(res.body.error?.message ?? "", /verified payment is in another asset/);
        assert.equal(h.upstream.calls.length, 0);
        assert.deepEqual([h.legacy.count("settle"), h.cep.count("settle")], [0, 0]);
      });
    } finally {
      patched.mock.restore();
    }
  });
});

describe("settlement outcomes stay with the token of the payment", () => {
  it("records an unknown receipt in Wrapped CSPR when its facilitator's own timeout expires, and the other token still settles", async () => {
    // The CEP-3009 token's facilitator (the default one) gets its own 400 ms timeout.
    const config = (urls: { cep: string }) => ({ facilitator: { url: urls.cep, apiKey: "cep-key", timeoutMs: 400 } });
    await withTwoAssets({ config }, async h => {
      h.cep.onSettle = () => ({ hang: true });
      const { header, nonce } = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
      const started = Date.now();
      const res = await callPaid(h, "paid_tool", header);
      assert.ok(Date.now() - started < 5_000, "bounded by the CEP-3009 facilitator's own timeout");
      assert.equal(res.body.error?.code, -32003);
      assert.equal(res.body.result, undefined);
      const [receipt] = await receipts(h);
      assert.deepEqual(
        [receipt?.status, receipt?.asset, receipt?.assetSymbol, receipt?.amountRaw, receipt?.nonce],
        ["unknown", WCSPR_TOKEN, "WCSPR", WCSPR_PRICE_RAW, nonce],
      );
      assert.match(String(receipt?.note), /timed out after 400 ms/);

      const other = await payInAsset(h, "paid_tool", LEGACY_TOKEN);
      assert.equal((await callPaid(h, "paid_tool", other.header)).status, 200);
      assert.deepEqual(
        (await receipts(h)).map(entry => [entry.asset, entry.status]),
        [
          [WCSPR_TOKEN, "unknown"],
          [LEGACY_TOKEN, "settled"],
        ],
      );
    });
  });

  it("asks the on-chain check about the events of the token the payment was in", async () => {
    const seen: PreemptionQuery[] = [];
    const checker: SettlementPreemptionChecker = {
      check: async query => {
        seen.push(query);
        return { kind: "not-found", scanned: 64 };
      },
    };
    await withTwoAssets({ gateway: { preemptionChecker: checker } }, async h => {
      h.cep.onSettle = () => ({
        json: {
          success: false,
          errorReason: CASPER_SETTLE_FAILED,
          errorMessage: "transaction execution failed: User error: 64001",
          transaction: "",
          network: "casper:casper-test",
        },
      });
      const { header, nonce } = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
      assert.equal((await callPaid(h, "paid_tool", header)).status, 402);
      assert.deepEqual(seen, [{ payer: PAYER, nonce, payTo: PAY_TO, amount: WCSPR_PRICE_RAW, asset: WCSPR_TOKEN }]);
      const [receipt] = await receipts(h);
      assert.deepEqual([receipt?.status, receipt?.asset], ["failed", WCSPR_TOKEN]);
    });
  });
});

describe("pricing and discovery documents list every token", () => {
  it("shows each tool's tokens and amounts from its own accepts", async () => {
    const config = {
      pricing: { tools: { paid_tool: { price: "$0.01" }, wcspr_tool: { price: "$0.01", assets: ["wcspr"] } }, freeTools: ["free_tool"] },
    };
    await withTwoAssets({ config, tools: [{ name: "paid_tool" }, { name: "wcspr_tool" }, { name: "free_tool" }] }, async h => {
      const pricing = (await (await fetch(`${h.base}/pricing`)).json()) as {
        asset: { symbol: string; packageHash: string };
        assets: Array<{ id: string; packageHash: string; authorizationStyle: string }>;
        tools: Array<{ name: string; amountRaw?: string; asset?: string; accepts?: Array<{ asset: string; amountRaw: string; authorizationStyle: string }> }>;
      };
      assert.deepEqual(pricing.asset, { symbol: "CASCET", packageHash: LEGACY_TOKEN }, "the preferred token, as before");
      assert.deepEqual(
        pricing.assets.map(asset => [asset.id, asset.packageHash, asset.authorizationStyle]),
        [
          ["cascet", LEGACY_TOKEN, "legacy-amount"],
          ["wcspr", WCSPR_TOKEN, "cep3009-value"],
        ],
      );
      const byName = new Map(pricing.tools.map(tool => [tool.name, tool]));
      assert.deepEqual(
        byName.get("paid_tool")?.accepts?.map(entry => [entry.asset, entry.amountRaw, entry.authorizationStyle]),
        [
          ["cascet", LEGACY_PRICE_RAW, "legacy-amount"],
          ["wcspr", WCSPR_PRICE_RAW, "cep3009-value"],
        ],
      );
      assert.deepEqual([byName.get("paid_tool")?.amountRaw, byName.get("paid_tool")?.asset], [LEGACY_PRICE_RAW, "cascet"]);
      assert.deepEqual([byName.get("wcspr_tool")?.amountRaw, byName.get("wcspr_tool")?.asset], [WCSPR_PRICE_RAW, "wcspr"]);
      assert.deepEqual(byName.get("free_tool"), { name: "free_tool" });

      const discovery = (await (await fetch(`${h.base}/.well-known/x402.json`)).json()) as {
        items: Array<{ metadata: { tool: string }; accepts: Array<{ asset: string; amount: string; payTo: string; extra: Record<string, string> }> }>;
      };
      const items = new Map(discovery.items.map(item => [item.metadata.tool, item.accepts]));
      assert.deepEqual(
        items.get("paid_tool")?.map(entry => [entry.asset, entry.amount, entry.extra.authorizationStyle, entry.payTo]),
        [
          [LEGACY_TOKEN, LEGACY_PRICE_RAW, "legacy-amount", PAY_TO],
          [WCSPR_TOKEN, WCSPR_PRICE_RAW, "cep3009-value", PAY_TO],
        ],
      );
      assert.deepEqual(
        items.get("wcspr_tool")?.map(entry => entry.asset),
        [WCSPR_TOKEN],
      );
    });
  });
});

describe("the hosted facilitator", () => {
  /**
   * A gateway whose Wrapped CSPR is settled by the hosted facilitator (played in
   * memory: nothing reaches the real host) and whose legacy token is settled by
   * a local fake facilitator.
   */
  async function hostedGateway() {
    const hosted: Array<{ path: string; authorization: string | null; body?: HostedBody }> = [];
    const facilitatorFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== DEFAULT_FACILITATOR_URL) return fetch(input, init);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as HostedBody) : undefined;
      hosted.push({ path: url.pathname, authorization: new Headers(init?.headers).get("authorization"), body });
      const json =
        url.pathname === "/supported"
          ? {
              kinds: [{ x402Version: 2, scheme: "exact", network: "casper:casper-test", extra: { feePayer: "81".repeat(32) } }],
              extensions: [],
              signers: { "casper:*": ["81".repeat(32)] },
            }
          : url.pathname === "/verify"
            ? { isValid: true, payer: body?.paymentPayload?.payload?.authorization?.from }
            : { success: true, transaction: WCSPR_SETTLE_TX, network: "casper:casper-test", payer: body?.paymentPayload?.payload?.authorization?.from };
      return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const legacy = await startFakeFacilitator({ label: "legacy", settleTx: LEGACY_SETTLE_TX });
    const upstream = createFakeUpstream({ tools: [{ name: "paid_tool" }] });
    const dir = mkdtempSync(join(tmpdir(), "cascet-gateway-test-"));
    const cfg = twoAssetConfig(legacy.url, DEFAULT_FACILITATOR_URL, { facilitator: { url: DEFAULT_FACILITATOR_URL, apiKey: "cspr-cloud-key" } });
    let gateway;
    try {
      gateway = await startGateway(cfg, {
        createUpstreamTransport: () => upstream.createTransport(),
        receiptsPath: join(dir, "receipts.jsonl"),
        preemptionChecker: null,
        facilitatorFetch,
      });
    } catch (err) {
      await legacy.close();
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    const url = gateway.url;
    return {
      hosted,
      legacy,
      h: {
        rpc: (method: string, params?: Record<string, unknown>, headers?: Record<string, string>) => rpcCall(url, method, params, headers),
        base: url.replace(/\/mcp$/, ""),
      },
      close: async () => {
        await gateway.close();
        await legacy.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it("gets the raw access key and requirements without CasCet's authorizationStyle, which buyers still see", async () => {
    const { hosted, legacy, h, close } = await hostedGateway();
    try {
      const { header, accepted } = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
      assert.equal(accepted.extra?.authorizationStyle, "cep3009-value", "the 402 still tells buyers the style");
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(
        hosted.map(call => [call.path, call.authorization]),
        [
          ["/supported", "cspr-cloud-key"],
          ["/verify", "cspr-cloud-key"],
          ["/settle", "cspr-cloud-key"],
        ],
      );
      for (const call of hosted.slice(1)) {
        const expected = { name: "Wrapped CSPR", version: "1", symbol: "WCSPR", decimals: "9" };
        assert.deepEqual(call.body?.paymentRequirements?.extra, expected);
        assert.deepEqual(call.body?.paymentPayload?.accepted?.extra, expected);
        assert.equal(call.body?.paymentRequirements?.asset, WCSPR_TOKEN);
      }
      // The self-hosted facilitator of the legacy token keeps receiving the full requirements.
      const legacyPayment = await payInAsset(h, "paid_tool", LEGACY_TOKEN);
      assert.equal((await callPaid(h, "paid_tool", legacyPayment.header)).status, 200);
      const verify = legacy.calls.find(call => call.op === "verify");
      assert.equal((verify?.body?.paymentRequirements?.extra as Record<string, unknown> | undefined)?.authorizationStyle, "legacy-amount");
      assert.equal(hosted.length, 3, "the legacy payment never reached the hosted facilitator");
    } finally {
      await close();
    }
  });

  it("is refused at startup for a legacy-amount token, before anyone is contacted", async () => {
    const valid = twoAssetConfig("http://127.0.0.1:4501", "http://127.0.0.1:4502");
    const cfg = { ...valid, facilitators: { ...valid.facilitators, self: { url: `${DEFAULT_FACILITATOR_URL}/`, apiKey: "k", authScheme: "raw" as const } } } as CascetConfig;
    const contacted: string[] = [];
    const upstream = createFakeUpstream({ tools: [{ name: "paid_tool" }] });
    await assert.rejects(
      startGateway(cfg, {
        createUpstreamTransport: () => upstream.createTransport(),
        preemptionChecker: null,
        facilitatorFetch: (async (input: string | URL | Request) => {
          contacted.push(String(input));
          throw new Error("unexpected");
        }) as typeof fetch,
      }),
      /asset "cascet" is a legacy-amount token, but its facilitator "self" is the hosted one/,
    );
    assert.deepEqual(contacted, []);
    assert.equal(upstream.connections, 0, "the upstream is not started either");
  });
});

describe("@x402 2.29 buyers and a two-token 402", () => {
  it("a buyer whose policy prefers Wrapped CSPR pays in it, and only its facilitator settles", async () => {
    await withTwoAssets({}, async h => {
      const key = casperSdk.PrivateKey.generate(casperSdk.KeyAlgorithm.ED25519);
      const signer = {
        accountAddress: () => `00${key.publicKey.accountHash().toHex()}`,
        publicKey: () => key.publicKey.toHex(),
        signEIP712: async (digest: Uint8Array) => key.signAndAddAlgorithmBytes(digest),
      };
      const client = new x402Client()
        .register("casper:casper-test", new ExactCasperScheme(signer))
        .setSpendControls({ allowedAssets: true, maxAmountPerPayment: false })
        .registerPolicy((_version, requirements) => requirements.filter(entry => entry.extra?.authorizationStyle === "cep3009-value"));
      const paymentRequired = challengeOf(await h.rpc("tools/call", { name: "paid_tool", arguments: {} }));
      const payment = await client.createPaymentPayload(paymentRequired);
      assert.equal(payment.accepted.asset, WCSPR_TOKEN);
      const res = await callPaid(h, "paid_tool", encodePaymentSignatureHeader(payment));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(work(h.cep.calls), [`verify ${WCSPR_TOKEN}`, `settle ${WCSPR_TOKEN}`]);
      assert.deepEqual(work(h.legacy.calls), []);
      assert.equal((await receipts(h))[0]?.payer, signer.accountAddress());
    });
  });
});
