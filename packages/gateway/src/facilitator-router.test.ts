import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse } from "@x402/core/types";
import {
  AssetRoutingFacilitatorClient,
  ExtraStrippingFacilitatorClient,
  mergeSupported,
  UnroutedAssetError,
} from "./facilitator-router.js";
import { CascetCasperServerScheme } from "./server-scheme.js";

const NETWORK = "casper:casper-test" as Network;
const LEGACY = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
const WCSPR = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";
const PAY_TO = `00${"11".repeat(32)}`;

const supportedOn = (network: string, extra?: Record<string, unknown>): SupportedResponse => ({
  kinds: [{ x402Version: 2, scheme: "exact", network: network as Network, ...(extra ? { extra } : {}) }],
  extensions: [],
  signers: {},
});

interface Call {
  op: "verify" | "settle" | "supported";
  payload?: PaymentPayload;
  requirements?: PaymentRequirements;
}

/** An in-memory facilitator that records its calls and names itself in its answers. */
function recorder(name: string, supported: SupportedResponse = supportedOn(NETWORK)) {
  const calls: Call[] = [];
  let settleAnswers: SettleResponse[] = [];
  const client: FacilitatorClient = {
    verify: async (payload, requirements) => {
      calls.push({ op: "verify", payload, requirements });
      return { isValid: true, payer: name };
    },
    settle: async (payload, requirements) => {
      calls.push({ op: "settle", payload, requirements });
      return settleAnswers.shift() ?? { success: true, transaction: name, network: requirements.network };
    },
    getSupported: async () => {
      calls.push({ op: "supported" });
      return supported;
    },
  };
  return {
    client,
    calls,
    ops: () => calls.map(call => call.op),
    answerSettleWith: (answers: SettleResponse[]) => {
      settleAnswers = answers;
    },
  };
}

const requirements = (asset: string, extra: Record<string, unknown> = { name: "T", version: "1" }): PaymentRequirements => ({
  scheme: "exact",
  network: NETWORK,
  asset,
  amount: "500",
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra,
});
const payload = (accepted: PaymentRequirements): PaymentPayload => ({ x402Version: 2, accepted, payload: { authorization: {} } });

function twoRoutes() {
  const legacy = recorder("legacy");
  const cep = recorder("cep");
  const router = new AssetRoutingFacilitatorClient([
    { network: NETWORK, asset: `hash-${LEGACY}`, facilitator: legacy.client, label: 'facilitator "self" (http://127.0.0.1:4501)' },
    { network: NETWORK, asset: WCSPR.toUpperCase(), facilitator: cep.client, label: 'facilitator "default" (https://x402-facilitator.cspr.cloud)' },
  ]);
  return { legacy, cep, router };
}

describe("AssetRoutingFacilitatorClient routes by the asset of the requirements", () => {
  it("sends verify and settle to the facilitator of the asset, whatever the spelling of its route", async () => {
    const { legacy, cep, router } = twoRoutes();
    const wcspr = requirements(WCSPR);
    assert.equal((await router.verify(payload(wcspr), wcspr)).payer, "cep");
    assert.equal((await router.settle(payload(wcspr), wcspr)).transaction, "cep");
    const old = requirements(LEGACY);
    assert.equal((await router.verify(payload(old), old)).payer, "legacy");
    assert.equal((await router.settle(payload(old), old)).transaction, "legacy");
    assert.deepEqual(cep.ops(), ["verify", "settle"]);
    assert.deepEqual(legacy.ops(), ["verify", "settle"]);
    assert.equal(cep.calls[0]?.requirements, wcspr, "the requirements are forwarded untouched");
    assert.equal(router.routeFor(NETWORK, `hash-${WCSPR}`)?.facilitator, cep.client);
  });

  it("refuses an asset without a route, and a routed asset on another network, before any facilitator is asked", async () => {
    const { legacy, cep, router } = twoRoutes();
    const unknown = requirements("ab".repeat(32));
    await assert.rejects(router.verify(payload(unknown), unknown), UnroutedAssetError);
    await assert.rejects(router.settle(payload(unknown), unknown), (err: unknown) => {
      assert.ok(err instanceof UnroutedAssetError);
      assert.equal(err.asset, "ab".repeat(32));
      assert.match(err.message, /no facilitator is configured for asset (?:ab){32} on casper:casper-test/);
      return true;
    });
    const otherNetwork = { ...requirements(WCSPR), network: "casper:casper" as Network };
    await assert.rejects(router.verify(payload(otherNetwork), otherNetwork), UnroutedAssetError);
    assert.deepEqual([...legacy.ops(), ...cep.ops()], []);
  });

  it("refuses two routes for one asset and an empty route list", () => {
    const a = recorder("a");
    assert.throws(
      () =>
        new AssetRoutingFacilitatorClient([
          { network: NETWORK, asset: WCSPR, facilitator: a.client, label: "a" },
          { network: NETWORK, asset: `hash-${WCSPR}`, facilitator: a.client, label: "a" },
        ]),
      /has two facilitator routes/,
    );
    assert.throws(() => new AssetRoutingFacilitatorClient([]), /at least one asset route/);
  });
});

