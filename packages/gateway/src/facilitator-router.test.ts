import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import {
  FacilitatorResponseError,
  FacilitatorTimeoutError,
  SettleError,
  type Network,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type SupportedResponse,
} from "@x402/core/types";
import { SettlementIndeterminateError } from "./facilitator.js";
import {
  AssetRoutingFacilitatorClient,
  ExtraStrippingFacilitatorClient,
  mergeSupported,
  UnroutedAssetError,
  type AssetRoute,
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

/** One /settle answer of a {@link recorder}: returned, thrown, or produced by a function (delays, hangs). */
type SettleAnswer = SettleResponse | Error | (() => Promise<SettleResponse>);

/** An in-memory facilitator that records its calls and names itself in its answers. */
function recorder(name: string, supported: SupportedResponse = supportedOn(NETWORK)) {
  const calls: Call[] = [];
  let settleAnswers: SettleAnswer[] = [];
  const client: FacilitatorClient = {
    verify: async (payload, requirements) => {
      calls.push({ op: "verify", payload, requirements });
      return { isValid: true, payer: name };
    },
    settle: async (payload, requirements) => {
      calls.push({ op: "settle", payload, requirements });
      const next = settleAnswers.shift();
      if (next instanceof Error) throw next;
      if (typeof next === "function") return next();
      return next ?? { success: true, transaction: name, network: requirements.network };
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
    answerSettleWith: (answers: SettleAnswer[]) => {
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

  it("assertCoverage refuses what a facilitator's own answer advertises, even when the merged answer x402 sees hides it", async () => {
    const upfront: SupportedResponse = { ...supportedOn(NETWORK, { paymentFlow: "upfront" }), extensions: ["paymentFlow"] };
    const legacy = recorder("legacy", upfront);
    const cep = recorder("cep");
    const router = new AssetRoutingFacilitatorClient([
      { network: NETWORK, asset: `hash-${LEGACY}`, facilitator: legacy.client, label: 'facilitator "self" (http://127.0.0.1:4501)' },
      { network: NETWORK, asset: WCSPR, facilitator: cep.client, label: 'facilitator "default" (https://x402-facilitator.cspr.cloud)' },
    ]);
    // The other facilitator lists no extension and describes the kind differently: x402 alone would not see the flow.
    const merged = await router.getSupported();
    assert.deepEqual([merged.extensions, merged.kinds[0]?.extra], [[], undefined]);

    const checked: Array<[string, unknown, readonly string[]]> = [];
    await assert.rejects(
      router.assertCoverage(2, "exact", (route, kind, extensions) => {
        checked.push([route.label, kind.extra, extensions]);
        return kind.extra?.paymentFlow === "upfront" ? `${route.label} asks for "upfront", which asset ${route.asset} needs` : undefined;
      }),
      new RegExp(`^Error: facilitator "self" \\(http://127\\.0\\.0\\.1:4501\\) asks for "upfront", which asset hash-${LEGACY} needs$`),
    );
    assert.deepEqual(checked, [
      ['facilitator "self" (http://127.0.0.1:4501)', { paymentFlow: "upfront" }, ["paymentFlow"]],
      ['facilitator "default" (https://x402-facilitator.cspr.cloud)', undefined, []],
    ]);
    assert.deepEqual([...legacy.ops(), ...cep.ops()], ["supported", "supported"], "no second /supported round");
  });

  it("assertCoverage checks every kind a route is paid with, and only those, and reports refusals with coverage gaps", async () => {
    const answer = (network: string): SupportedResponse => ({
      kinds: [
        { x402Version: 2, scheme: "exact", network: network as Network, extra: { paymentFlow: "upfront" } },
        { x402Version: 2, scheme: "exact", network: network as Network, extra: { paymentFlow: "escrow" } },
        { x402Version: 1, scheme: "exact", network: network as Network, extra: { paymentFlow: "v1" } },
        { x402Version: 2, scheme: "upto", network: network as Network, extra: { paymentFlow: "upto" } },
      ],
      extensions: ["paymentFlow"],
      signers: {},
    });
    const covering = recorder("covering", answer(NETWORK));
    const elsewhere = recorder("elsewhere", answer("casper:casper"));
    const router = new AssetRoutingFacilitatorClient([
      { network: NETWORK, asset: WCSPR, facilitator: covering.client, label: "covering" },
      { network: NETWORK, asset: LEGACY, facilitator: elsewhere.client, label: "elsewhere" },
    ]);
    const flows: unknown[] = [];
    await assert.rejects(
      router.assertCoverage(2, "exact", (route, kind) => {
        flows.push(kind.extra?.paymentFlow);
        return `${route.label} refuses ${String(kind.extra?.paymentFlow)}`;
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.deepEqual(err.message.split("; "), [
          "covering refuses upfront",
          "covering refuses escrow",
          `elsewhere does not support x402 v2 "exact" payments on ${NETWORK}, which asset ${LEGACY} needs`,
        ]);
        return true;
      },
    );
    assert.deepEqual(flows, ["upfront", "escrow"], "only the v2 exact kinds on the route's network");
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

describe("x402's retry of a settlement the facilitator reported as pending", () => {
  const PENDING_TX = "ef".repeat(32);
  const PAYER_ADDRESS = `00${"aa".repeat(32)}`;

  /** A payment with an authorization (the router remembers pending settlements per payer and nonce). */
  const signedPayload = (accepted: PaymentRequirements, nonce = "12".repeat(32), validBefore = "4102444800"): PaymentPayload => ({
    x402Version: 2,
    accepted,
    payload: { authorization: { from: PAYER_ADDRESS, to: PAY_TO, value: accepted.amount, validAfter: "0", validBefore, nonce } },
  });
  /** What the self-hosted facilitator answers when the transfer was broadcast but not seen executing in time. */
  const pending = (transaction = PENDING_TX): SettleResponse => ({
    success: false,
    errorReason: "settlement_pending",
    errorMessage: "transaction submitted; its execution was not observed yet",
    transaction,
    network: NETWORK,
  });
  /** A refusal that names no transaction (rate limits, shutdown). */
  const refused = (errorReason: string, errorMessage?: string): SettleResponse => ({
    success: false,
    errorReason,
    ...(errorMessage ? { errorMessage } : {}),
    transaction: "",
    network: NETWORK,
  });
  const after = (ms: number, answer: SettleResponse) => () => new Promise<SettleResponse>(resolve => setTimeout(() => resolve(answer), ms));
  const never = () => new Promise<SettleResponse>(() => {});

  async function serverWith(route: Partial<AssetRoute> = {}) {
    const cep = recorder("cep");
    const router = new AssetRoutingFacilitatorClient([{ network: NETWORK, asset: WCSPR, facilitator: cep.client, label: "cep", ...route }]);
    const resourceServer = new x402ResourceServer(router).register(NETWORK, new CascetCasperServerScheme([{ network: NETWORK, asset: WCSPR, decimals: 9 }]));
    await resourceServer.initialize();
    return { cep, router, resourceServer, wcspr: requirements(WCSPR) };
  }

  it("answers a retry that was rate limited with settlement_pending and the transaction of the first answer", async () => {
    const { cep, resourceServer, wcspr } = await serverWith();
    cep.answerSettleWith([pending(), refused("rate_limited", "too many requests; retry after the window resets")]);
    const settled = await resourceServer.settlePayment(signedPayload(wcspr), wcspr);
    assert.deepEqual(cep.ops(), ["supported", "settle", "settle"], "x402 retried once, with the same facilitator");
    assert.deepEqual(
      [settled.success, settled.errorReason, settled.transaction, settled.network, settled.payer],
      [false, "settlement_pending", PENDING_TX, NETWORK, PAYER_ADDRESS],
    );
    assert.equal(
      settled.errorMessage,
      `retry after pending transaction ${PENDING_TX} answered rate_limited: too many requests; retry after the window resets`,
    );
  });

  it("does the same for a retry that throws without a transaction: 503 while shutting down, a broken connection", async () => {
    const retries: Array<[Error, RegExp]> = [
      [
        new SettleError(503, refused("facilitator_shutting_down", "the facilitator is shutting down; retry later")),
        /answered facilitator_shutting_down: the facilitator is shutting down; retry later$/,
      ],
      [new SettleError(404, refused("facilitator_http_404", "<html>Not Found</html>")), /answered facilitator_http_404: <html>Not Found<\/html>$/],
      [new Error("socket hang up"), /answered socket hang up$/],
    ];
    for (const [retry, detail] of retries) {
      const { cep, resourceServer, wcspr } = await serverWith();
      cep.answerSettleWith([pending(), retry]);
      const settled = await resourceServer.settlePayment(signedPayload(wcspr), wcspr);
      assert.deepEqual([settled.success, settled.errorReason, settled.transaction], [false, "settlement_pending", PENDING_TX], retry.message);
      assert.match(settled.errorMessage ?? "", detail);
    }
  });

  it("remembers a pending settlement that the facilitator client threw as well", async () => {
    const { cep, resourceServer, wcspr } = await serverWith();
    cep.answerSettleWith([new SettleError(202, pending()), refused("rate_limited")]);
    const settled = await resourceServer.settlePayment(signedPayload(wcspr), wcspr);
    assert.deepEqual([settled.errorReason, settled.transaction], ["settlement_pending", PENDING_TX]);
    assert.match(settled.errorMessage ?? "", /answered rate_limited$/);
  });

  it("keeps a retry that timed out indeterminate (a throw x402 passes on), naming the pending transaction", async () => {
    const { cep, resourceServer, wcspr } = await serverWith();
    cep.answerSettleWith([pending(), new FacilitatorTimeoutError("settle", 90_000)]);
    await assert.rejects(resourceServer.settlePayment(signedPayload(wcspr), wcspr), (err: unknown) => {
      assert.ok(err instanceof SettlementIndeterminateError);
      assert.ok(err instanceof FacilitatorResponseError, "x402's processSettlement rethrows it");
      assert.equal(err.transaction, PENDING_TX);
      assert.equal(
        err.message,
        `Facilitator settle request timed out after 90000ms (retrying a settlement the facilitator had reported as pending with transaction ${PENDING_TX})`,
      );
      assert.ok(err.cause instanceof FacilitatorTimeoutError);
      return true;
    });
  });

  it("passes on a retry whose answer names a transaction, a retry that succeeds, and a pending answer without a hash", async () => {
    const { cep, resourceServer, wcspr } = await serverWith();
    const duplicate: SettleResponse = {
      success: false,
      errorReason: "duplicate_nonce",
      errorMessage: `this authorization is already submitted at this facilitator (transaction ${PENDING_TX})`,
      transaction: PENDING_TX,
      network: NETWORK,
    };
    cep.answerSettleWith([pending(), duplicate]);
    assert.equal(await resourceServer.settlePayment(signedPayload(wcspr, "13".repeat(32)), wcspr), duplicate);

    cep.answerSettleWith([pending(), { success: true, transaction: PENDING_TX, network: NETWORK }]);
    const settled = await resourceServer.settlePayment(signedPayload(wcspr, "14".repeat(32)), wcspr);
    assert.deepEqual([settled.success, settled.transaction], [true, PENDING_TX]);

    // Without a hash x402 does not retry, and there is nothing to remember.
    const hashless = pending("");
    cep.answerSettleWith([hashless]);
    assert.equal(await resourceServer.settlePayment(signedPayload(wcspr, "15".repeat(32)), wcspr), hashless);
  });

  it("remembers per payment (network, asset, payer, nonce) and forgets a payment once it settled", async () => {
    const { cep, router, wcspr } = await serverWith();
    const first = signedPayload(wcspr, "21".repeat(32));
    cep.answerSettleWith([
      pending(),
      refused("rate_limited"),
      refused("rate_limited"),
      { success: true, transaction: PENDING_TX, network: NETWORK },
      refused("rate_limited"),
    ]);
    await router.settle(first, wcspr);
    // Another nonce of the same payer is another payment.
    assert.deepEqual(await router.settle(signedPayload(wcspr, "22".repeat(32)), wcspr), refused("rate_limited"));
    // The same nonce, spelled differently, is the same payment.
    const respelled = signedPayload(wcspr, `0x${"21".repeat(32).toUpperCase()}`);
    assert.equal((await router.settle(respelled, wcspr)).transaction, PENDING_TX);
    // Once that payment settled it is forgotten.
    assert.equal((await router.settle(first, wcspr)).success, true);
    assert.deepEqual(await router.settle(first, wcspr), refused("rate_limited"));
  });

  it("gives the retry only what the first call left of the route's settle timeout", async () => {
    const { cep, resourceServer, wcspr } = await serverWith({ settleTimeoutMs: 300 });
    cep.answerSettleWith([after(150, pending()), never]);
    const started = Date.now();
    const settled = await resourceServer.settlePayment(signedPayload(wcspr), wcspr);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 250 && elapsed < 2_000, `both calls together took about 300 ms, not 450 ms or more (${elapsed} ms)`);
    assert.deepEqual([settled.errorReason, settled.transaction], ["settlement_pending", PENDING_TX]);
    assert.match(settled.errorMessage ?? "", /answered nothing within the 300 ms settle timeout$/);
    assert.deepEqual(cep.ops(), ["supported", "settle", "settle"]);
  });

  it("does not call the facilitator again when the first call used up the settle timeout", async () => {
    const { cep, resourceServer, wcspr } = await serverWith({ settleTimeoutMs: 100 });
    cep.answerSettleWith([after(150, pending())]);
    const settled = await resourceServer.settlePayment(signedPayload(wcspr), wcspr);
    assert.deepEqual(cep.ops(), ["supported", "settle"]);
    assert.deepEqual([settled.errorReason, settled.transaction], ["settlement_pending", PENDING_TX]);
    assert.match(settled.errorMessage ?? "", /answered nothing: the first call used up the 100 ms settle timeout$/);
  });

  it("forgets pending settlements after validBefore plus a margin, and keeps at most maxPendingSettlements", async () => {
    let now = 1_000_000;
    const cep = recorder("cep");
    const router = new AssetRoutingFacilitatorClient([{ network: NETWORK, asset: WCSPR, facilitator: cep.client, label: "cep" }], {
      now: () => now,
      maxPendingSettlements: 2,
    });
    const wcspr = requirements(WCSPR);
    // validBefore 1 000 s, the clock's "now".
    const [a, b, c] = ["31", "32", "33"].map(byte => signedPayload(wcspr, byte.repeat(32), "1000")) as [PaymentPayload, PaymentPayload, PaymentPayload];
    cep.answerSettleWith([
      pending("a1".repeat(32)),
      pending("b1".repeat(32)),
      pending("c1".repeat(32)),
      refused("rate_limited"),
      refused("rate_limited"),
      refused("rate_limited"),
    ]);
    for (const payment of [a, b, c]) await router.settle(payment, wcspr);
    // a, the oldest, made room for c.
    assert.deepEqual(await router.settle(a, wcspr), refused("rate_limited"));
    assert.equal((await router.settle(b, wcspr)).transaction, "b1".repeat(32));
    // validBefore plus the 120 s margin has passed: c is forgotten as well.
    now += 120_000;
    assert.deepEqual(await router.settle(c, wcspr), refused("rate_limited"));
  });
});
