import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient, type HTTPAdapter } from "@x402/core/server";
import type { Network, PaymentRequired } from "@x402/core/types";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { advertisedPaymentFlow, CASCET_PAYMENT_FLOWS, CascetCasperServerScheme } from "./server-scheme.js";

const NETWORK = "casper:casper-test" as Network;
const ASSET = "22".repeat(32);
const OTHER_ASSET = "33".repeat(32);
const PAY_TO = `00${"11".repeat(32)}`;
const EXTRA = { name: "Test Token", version: "1", symbol: "TST", decimals: "9" };

const facilitator: FacilitatorClient = {
  verify: () => Promise.reject(new Error("unused")),
  settle: () => Promise.reject(new Error("unused")),
  getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} }),
};

const adapter: HTTPAdapter = {
  getHeader: () => undefined,
  getMethod: () => "POST",
  getPath: () => "/tools/0",
  getUrl: () => "http://127.0.0.1/tools/0",
  getAcceptHeader: () => "application/json",
  getUserAgent: () => "test",
};

const scheme = () => new CascetCasperServerScheme([{ network: NETWORK, asset: `hash-${ASSET.toUpperCase()}`, decimals: 9 }]);

async function challenge(extra?: Record<string, unknown>, from: FacilitatorClient = facilitator): Promise<PaymentRequired> {
  const resourceServer = new x402ResourceServer(from).register(NETWORK, scheme());
  const http = new x402HTTPResourceServer(resourceServer, {
    "POST /tools/0": {
      accepts: { scheme: "exact", network: NETWORK, payTo: PAY_TO, price: { asset: ASSET, amount: "500", extra: EXTRA }, ...(extra ? { extra } : {}) },
    },
  });
  await http.initialize();
  const result = await http.processHTTPRequest({ adapter, path: "/tools/0", method: "POST" });
  assert.equal(result.type, "payment-error");
  const header = result.type === "payment-error" ? result.response.headers["PAYMENT-REQUIRED"] : undefined;
  assert.ok(header, "a 402 challenge");
  return decodePaymentRequiredHeader(header);
}

/** A facilitator whose /supported lists `extensions` and puts `extra` on its kind. */
const advertising = (extra: Record<string, unknown>, extensions: string[]): FacilitatorClient => ({
  ...facilitator,
  getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra }], extensions, signers: {} }),
});

describe("CascetCasperServerScheme (@x402/core 2.29 SchemeNetworkServer)", () => {
  it("declares the members 2.29 requires: no on-wire transfer method, and the authorization flow only", () => {
    const s = scheme();
    assert.equal(s.scheme, "exact");
    assert.equal(s.defaultAssetTransferMethod, "default");
    assert.deepEqual(s.paymentFlows, CASCET_PAYMENT_FLOWS);
    assert.equal(s.paymentFlows.default.default, "authorization");
    assert.deepEqual([...s.paymentFlows.default.supported], ["authorization"]);
  });

  it("refuses money prices, which @x402/casper would turn into csprUSD", async () => {
    for (const price of ["$0.01", "0.01", 0.01]) {
      await assert.rejects(scheme().parsePrice(price, NETWORK), /must be AssetAmounts/, String(price));
    }
  });

  it("prices only configured assets, on their network", async () => {
    assert.deepEqual(await scheme().parsePrice({ asset: ASSET, amount: "500", extra: EXTRA }, NETWORK), {
      asset: ASSET,
      amount: "500",
      extra: EXTRA,
    });
    await assert.rejects(scheme().parsePrice({ asset: OTHER_ASSET, amount: "500" }, NETWORK), /not configured/);
    await assert.rejects(scheme().parsePrice({ asset: ASSET, amount: "500" }, "casper:casper" as Network), /not configured/);
  });

  it("takes decimals from the config, never from @x402/casper's csprUSD table", () => {
    const s = scheme();
    assert.equal(s.getAssetDecimals(ASSET, NETWORK), 9);
    assert.equal(s.getAssetDecimals(`hash-${ASSET}`, NETWORK), 9);
    assert.equal(s.getAssetDecimals("0cb6f94834c60510d532b0ae077b18b4100874a4c867396d61c2b13c790ead52", NETWORK), undefined);
    assert.throws(() => s.registerAsset({ network: NETWORK, asset: OTHER_ASSET, decimals: 1.5 }), /invalid decimals/);
  });

  it("builds the same 402 requirements as before: no paymentFlow or transfer method on the wire", async () => {
    const paymentRequired = await challenge();
    assert.deepEqual(paymentRequired.accepts, [
      { scheme: "exact", network: NETWORK, amount: "500", asset: ASSET, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: EXTRA },
    ]);
  });

  it("refuses x402's settle-before-handler flows on a route (they would settle before the gateway's own checks)", async () => {
    await assert.rejects(challenge({ paymentFlow: "upfront" }), /does not support paymentFlow "upfront"/);
    await assert.rejects(challenge({ paymentFlow: "escrow" }), /does not support paymentFlow "escrow"/);
  });

  it("fails closed when a facilitator's extension asks for a settle-before-handler flow or another transfer method", async () => {
    // @x402/casper copies supportedKind.extra[key] into the requirements for every extension key.
    await assert.rejects(challenge(undefined, advertising({ paymentFlow: "upfront" }, ["paymentFlow"])), /does not support paymentFlow "upfront"/);
    await assert.rejects(
      challenge(undefined, advertising({ assetTransferMethod: "permit" }, ["assetTransferMethod"])),
      /does not support assetTransferMethod "permit"/,
    );
  });

  it("never lets a facilitator's extension values replace the gateway's own extra fields; it may add its own", async () => {
    const extra = { name: "Evil Token", version: "2", symbol: "EVIL", decimals: "0", authorizationStyle: "legacy-amount", feePayer: "ff".repeat(32) };
    const paymentRequired = await challenge({ authorizationStyle: "cep3009-value" }, advertising(extra, Object.keys(extra)));
    assert.deepEqual(paymentRequired.accepts[0]?.extra, { ...EXTRA, authorizationStyle: "cep3009-value", feePayer: "ff".repeat(32) });
  });
});