describe("AssetRoutingFacilitatorClient /supported", () => {
  it("asks each distinct facilitator once, even when it settles several assets", async () => {
    const shared = recorder("shared");
    const router = new AssetRoutingFacilitatorClient([
      { network: NETWORK, asset: LEGACY, facilitator: shared.client, label: "shared" },
      { network: NETWORK, asset: WCSPR, facilitator: shared.client, label: "shared" },
    ]);
    const supported = await router.getSupported();
    assert.deepEqual(shared.ops(), ["supported"]);
    assert.deepEqual(supported.kinds, supportedOn(NETWORK).kinds);
  });

  it("fails when any facilitator fails, naming it (a gateway must not start without the facilitator of an asset)", async () => {
    const ok = recorder("ok");
    const down: FacilitatorClient = {
      ...recorder("down").client,
      getSupported: () => Promise.reject(new Error("facilitator /supported failed with HTTP 503: down")),
    };
    const router = new AssetRoutingFacilitatorClient([
      { network: NETWORK, asset: LEGACY, facilitator: ok.client, label: "ok" },
      { network: NETWORK, asset: WCSPR, facilitator: down, label: 'facilitator "cloud" (https://example.test)' },
    ]);
    await assert.rejects(router.getSupported(), /^Error: facilitator "cloud" \(https:\/\/example\.test\): facilitator \/supported failed with HTTP 503/);
  });

  it("assertCoverage names every asset whose facilitator does not support its network, from the last answers", async () => {
    const legacy = recorder("legacy", supportedOn("casper:casper"));
    const cep = recorder("cep");
    const router = new AssetRoutingFacilitatorClient([
      { network: NETWORK, asset: LEGACY, facilitator: legacy.client, label: 'facilitator "self" (http://127.0.0.1:4501)' },
      { network: NETWORK, asset: WCSPR, facilitator: cep.client, label: 'facilitator "default" (https://x402-facilitator.cspr.cloud)' },
    ]);
    await router.getSupported();
    await assert.rejects(
      router.assertCoverage(),
      new RegExp(`^Error: facilitator "self" \\(http://127\\.0\\.0\\.1:4501\\) does not support x402 v2 "exact" payments on casper:casper-test, which asset ${LEGACY} needs$`),
    );
    assert.deepEqual([...legacy.ops(), ...cep.ops()], ["supported", "supported"], "no second /supported round");
  });

  it("assertCoverage fetches the answers itself when x402 has not asked yet, and passes when every asset is covered", async () => {
    const { legacy, cep, router } = twoRoutes();
    await router.assertCoverage();
    assert.deepEqual([...legacy.ops(), ...cep.ops()], ["supported", "supported"]);
  });
});

describe("mergeSupported", () => {
  it("lists each kind once, keeps only extensions every facilitator has, and unions signers", () => {
    const merged = mergeSupported([
      {
        kinds: [
          { x402Version: 2, scheme: "exact", network: "casper:casper-test" as Network, extra: { feePayer: "aa" } },
          { x402Version: 2, scheme: "exact", network: "casper:casper" as Network, extra: { feePayer: "bb" } },
        ],
        extensions: ["bazaar", "shared"],
        signers: { "casper:*": ["aa", "bb"] },
      },
      {
        kinds: [
          { x402Version: 2, scheme: "exact", network: "casper:casper-test" as Network, extra: { feePayer: "cc" } },
          { x402Version: 2, scheme: "exact", network: "casper:casper" as Network, extra: { feePayer: "bb" } },
        ],
        extensions: ["shared"],
        signers: { "casper:*": ["cc", "aa"], "eip155:*": ["0x1"] },
      },
    ]);
    assert.deepEqual(merged, {
      kinds: [
        // Two fee payers for the same kind: no single extra fits both facilitators' assets.
        { x402Version: 2, scheme: "exact", network: "casper:casper-test" },
        { x402Version: 2, scheme: "exact", network: "casper:casper", extra: { feePayer: "bb" } },
      ],
      extensions: ["shared"],
      signers: { "casper:*": ["aa", "bb", "cc"], "eip155:*": ["0x1"] },
    });
  });

  it("returns a single facilitator's answer unchanged in substance", () => {
    const one = supportedOn(NETWORK, { feePayer: "aa" });
    assert.deepEqual(mergeSupported([{ ...one, extensions: ["x"] }]), { ...one, extensions: ["x"] });
  });

  it("keeps a facilitator-advertised __proto__ signer family as plain data", () => {
    const merged = mergeSupported([{ kinds: [], extensions: [], signers: JSON.parse('{"__proto__":["x"]}') as Record<string, string[]> }]);
    assert.deepEqual(Object.getPrototypeOf(merged.signers), Object.prototype);
    assert.deepEqual(Object.getOwnPropertyDescriptor(merged.signers, "__proto__")?.value, ["x"]);
  });
});

