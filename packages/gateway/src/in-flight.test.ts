import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient, type HTTPAdapter } from "@x402/core/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { Network } from "@x402/core/types";
import { IN_FLIGHT_MARGIN_MS, InFlightPayments, paymentHoldOf, withPaymentHold, type InFlightPayment, type PaymentHold } from "./in-flight.js";
import { CascetCasperServerScheme } from "./server-scheme.js";

const NETWORK = "casper:casper-test";
const ASSET = "3d".repeat(32);
const PAYER = `00${"65".repeat(32)}`;
const OTHER_PAYER = `00${"66".repeat(32)}`;
/** validBefore of the test authorizations, unix seconds. */
const VALID_BEFORE = 1_000;

const payment = (overrides: Partial<InFlightPayment> = {}): InFlightPayment => ({
  network: NETWORK,
  asset: ASSET,
  payer: PAYER,
  amount: 100n,
  validBefore: VALID_BEFORE,
  ...overrides,
});
const none = { count: 0, amount: 0n };

describe("InFlightPayments", () => {
  it("adds up the payments of one payer in one asset on one network, whatever their spelling", () => {
    const inFlight = new InFlightPayments({ now: () => 0 });
    assert.equal(inFlight.reserve(inFlight.open(), payment()), "reserved");
    assert.equal(inFlight.reserve(inFlight.open(), payment({ asset: `hash-${ASSET.toUpperCase()}`, payer: `0x${PAYER.toUpperCase()}`, amount: 50n })), "reserved");
    assert.deepEqual(inFlight.total(NETWORK, ASSET, PAYER), { count: 2, amount: 150n });
    assert.deepEqual(inFlight.total(NETWORK, ASSET, OTHER_PAYER), none, "another payer");
    assert.deepEqual(inFlight.total(NETWORK, "22".repeat(32), PAYER), none, "another asset");
    assert.deepEqual(inFlight.total("casper:casper", ASSET, PAYER), none, "another network");
  });

  it("releases exactly the reservation of the call whose hold is released, and nothing more can be reserved on it", () => {
    const inFlight = new InFlightPayments({ now: () => 0 });
    const first = inFlight.open();
    const second = inFlight.open();
    inFlight.reserve(first, payment());
    inFlight.reserve(second, payment({ amount: 7n }));
    first.release();
    first.release();
    assert.deepEqual(inFlight.total(NETWORK, ASSET, PAYER), { count: 1, amount: 7n });
    assert.equal(inFlight.reserve(first, payment()), "released");
    assert.deepEqual(inFlight.total(NETWORK, ASSET, PAYER), { count: 1, amount: 7n });
    second.release();
    assert.deepEqual([inFlight.total(NETWORK, ASSET, PAYER), inFlight.size], [none, 0]);
    // A hold whose call ends before anything was reserved on it.
    const unused = inFlight.open();
    unused.release();
    assert.equal(inFlight.reserve(unused, payment()), "released");
  });

  it("keeps one reservation per call, leaves the call's own out of its total, and ignores holds it did not open", () => {
    const inFlight = new InFlightPayments({ now: () => 0 });
    const hold = inFlight.open();
    inFlight.reserve(hold, payment());
    inFlight.reserve(hold, payment({ amount: 30n }));
    assert.deepEqual(inFlight.total(NETWORK, ASSET, PAYER), { count: 1, amount: 30n }, "the second replaced the first");
    assert.deepEqual(inFlight.total(NETWORK, ASSET, PAYER, hold), none);
    const stranger: PaymentHold = { release: () => {} };
    assert.equal(inFlight.reserve(stranger, payment()), "released");
    assert.equal(inFlight.reserve(new InFlightPayments().open(), payment()), "released");
    assert.equal(inFlight.size, 1);
  });

  it("stops counting a reservation once its authorization's validBefore plus the margin has passed", () => {
    let now = 0;
    const inFlight = new InFlightPayments({ now: () => now });
    inFlight.reserve(inFlight.open(), payment());
    now = VALID_BEFORE * 1_000 + IN_FLIGHT_MARGIN_MS - 1;
    assert.deepEqual(inFlight.total(NETWORK, ASSET, PAYER), { count: 1, amount: 100n });
    now += 1;
    assert.deepEqual(inFlight.total(NETWORK, ASSET, PAYER), none);
    assert.equal(inFlight.size, 0, "and forgets it");
    assert.equal(IN_FLIGHT_MARGIN_MS, 120_000);
  });

  it("bounds its memory: when full it makes room from expired reservations, else refuses rather than forget a live one", () => {
    let now = 0;
    const inFlight = new InFlightPayments({ maxPayments: 2, now: () => now });
    assert.equal(inFlight.reserve(inFlight.open(), payment()), "reserved");
    assert.equal(inFlight.reserve(inFlight.open(), payment({ payer: OTHER_PAYER, validBefore: VALID_BEFORE * 10 })), "reserved");
    const refused = inFlight.open();
    assert.equal(inFlight.reserve(refused, payment({ validBefore: VALID_BEFORE * 10 })), "full");
    assert.deepEqual(inFlight.total(NETWORK, ASSET, PAYER), { count: 1, amount: 100n }, "the refused payment is not counted");
    now = VALID_BEFORE * 1_000 + IN_FLIGHT_MARGIN_MS;
    assert.equal(inFlight.reserve(refused, payment({ validBefore: VALID_BEFORE * 10 })), "reserved", "the expired one made room");
    assert.equal(inFlight.size, 2);
  });
});

