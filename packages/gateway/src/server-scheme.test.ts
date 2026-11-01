import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient, type HTTPAdapter } from "@x402/core/server";
import type { Network, PaymentRequired } from "@x402/core/types";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { CASCET_PAYMENT_FLOWS, CascetCasperServerScheme } from "./server-scheme.js";

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

async function challenge(extra?: Record<string, unknown>): Promise<PaymentRequired> {
  const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, scheme());
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

describe("CascetCasperServerScheme (@x402/core 2.29 SchemeNetworkServer)", () => {
  it("declares the members 2.29 requires: no on-wire transfer method, authorization by default, upfront on request", () => {
    const s = scheme();
    assert.equal(s.scheme, "exact");
    assert.equal(s.defaultAssetTransferMethod, "default");
    assert.deepEqual(s.paymentFlows, CASCET_PAYMENT_FLOWS);
    assert.equal(s.paymentFlows.default.default, "authorization");
    assert.deepEqual([...s.paymentFlows.default.supported], ["authorization", "upfront"]);
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

  it("lets a route opt into the upfront flow, and x402 refuses flows the scheme does not declare", async () => {
    const upfront = await challenge({ paymentFlow: "upfront" });
    assert.equal(upfront.accepts[0]?.extra?.paymentFlow, "upfront");
    await assert.rejects(challenge({ paymentFlow: "escrow" }), /does not support paymentFlow "escrow"/);
  });
});