describe("a facilitator's advertised payment flow (checked at startup)", () => {
  const kind = (extra?: Record<string, unknown>) => ({ x402Version: 2, scheme: "exact", network: NETWORK, ...(extra ? { extra } : {}) });

  it("reads what @x402/casper would copy: the reserved flow fields the facilitator lists as extensions and puts on its kind", () => {
    const extra = { paymentFlow: "upfront", assetTransferMethod: "permit", feePayer: "aa" };
    assert.deepEqual(advertisedPaymentFlow(kind(extra), ["paymentFlow", "assetTransferMethod", "feePayer"]), {
      paymentFlow: "upfront",
      assetTransferMethod: "permit",
    });
    assert.deepEqual(advertisedPaymentFlow(kind(extra), ["feePayer"]), {}, "not an extension: never copied");
    assert.deepEqual(advertisedPaymentFlow(kind({ feePayer: "aa" }), ["paymentFlow"]), {}, "an extension without a value");
    assert.deepEqual(advertisedPaymentFlow(kind(), ["paymentFlow"]), {});
  });

  it("names a flow or transfer method the CasCet scheme refuses, and passes the authorization flow", () => {
    const s = scheme();
    const flow = (paymentFlow: unknown) => s.unsupportedFacilitatorFlow(kind({ paymentFlow }), ["paymentFlow"]);
    for (const refused of ["upfront", "escrow", "batch"]) {
      assert.deepEqual(flow(refused), {
        advertised: `payment flow "${refused}"`,
        supported: `CasCet supports only the "authorization" flow (verify before the tool runs, settle after the gateway's own checks)`,
      });
    }
    assert.equal(flow(7)?.advertised, "payment flow 7");
    assert.equal(flow("authorization"), undefined);
    assert.equal(flow(null), undefined, "null means the default flow to x402");
    assert.equal(s.unsupportedFacilitatorFlow(kind({ paymentFlow: "upfront" }), []), undefined, "not an extension: x402 never sees it");
    assert.equal(s.unsupportedFacilitatorFlow(kind(), ["paymentFlow"]), undefined);

    const method = (extra: Record<string, unknown>) => s.unsupportedFacilitatorFlow(kind(extra), ["assetTransferMethod", "paymentFlow"]);
    assert.deepEqual(method({ assetTransferMethod: "permit" }), {
      advertised: 'asset transfer method "permit"',
      supported: `the CasCet scheme has no asset transfer method on the wire (only x402's "default")`,
    });
    assert.equal(method({ assetTransferMethod: "default", paymentFlow: "upfront" })?.advertised, 'payment flow "upfront"');
    assert.equal(method({ assetTransferMethod: "default" }), undefined);
  });

  it("keeps the advertised value out of the message when it is long or carries control characters", () => {
    const refused = scheme().unsupportedFacilitatorFlow(kind({ paymentFlow: `up\r\nfront${"x".repeat(200)}` }), ["paymentFlow"]);
    assert.ok(refused);
    assert.doesNotMatch(refused.advertised, /[\r\n]/);
    assert.ok(refused.advertised.length < 100, refused.advertised);
  });

  it("refuses exactly what x402 refuses on every paid call", async () => {
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ paymentFlow: "upfront" }, ["paymentFlow"]],
      [{ paymentFlow: "escrow" }, ["paymentFlow"]],
      [{ paymentFlow: "upfront" }, []],
      [{ paymentFlow: "authorization" }, ["paymentFlow"]],
      [{ paymentFlow: null }, ["paymentFlow"]],
      [{ assetTransferMethod: "permit" }, ["assetTransferMethod"]],
      [{ assetTransferMethod: "default" }, ["assetTransferMethod"]],
      [{ feePayer: "aa" }, ["feePayer"]],
    ];
    for (const [extra, extensions] of cases) {
      const startup = scheme().unsupportedFacilitatorFlow(kind(extra), extensions);
      const perCall = await challenge(undefined, advertising(extra, extensions)).then(
        () => undefined,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      assert.equal(startup !== undefined, perCall !== undefined, `${JSON.stringify(extra)} ${JSON.stringify(extensions)}: ${perCall}`);
    }
  });
});
