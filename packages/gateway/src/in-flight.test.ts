import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient, type HTTPAdapter } from "@x402/core/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { Network } from "@x402/core/types";
import { IN_FLIGHT_MARGIN_MS, InFlightPayments, paymentHoldOf, withPaymentHold, type InFlightPayment, type PaymentHold } from "./in-flight.js";
import { seedInFlight } from "./server.js";
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
    const stranger: PaymentHold = { release: () => {}, keepUntilExpiry: () => {} };
    assert.equal(inFlight.reserve(stranger, payment()), "released");
    assert.equal(inFlight.reserve(new InFlightPayments().open(), payment()), "released");
    assert.equal(inFlight.size, 1);
  });

  it("keeps the reservation of a call whose payment may still execute until it expires, whatever release() follows", () => {
    let now = 0;
    const inFlight = new InFlightPayments({ now: () => now });
    const hold = inFlight.open();
    inFlight.reserve(hold, payment());
    hold.keepUntilExpiry();
    hold.release();
    assert.deepEqual(inFlight.total(NETWORK, ASSET, PAYER), { count: 1, amount: 100n }, "still counts after its call ended");
    assert.equal(inFlight.reserve(hold, payment({ amount: 7n })), "released", "nothing more is reserved on it");
    assert.deepEqual(inFlight.total(NETWORK, ASSET, PAYER), { count: 1, amount: 100n });
    now = VALID_BEFORE * 1_000 + IN_FLIGHT_MARGIN_MS;
    assert.deepEqual([inFlight.total(NETWORK, ASSET, PAYER), inFlight.size], [none, 0], "until it expires");
    // The first end counts: a call that was released keeps nothing.
    const released = inFlight.open();
    inFlight.reserve(released, payment({ validBefore: VALID_BEFORE * 10 }));
    released.release();
    released.keepUntilExpiry();
    assert.equal(inFlight.size, 0);
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

  it("keeps a payment with no call of its own until it expires (an unknown payment from before a restart), unless it already expired", () => {
    let now = 0;
    const inFlight = new InFlightPayments({ maxPayments: 2, now: () => now });
    assert.equal(inFlight.keep(payment()), "kept");
    assert.deepEqual(inFlight.total(NETWORK, ASSET, PAYER), { count: 1, amount: 100n });
    assert.equal(inFlight.keep(payment({ payer: OTHER_PAYER, validBefore: VALID_BEFORE * 10 })), "kept");
    assert.equal(inFlight.keep(payment({ amount: 7n, validBefore: VALID_BEFORE * 10 })), "full", "never by forgetting a live one");
    assert.deepEqual(inFlight.total(NETWORK, ASSET, PAYER), { count: 1, amount: 100n });
    now = VALID_BEFORE * 1_000 + IN_FLIGHT_MARGIN_MS;
    assert.deepEqual(inFlight.total(NETWORK, ASSET, PAYER), none, "until it expires");
    assert.equal(inFlight.keep(payment()), "expired", "an expired one is not kept at all");
    assert.equal(inFlight.size, 1);
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

describe("seedInFlight: what a restarted gateway keeps counting", () => {
  const record = (paymentId: string, overrides: Record<string, unknown> = {}) => ({
    kind: "authorization" as const,
    payer: PAYER,
    nonce: paymentId.padEnd(64, "0"),
    validBefore: 1_000,
    asset: ASSET,
    amountRaw: "100",
    paymentId,
    tool: "t",
    createdAt: "2026-11-02T00:00:00.000Z",
    ...overrides,
  });
  const receipt = (id: string, status: string, overrides: Record<string, unknown> = {}) => ({
    id,
    status,
    network: NETWORK,
    asset: ASSET,
    payer: PAYER,
    amountRaw: "100",
    ...overrides,
  });
  const seed = (records: unknown[], receipts: unknown[], clock: { now: number }, assets = [{ packageHash: ASSET }]) => {
    const inFlight = new InFlightPayments({ now: () => clock.now });
    const rail = { preflightAssets: assets, network: NETWORK, inFlight } as unknown as Parameters<typeof seedInFlight>[0];
    const store = { authorizations: () => records, list: () => receipts } as unknown as Parameters<typeof seedInFlight>[1];
    return { kept: seedInFlight(rail, store), counted: () => inFlight.total(NETWORK, ASSET, PAYER) };
  };

  it("counts an unknown receipt and a call that died before its receipt, not a settled or failed one", () => {
    const clock = { now: 0 };
    const { kept, counted } = seed(
      [record("unknown"), record("died"), record("settled"), record("failed")],
      [receipt("unknown", "unknown"), receipt("settled", "settled"), receipt("failed", "failed")],
      clock,
    );
    assert.equal(kept, 2);
    assert.deepEqual(counted(), { count: 2, amount: 200n });
  });

  it("keeps them until the write-ahead validBefore plus the margin, and not one moment longer", () => {
    const clock = { now: 0 };
    const { counted } = seed([record("unknown"), record("died", { validBefore: 2_000 })], [receipt("unknown", "unknown")], clock);
    assert.equal(counted().count, 2);
    clock.now = 1_000 * 1_000 + IN_FLIGHT_MARGIN_MS - 1;
    assert.equal(counted().count, 2);
    clock.now = 1_000 * 1_000 + IN_FLIGHT_MARGIN_MS;
    assert.deepEqual(counted(), { count: 1, amount: 100n }, "the first authorization can no longer execute");
    clock.now = 2_000 * 1_000 + IN_FLIGHT_MARGIN_MS;
    assert.equal(counted().count, 0);
    // One already past that is not counted at all.
    assert.equal(seed([record("died")], [], clock).kept, 0);
  });

  it("skips what it cannot price or does not preflight: an old record, another token, another network", () => {
    const clock = { now: 0 };
    const skipped = seed(
      [record("old", { amountRaw: undefined }), record("other", { asset: "ee".repeat(32) }), record("net"), record("bad", { amountRaw: "1e9" })],
      [receipt("net", "unknown", { network: "casper:casper" })],
      clock,
    );
    assert.equal(skipped.kept, 0);
    assert.equal(seed([record("died")], [], clock, []).kept, 0, "no preflighted token");
  });
});