describe("the hold of a paid call reaches x402's verify hooks", () => {
  const PAY_TO = `00${"11".repeat(32)}`;
  const adapter = (paymentHeader?: string): HTTPAdapter => ({
    getHeader: name => (/^payment-signature$/i.test(name) ? paymentHeader : undefined),
    getMethod: () => "POST",
    getPath: () => "/tools/0",
    getUrl: () => "http://127.0.0.1/tools/0",
    getAcceptHeader: () => "application/json",
    getUserAgent: () => "test",
  });

  it("through the request context, which x402 2.29 copies into the hooks' transportContext, before and after verify", async () => {
    const facilitator: FacilitatorClient = {
      verify: async () => ({ isValid: true }),
      settle: () => Promise.reject(new Error("unused")),
      getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK as Network }], extensions: [], signers: {} }),
    };
    const resourceServer = new x402ResourceServer(facilitator).register(
      NETWORK as Network,
      new CascetCasperServerScheme([{ network: NETWORK, asset: ASSET, decimals: 9 }]),
    );
    const seen: Array<PaymentHold | undefined> = [];
    const seenAfter: Array<PaymentHold | undefined> = [];
    resourceServer.onBeforeVerify(async ({ transportContext }) => {
      seen.push(paymentHoldOf(transportContext));
    });
    resourceServer.onAfterVerify(async ({ transportContext }) => {
      seenAfter.push(paymentHoldOf(transportContext));
    });
    await resourceServer.initialize();
    const http = new x402HTTPResourceServer(resourceServer, {
      "POST /tools/0": {
        accepts: { scheme: "exact", network: NETWORK as Network, payTo: PAY_TO, price: { asset: ASSET, amount: "500", extra: { name: "T", version: "1" } } },
      },
    });
    const unpaid = await http.processHTTPRequest({ adapter: adapter(), path: "/tools/0", method: "POST" });
    assert.equal(unpaid.type, "payment-error");
    const challenge = unpaid.type === "payment-error" ? unpaid.response.headers["PAYMENT-REQUIRED"] : undefined;
    assert.ok(challenge);
    const header = encodePaymentSignatureHeader({ x402Version: 2, accepted: decodePaymentRequiredHeader(challenge).accepts[0]!, payload: {} });

    const hold = new InFlightPayments().open();
    const verified = await http.processHTTPRequest(withPaymentHold({ adapter: adapter(header), path: "/tools/0", method: "POST", paymentHeader: header }, hold));
    assert.equal(verified.type, "payment-verified");
    await http.processHTTPRequest({ adapter: adapter(header), path: "/tools/0", method: "POST", paymentHeader: header });
    assert.deepEqual(seen, [hold, undefined], "a context without a hold carries none");
    assert.deepEqual(seenAfter, [hold, undefined], "the hook after verify gets the same context");
  });

  it("and is found only where a hold was put", () => {
    const hold = new InFlightPayments().open();
    const context = withPaymentHold({ path: "/tools/0" }, hold);
    assert.equal(paymentHoldOf({ request: context }), hold);
    assert.equal(paymentHoldOf({ request: { ...context } }), hold, "a copy keeps it");
    assert.deepEqual(JSON.parse(JSON.stringify(context)), { path: "/tools/0" }, "never serialized");
    for (const transportContext of [undefined, null, "x", {}, { request: null }, { request: { path: "/tools/0" } }]) {
      assert.equal(paymentHoldOf(transportContext), undefined);
    }
  });
});