describe("ExtraStrippingFacilitatorClient", () => {
  it("leaves the keys out of the requirements and of the payload's accepted copy, and nothing else", async () => {
    const inner = recorder("hosted");
    const stripping = new ExtraStrippingFacilitatorClient(inner.client, ["authorizationStyle"]);
    const reqs = requirements(WCSPR, { name: "Wrapped CSPR", version: "1", symbol: "WCSPR", decimals: "9", authorizationStyle: "cep3009-value" });
    const original = payload(reqs);
    await stripping.verify(original, reqs);
    await stripping.settle(original, reqs);
    for (const call of inner.calls) {
      const expected = { name: "Wrapped CSPR", version: "1", symbol: "WCSPR", decimals: "9" };
      assert.deepEqual(call.requirements?.extra, expected);
      assert.deepEqual(call.payload?.accepted.extra, expected);
      assert.equal(call.payload?.payload, original.payload, "the signed payload is forwarded as is");
      assert.equal(call.requirements?.asset, WCSPR);
    }
    assert.equal(reqs.extra?.authorizationStyle, "cep3009-value", "the caller's objects are not modified");
    assert.equal(original.accepted.extra?.authorizationStyle, "cep3009-value");
    assert.deepEqual(await stripping.getSupported(), supportedOn(NETWORK));
  });

  it("forwards the very same objects when there is nothing to strip", async () => {
    const inner = recorder("hosted");
    const stripping = new ExtraStrippingFacilitatorClient(inner.client, ["authorizationStyle"]);
    const reqs = requirements(WCSPR);
    const original = payload(reqs);
    await stripping.verify(original, reqs);
    assert.equal(inner.calls[0]?.requirements, reqs);
    assert.equal(inner.calls[0]?.payload, original);
  });
});

describe("x402's resource server behind the router", () => {
  async function server() {
    const { legacy, cep, router } = twoRoutes();
    const scheme = new CascetCasperServerScheme([
      { network: NETWORK, asset: LEGACY, decimals: 9 },
      { network: NETWORK, asset: WCSPR, decimals: 9 },
    ]);
    const resourceServer = new x402ResourceServer(router).register(NETWORK, scheme);
    await resourceServer.initialize();
    await router.assertCoverage();
    return { legacy, cep, resourceServer };
  }

  it("verifies and settles each payment with the facilitator of its asset", async () => {
    const { legacy, cep, resourceServer } = await server();
    const wcspr = requirements(WCSPR);
    assert.equal((await resourceServer.verifyPayment(payload(wcspr), wcspr)).isValid, true);
    assert.equal((await resourceServer.settlePayment(payload(wcspr), wcspr)).transaction, "cep");
    assert.deepEqual(cep.ops(), ["supported", "verify", "settle"]);
    assert.deepEqual(legacy.ops(), ["supported"]);
  });

  it("sends x402's single settlement_pending retry to the same facilitator", async () => {
    const { legacy, cep, resourceServer } = await server();
    const pending = "ef".repeat(32);
    cep.answerSettleWith([
      { success: false, errorReason: "settlement_pending", transaction: pending, network: NETWORK },
      { success: true, transaction: pending, network: NETWORK },
    ]);
    const wcspr = requirements(WCSPR);
    const settled = await resourceServer.settlePayment(payload(wcspr), wcspr);
    assert.equal(settled.success, true);
    assert.equal(settled.transaction, pending);
    assert.deepEqual(cep.ops(), ["supported", "settle", "settle"]);
    assert.deepEqual(legacy.ops(), ["supported"]);
  });

  it("fails a payment in an unrouted asset closed, without contacting any facilitator", async () => {
    const { legacy, cep, resourceServer } = await server();
    const stray = requirements("ab".repeat(32));
    await assert.rejects(resourceServer.verifyPayment(payload(stray), stray), UnroutedAssetError);
    assert.deepEqual([...legacy.ops(), ...cep.ops()], ["supported", "supported"]);
  });
});
