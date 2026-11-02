import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import casperSdk from "casper-js-sdk";
import { buildTransferWithAuthorizationDigest } from "@x402/casper";
import { x402Client } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import {
  buildSpendControls,
  CASCET_SPEND_CONTROLS,
  createPayingFetch,
  createPaymentClient,
  explainPaymentError,
  MAX_402_BODY_BYTES,
  optionAuthorizationStyle,
  PaymentRefusedError,
  PendingReservations,
  preferStylesPolicy,
  refusalReason,
  spendPolicyFilter,
  type PayingFetchOptions,
  type PaymentInfo,
} from "./paying-fetch.js";
import { clientSignerFromPem, createCasperClientScheme } from "./casper-scheme.js";
import { RequestTimeoutError, ResponseTooLargeError, settleOnAbort, withDeadline } from "./http.js";
import { SpendPolicy } from "./policy.js";

const { KeyAlgorithm, PrivateKey, PublicKey } = casperSdk;

const SELLER = "00" + "a1".repeat(32);
const OTHER_SELLER = "00" + "b2".repeat(32);
const ASSET_A = "d4".repeat(32);
const ASSET_B = "e5".repeat(32);
/** CasCet X402 Token on testnet: transfer_with_authorization takes `amount`. */
const LEGACY = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
/** Wrapped CSPR on testnet: a CEP-3009 token, transfer_with_authorization takes `value`. */
const WCSPR = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";

interface Hit {
  path: string;
  signature?: string;
  parentId?: string;
  /** When the connection closed (Date.now()); for /hang only when the client aborted it. */
  closedAt?: number;
}

interface FakeGateway {
  url: (path?: string) => string;
  hits: Hit[];
  /** Requirements served in the next 402s (entries need not be well-formed). */
  accepts: unknown[];
  /** x402Version of the next 402s (default 2). */
  x402Version: unknown;
  close: () => Promise<void>;
}

function requirement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "exact",
    network: "casper:casper-test",
    asset: ASSET_A,
    amount: "100",
    payTo: SELLER,
    maxTimeoutSeconds: 300,
    extra: { name: "CasCet X402 Token", version: "1" },
    ...overrides,
  };
}

/**
 * A tiny x402 resource: 402 without PAYMENT-SIGNATURE, 200 with it. /hang never answers; /redirect redirects;
 * /big402 streams a 402 body larger than MAX_402_BODY_BYTES (chunked), /big402-declared declares one;
 * /reject-paid answers 402 to the paid retry too (as a gateway whose verification failed); /slow402 answers
 * its 402 after 600 ms.
 */
async function startFakeGateway(): Promise<FakeGateway> {
  const hits: Hit[] = [];
  const state: { accepts: unknown[]; x402Version: unknown } = { accepts: [requirement()], x402Version: 2 };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = req.url ?? "/";
      const hit: Hit = {
        path,
        signature: req.headers["payment-signature"] as string | undefined,
        parentId: req.headers["x-cascet-parent-id"] as string | undefined,
      };
      hits.push(hit);
      res.on("close", () => (hit.closedAt = Date.now()));
      if (path === "/hang") return; // never answer
      if (path === "/slow402" && req.headers["payment-signature"] === undefined) {
        setTimeout(() => answer(path), 600);
        return;
      }
      answer(path);
    });
    const answer = (path: string): void => {
      if (path === "/redirect") {
        res.writeHead(307, { location: "/elsewhere" }).end();
        return;
      }
      const signature = req.headers["payment-signature"];
      if (typeof signature !== "string" || path === "/reject-paid") {
        const paymentRequired = {
          x402Version: state.x402Version,
          resource: { url: `http://127.0.0.1${path}`, description: "paid tool", mimeType: "application/json" },
          accepts: state.accepts,
        };
        const headers = {
          "content-type": "application/json",
          "payment-required": Buffer.from(JSON.stringify(paymentRequired)).toString("base64"),
        };
        const big = "x".repeat(MAX_402_BODY_BYTES);
        if (path === "/big402") {
          res.writeHead(402, headers); // no content-length: chunked, so only the stream cap can stop it
          res.write(big);
          res.write(big);
          res.end();
          return;
        }
        if (path === "/big402-declared") {
          res.writeHead(402, headers).end(`${big}${big}`);
          return;
        }
        res.writeHead(402, headers).end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    };
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: (path = "/mcp") => `http://127.0.0.1:${port}${path}`,
    hits,
    get accepts() {
      return state.accepts;
    },
    set accepts(value) {
      state.accepts = value;
    },
    get x402Version() {
      return state.x402Version;
    },
    set x402Version(value) {
      state.x402Version = value;
    },
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Resolves once `condition` holds, polling every 10 ms; rejects after `ms`. */
async function until(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function decodeSignature(header: string): { accepted: Record<string, unknown>; payload: { authorization: Record<string, string> } } {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

describe("settleOnAbort and withDeadline", () => {
  it("end a call at its deadline even when the fetch never settles and ignores its signal", { timeout: 5_000 }, async () => {
    // Nothing else holds the event loop open, and on Node 22 and 23 node:test cancels a test whose only
    // pending handle is an unref'd timer (the deadline's), with every test after it in the file.
    const keepAlive = setTimeout(() => undefined, 1_000);
    try {
      const never: () => Promise<Response> = () => new Promise<Response>(() => undefined);
      const started = Date.now();
      await assert.rejects(withDeadline(never, 50)("http://127.0.0.1:9/x"), RequestTimeoutError);
      assert.ok(Date.now() - started < 1_000);
      const controller = new AbortController();
      const pending = settleOnAbort(new Promise<string>(() => undefined), controller.signal);
      controller.abort(new Error("caller gave up"));
      await assert.rejects(pending, /caller gave up/);
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it("pass the result through, and cancel the body of a response that arrives after the abort", { timeout: 5_000 }, async () => {
    assert.equal(await settleOnAbort(Promise.resolve("ok"), new AbortController().signal), "ok");
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream({ cancel: () => void (cancelled = true) });
    let deliver: (response: Response) => void = () => undefined;
    const late = settleOnAbort(new Promise<Response>(resolve => (deliver = resolve)), controller.signal);
    controller.abort(new Error("over"));
    await assert.rejects(late, /over/);
    deliver(new Response(body));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(cancelled, true);
  });
});

describe("createPayingFetch", () => {
  let gateway: FakeGateway;
  let keyDir: string;
  let keyPath: string;
  const quiet = (): void => undefined;

  const make = (overrides: Partial<PayingFetchOptions> = {}) =>
    createPayingFetch({
      privateKeyPath: keyPath,
      allowedPayTo: [SELLER],
      allowedAssets: [ASSET_A],
      budget: { maxPerCallRaw: "1000", maxSessionRaw: "5000" },
      logger: quiet,
      ...overrides,
    });

  before(async () => {
    gateway = await startFakeGateway();
    // A throwaway key generated for this test run only.
    keyDir = mkdtempSync(join(tmpdir(), "cascet-client-test-"));
    keyPath = join(keyDir, "throwaway-test-key.pem");
    writeFileSync(keyPath, PrivateKey.generate(KeyAlgorithm.ED25519).toPem(), { mode: 0o600 });
  });

  after(async () => {
    await gateway.close();
    rmSync(keyDir, { recursive: true, force: true });
  });

  it("pays an allowed 402 and reports the payment after signing", async () => {
    gateway.accepts = [requirement({ amount: "250" })];
    const payments: unknown[] = [];
    const paying = await make({ parentId: "parent-123", onPayment: info => payments.push(info) });
    const before = gateway.hits.length;
    const response = await paying.fetch(gateway.url(), { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
    const hits = gateway.hits.slice(before);
    assert.equal(hits.length, 2);
    assert.equal(hits[0]?.signature, undefined);
    assert.equal(hits[1]?.parentId, "parent-123");
    const signed = decodeSignature(hits[1]?.signature ?? "");
    assert.equal(signed.accepted.payTo, SELLER);
    assert.equal(signed.payload.authorization.to, SELLER);
    assert.equal(signed.payload.authorization.value, "250");
    assert.deepEqual(payments, [{ amountRaw: "250", payTo: SELLER, network: "casper:casper-test", asset: ASSET_A }]);
    assert.equal(paying.spentRaw(), "250");
    assert.deepEqual(paying.spentByAsset?.(), { [ASSET_A]: "250" });
  });

  it("aborts when the 402 names a network the client does not pay on (M02)", async () => {
    gateway.accepts = [requirement({ network: "casper:casper" })];
    const paying = await make();
    const before = gateway.hits.length;
    await assert.rejects(paying.fetch(gateway.url(), { method: "POST", body: "{}" }), (err: Error) => {
      assert.ok(err instanceof PaymentRefusedError);
      assert.match(err.message, /asks for payment on casper:casper, but this client only pays on casper:casper-test/);
      return true;
    });
    assert.ok(gateway.hits.slice(before).every(hit => hit.signature === undefined), "nothing may be signed");
    assert.equal(paying.spentRaw(), "0");
  });

  it("pays on mainnet only when casper:casper is listed", async () => {
    gateway.accepts = [requirement({ network: "casper:casper" })];
    const paying = await make({ networks: ["casper:casper"] });
    const response = await paying.fetch(gateway.url(), { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
  });

  it("picks the option the policy accepts when a 402 offers several, and reports its style", async () => {
    gateway.accepts = [
      requirement({ asset: ASSET_B, extra: { name: "Other Token", version: "1", authorizationStyle: "cep3009-value" } }),
      requirement({ payTo: OTHER_SELLER, extra: { name: "CasCet X402 Token", version: "1", authorizationStyle: "legacy-amount" } }),
      requirement({ amount: "300", extra: { name: "CasCet X402 Token", version: "1", authorizationStyle: "legacy-amount" } }),
    ];
    const payments: unknown[] = [];
    const paying = await make({ onPayment: info => payments.push(info) });
    const before = gateway.hits.length;
    assert.equal((await paying.fetch(gateway.url(), { method: "POST", body: "{}" })).status, 200);
    const signed = decodeSignature(gateway.hits.slice(before)[1]?.signature ?? "");
    assert.equal(signed.accepted.asset, ASSET_A);
    assert.equal(signed.accepted.payTo, SELLER);
    assert.equal(signed.accepted.amount, "300");
    assert.deepEqual(payments, [
      { amountRaw: "300", payTo: SELLER, network: "casper:casper-test", asset: ASSET_A, authorizationStyle: "legacy-amount" },
    ]);
  });

  it("still names the precise reason when no offered option is acceptable", async () => {
    gateway.accepts = [requirement({ asset: ASSET_B }), requirement({ payTo: OTHER_SELLER })];
    const paying = await make();
    await assert.rejects(paying.fetch(gateway.url(), { method: "POST", body: "{}" }), (err: Error) => {
      assert.ok(err instanceof PaymentRefusedError);
      assert.match(err.message, /asset .* is not allowlisted/);
      return true;
    });
  });

  it("refuses an authorization style it does not know, and signs nothing", async () => {
    gateway.accepts = [requirement({ extra: { name: "CasCet X402 Token", version: "1", authorizationStyle: "permit2" } })];
    const paying = await make();
    const before = gateway.hits.length;
    await assert.rejects(paying.fetch(gateway.url(), { method: "POST", body: "{}" }), /unknown authorization style "permit2"/);
    assert.ok(gateway.hits.slice(before).every(hit => hit.signature === undefined));
    assert.equal(paying.spentRaw(), "0");
  });

  it("pays tokens x402 does not know as defaults, above x402's $1 default cap (2.29 spend controls)", async () => {
    // @x402/core 2.29 would only pay its default asset (csprUSD) and drop this offer.
    assert.deepEqual(CASCET_SPEND_CONTROLS, { allowedAssets: true, maxAmountPerPayment: false });
    gateway.accepts = [requirement({ asset: ASSET_B, amount: "900000000000000" })];
    const paying = await make({ allowedAssets: undefined, budget: undefined });
    const response = await paying.fetch(gateway.url(), { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
    assert.deepEqual(paying.spentByAsset?.(), { [ASSET_B]: "900000000000000" });
  });

  it("refuses a negative price and leaves the budget untouched (M32)", async () => {
    gateway.accepts = [requirement({ amount: "-1000000" })];
    const paying = await make();
    const before = gateway.hits.length;
    await assert.rejects(paying.fetch(gateway.url(), { method: "POST", body: "{}" }), (err: Error) => {
      assert.ok(err instanceof PaymentRefusedError);
      assert.match(err.message, /malformed price/);
      return true;
    });
    assert.ok(gateway.hits.slice(before).every(hit => hit.signature === undefined));
    assert.equal(paying.spentRaw(), "0");
  });

  it("refuses a payee or asset outside the allowlists", async () => {
    const paying = await make();
    gateway.accepts = [requirement({ payTo: OTHER_SELLER })];
    await assert.rejects(paying.fetch(gateway.url(), { method: "POST", body: "{}" }), /payTo .* is not allowlisted/);
    gateway.accepts = [requirement({ asset: ASSET_B })];
    await assert.rejects(paying.fetch(gateway.url(), { method: "POST", body: "{}" }), /asset .* is not allowlisted/);
  });

  it("enforces the per-call budget", async () => {
    const paying = await make({ budget: { maxPerCallRaw: "400", maxSessionRaw: "5000" } });
    const before = gateway.hits.length;
    gateway.accepts = [requirement({ amount: "401" })];
    await assert.rejects(paying.fetch(gateway.url(), { method: "POST", body: "{}" }), /per-call budget 400/);
    assert.ok(gateway.hits.slice(before).every(hit => hit.signature === undefined));
    gateway.accepts = [requirement({ amount: "400" })];
    assert.equal((await paying.fetch(gateway.url(), { method: "POST", body: "{}" })).status, 200);
    assert.equal(paying.spentRaw(), "400");
  });

  it("caps the session per asset across calls", async () => {
    const paying = await make({
      allowedAssets: [ASSET_A, ASSET_B],
      budget: { maxPerCallRaw: "400", maxSessionRaw: "700" },
    });
    gateway.accepts = [requirement({ amount: "400" })];
    assert.equal((await paying.fetch(gateway.url(), { method: "POST", body: "{}" })).status, 200);
    await assert.rejects(
      paying.fetch(gateway.url(), { method: "POST", body: "{}" }),
      /would exceed the session budget 700 for asset/,
    );
    gateway.accepts = [requirement({ amount: "400", asset: ASSET_B })];
    assert.equal((await paying.fetch(gateway.url(), { method: "POST", body: "{}" })).status, 200);
    assert.deepEqual(paying.spentByAsset?.(), { [ASSET_A]: "400", [ASSET_B]: "400" });
    assert.equal(paying.spentRaw(), "800");
  });

  it("validates options before reading the key", async () => {
    await assert.rejects(make({ budget: { maxPerCallRaw: "-5" } }), /budget\.maxPerCallRaw/);
    await assert.rejects(make({ budget: { maxSessionRaw: "1e9" } }), /budget\.maxSessionRaw/);
    await assert.rejects(make({ networks: ["casper:*"] }), /wildcards are not allowed/);
    await assert.rejects(make({ timeoutMs: 0 }), /timeoutMs/);
    await assert.rejects(make({ allowedPayTo: ["01" + "ab".repeat(32)] }), /account-hash/);
    // Unknown keys are rejected so a misspelled safety option is never ignored (M23).
    await assert.rejects(
      createPayingFetch({ privateKeyPath: keyPath, allowedPayto: [SELLER] } as unknown as PayingFetchOptions),
      /unknown option\(s\) allowedPayto/,
    );
    await assert.rejects(
      createPayingFetch({ privateKeyPath: keyPath, budget: { maxSession: "5" } } as unknown as PayingFetchOptions),
      /unknown option\(s\) maxSession/,
    );
  });

  it("warns once per logger when allowlists or budgets are missing", async () => {
    const lines: string[] = [];
    const logger = (line: string) => lines.push(line);
    await createPayingFetch({ privateKeyPath: keyPath, logger });
    await createPayingFetch({ privateKeyPath: keyPath, logger });
    assert.equal(lines.filter(line => line.includes("no allowedPayTo")).length, 1);
    assert.equal(lines.filter(line => line.includes("no allowedAssets")).length, 1);
    assert.equal(lines.filter(line => line.includes("no budget")).length, 1);
    const fresh: string[] = [];
    await make({ logger: line => fresh.push(line) });
    assert.deepEqual(fresh, [], "no warning when allowlists and budgets are set");
  });

  it("times out a hung gateway (M06)", async () => {
    const paying = await make({ timeoutMs: 200 });
    const started = Date.now();
    await assert.rejects(paying.fetch(gateway.url("/hang"), { method: "POST", body: "{}" }), (err: Error) => {
      assert.ok(err instanceof RequestTimeoutError, `expected RequestTimeoutError, got ${err.name}`);
      assert.match(err.message, /timed out after 200 ms/);
      return true;
    });
    assert.ok(Date.now() - started < 5_000);
    await assert.rejects(paying.fetchUnpaid!(gateway.url("/hang"), { method: "POST", body: "{}" }), RequestTimeoutError);
  });

  describe("when fetch would lose a Request's own abort signal", () => {
    // undici's Request follows its parent's signal through a weak reference, so a garbage collection
    // that collects an intermediate Request cuts the chain. This stand-in cuts it every time: a
    // Request's own signal is dropped, and only a signal handed to fetch itself still aborts it.
    let realFetch: typeof fetch;
    beforeEach(() => {
      realFetch = globalThis.fetch;
      globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        realFetch(new Request(input, { signal: init?.signal ?? null }))) as typeof fetch;
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it("aborts a hung request on the wire at the deadline", { timeout: 10_000 }, async () => {
      const paying = await make({ timeoutMs: 200 });
      for (const call of [paying.fetch, paying.fetchUnpaid!]) {
        const before = gateway.hits.length;
        const started = Date.now();
        await assert.rejects(call(gateway.url("/hang"), { method: "POST", body: "{}" }), RequestTimeoutError);
        assert.ok(Date.now() - started < 2_000);
        await until(() => gateway.hits[before]?.closedAt !== undefined, 2_000, "the gateway to see the request aborted");
      }
    });

    it("never sends the paid retry once the call is over, even when the 402 comes back later", { timeout: 10_000 }, async () => {
      // Every signal dropped: the first request runs on to its 402 (at 600 ms) after the caller got its timeout
      // (at 200 ms), and @x402/fetch then signs a payment and tries to send it.
      globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => realFetch(new Request(input, { signal: null }))) as typeof fetch;
      const paying = await make({ timeoutMs: 200 });
      const before = gateway.hits.length;
      const started = Date.now();
      await assert.rejects(paying.fetch(gateway.url("/slow402"), { method: "POST", body: "{}" }), RequestTimeoutError);
      assert.ok(Date.now() - started < 2_000);
      await until(() => gateway.hits[before]?.closedAt !== undefined, 3_000, "the late 402 to be answered");
      await new Promise(resolve => setTimeout(resolve, 500)); // a paid retry would follow the 402 right away
      const hits = gateway.hits.slice(before);
      assert.deepEqual(hits.map(h => [h.path, h.signature]), [["/slow402", undefined]], "no paid retry was sent");
    });
  });

  it("honors the caller's abort signal", async () => {
    const paying = await make();
    const controller = new AbortController();
    const pending = paying.fetch(gateway.url("/hang"), { method: "POST", body: "{}", signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, (err: Error) => {
      assert.equal(err instanceof RequestTimeoutError, false);
      assert.equal(err.name, "AbortError");
      return true;
    });
  });

  it("does not follow redirects", async () => {
    const paying = await make();
    const before = gateway.hits.length;
    await assert.rejects(paying.fetch(gateway.url("/redirect"), { method: "POST", body: "{}" }), /does not follow redirects/);
    assert.deepEqual(
      gateway.hits.slice(before).map(hit => hit.path),
      ["/redirect"],
    );
  });

  it("refuses an oversized 402 body before x402 reads it, and signs nothing (L117)", async () => {
    gateway.accepts = [requirement()];
    const paying = await make();
    for (const path of ["/big402", "/big402-declared"]) {
      const before = gateway.hits.length;
      await assert.rejects(paying.fetch(gateway.url(path), { method: "POST", body: "{}" }), (err: Error) => {
        assert.ok(err instanceof ResponseTooLargeError, `${path}: expected ResponseTooLargeError, got ${err.name}: ${err.message}`);
        assert.match(err.message, new RegExp(`402 response .*${MAX_402_BODY_BYTES}-byte limit`));
        return true;
      });
      assert.deepEqual(
        gateway.hits.slice(before).map(hit => hit.signature),
        [undefined],
        `${path}: one unpaid request, no PAYMENT-SIGNATURE`,
      );
    }
    assert.equal(paying.spentRaw(), "0");
    // A normal 402 still works afterwards.
    assert.equal((await paying.fetch(gateway.url(), { method: "POST", body: "{}" })).status, 200);
  });

  it("gives the reserved budget back when signing fails after the policy approved the payment", async t => {
    const paying = await make({ budget: { maxPerCallRaw: "600", maxSessionRaw: "600" } });
    // The key cannot sign (a signing device that went away, say): @x402/casper throws after the policy reserved 600.
    const reservedWhenSigning: string[] = [];
    const keyUnavailable = t.mock.method(PrivateKey.prototype, "signAndAddAlgorithmBytes", () => {
      reservedWhenSigning.push(paying.spentRaw());
      throw new Error("the signing key is unavailable");
    });
    gateway.accepts = [requirement({ amount: "600" })];
    const before = gateway.hits.length;
    await assert.rejects(paying.fetch(gateway.url(), { method: "POST", body: "{}" }), /failed_to_sign: the signing key is unavailable/);
    assert.deepEqual(reservedWhenSigning, ["600"], "the policy approved the payment and reserved it before signing");
    assert.ok(gateway.hits.slice(before).every(hit => hit.signature === undefined), "nothing was signed or sent");
    assert.equal(paying.spentRaw(), "0");
    assert.deepEqual(paying.spentByAsset?.(), {});
    // The whole session budget is still available.
    keyUnavailable.mock.restore();
    assert.equal((await paying.fetch(gateway.url(), { method: "POST", body: "{}" })).status, 200);
    assert.equal(paying.spentRaw(), "600");
  });

  it("fetchUnpaid never answers a 402", async () => {
    gateway.accepts = [requirement()];
    const paying = await make();
    const before = gateway.hits.length;
    const response = await paying.fetchUnpaid!(gateway.url(), { method: "POST", body: "{}" });
    assert.equal(response.status, 402);
    assert.equal(gateway.hits.length - before, 1);
    assert.equal(paying.spentRaw(), "0");
  });
});

/** An accepts entry as a CasCet gateway builds it for CasCet's legacy-amount token. */
function legacyOption(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return requirement({
    asset: LEGACY,
    amount: "500",
    extra: { name: "CasCet X402 Token", symbol: "CXT", version: "1", decimals: "9", authorizationStyle: "legacy-amount" },
    ...overrides,
  });
}

/** An accepts entry as a CasCet gateway builds it for Wrapped CSPR (cep3009-value). */
function wcsprOption(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return requirement({
    asset: WCSPR,
    amount: "400",
    extra: { name: "Wrapped CSPR", symbol: "WCSPR", version: "1", decimals: "9", authorizationStyle: "cep3009-value" },
    ...overrides,
  });
}

/** A v2 PAYMENT-REQUIRED offering `accepts` (entries need not be well-formed), for driving x402's client directly. */
function challenge(...accepts: unknown[]): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: "http://127.0.0.1/mcp", description: "paid tool", mimeType: "application/json" },
    accepts: accepts as unknown as PaymentRequirements[],
  };
}

interface SignedPayment {
  accepted: Record<string, unknown>;
  payload: {
    signature: string;
    publicKey: string;
    authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
  };
}

/** Whether the payment's signature verifies against the EIP-712 domain of `name`/`asset`. */
function signedFor(signed: SignedPayment, name: string, asset: string): boolean {
  const digest = buildTransferWithAuthorizationDigest({
    name,
    version: "1",
    network: "casper:casper-test",
    asset,
    authorization: signed.payload.authorization,
  });
  try {
    return PublicKey.fromHex(signed.payload.publicKey).verifySignature(digest, Uint8Array.from(Buffer.from(signed.payload.signature, "hex")));
  } catch {
    return false; // casper-js-sdk throws "invalid signature" on a mismatch
  }
}

describe("createPayingFetch with a legacy-amount and a cep3009-value token side by side", () => {
  let gateway: FakeGateway;
  let keyDir: string;
  let keyPath: string;

  const make = (overrides: Partial<PayingFetchOptions> = {}) =>
    createPayingFetch({
      privateKeyPath: keyPath,
      allowedPayTo: [SELLER],
      allowedAssets: [LEGACY, WCSPR],
      budget: { maxPerCallRaw: "1000", maxSessionRaw: "5000" },
      logger: () => undefined,
      ...overrides,
    });

  /** Pay one call and return what was signed, plus what onPayment saw. */
  async function payOnce(paying: Awaited<ReturnType<typeof make>>, payments: PaymentInfo[] = []) {
    const before = gateway.hits.length;
    const response = await paying.fetch(gateway.url(), { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
    const hits = gateway.hits.slice(before);
    assert.equal(hits.length, 2, "one unpaid request, one paid retry");
    return { signed: JSON.parse(Buffer.from(hits[1]?.signature ?? "", "base64").toString("utf8")) as SignedPayment, payments };
  }

  /** The call is refused before anything is signed, and nothing is reserved. */
  async function refused(paying: Awaited<ReturnType<typeof make>>, pattern: RegExp, path = "/mcp") {
    const before = gateway.hits.length;
    const spent = paying.spentRaw();
    await assert.rejects(paying.fetch(gateway.url(path), { method: "POST", body: "{}" }), (err: Error) => {
      assert.ok(err instanceof PaymentRefusedError, `expected PaymentRefusedError, got ${err.name}: ${err.message}`);
      assert.match(err.message, pattern);
      return true;
    });
    assert.deepEqual(
      gateway.hits.slice(before).map(hit => hit.signature),
      [undefined],
      "one unpaid request and no PAYMENT-SIGNATURE",
    );
    assert.equal(paying.spentRaw(), spent, "nothing reserved");
  }

  before(async () => {
    gateway = await startFakeGateway();
    // A throwaway key generated for this test run only.
    keyDir = mkdtempSync(join(tmpdir(), "cascet-client-styles-test-"));
    keyPath = join(keyDir, "throwaway-test-key.pem");
    writeFileSync(keyPath, PrivateKey.generate(KeyAlgorithm.ED25519).toPem(), { mode: 0o600 });
  });

  after(async () => {
    await gateway.close();
    rmSync(keyDir, { recursive: true, force: true });
  });

  it("pays the first acceptable option, echoes it as accepted (style included) and signs its token's domain", async () => {
    gateway.accepts = [legacyOption(), wcsprOption()];
    const payments: PaymentInfo[] = [];
    const { signed } = await payOnce(await make({ onPayment: info => payments.push(info) }), payments);
    assert.deepEqual(signed.accepted, legacyOption(), "accepted is the gateway's entry, extra.authorizationStyle included");
    assert.equal(signed.payload.authorization.value, "500");
    assert.equal(signed.payload.authorization.to, SELLER);
    assert.equal(signedFor(signed, "CasCet X402 Token", LEGACY), true);
    assert.equal(signedFor(signed, "Wrapped CSPR", WCSPR), false);
    assert.deepEqual(payments, [
      { amountRaw: "500", payTo: SELLER, network: "casper:casper-test", asset: LEGACY, authorizationStyle: "legacy-amount" },
    ]);
  });

  it("lets the asset allowlist pick the token", async () => {
    gateway.accepts = [legacyOption(), wcsprOption()];
    const payments: PaymentInfo[] = [];
    const paying = await make({ allowedAssets: [`hash-${WCSPR.toUpperCase()}`], onPayment: info => payments.push(info) });
    const { signed } = await payOnce(paying, payments);
    assert.deepEqual(signed.accepted, wcsprOption());
    assert.equal((signed.accepted.extra as Record<string, unknown>).authorizationStyle, "cep3009-value");
    assert.equal(signedFor(signed, "Wrapped CSPR", WCSPR), true);
    assert.equal(signedFor(signed, "CasCet X402 Token", LEGACY), false);
    assert.deepEqual(payments, [
      { amountRaw: "400", payTo: SELLER, network: "casper:casper-test", asset: WCSPR, authorizationStyle: "cep3009-value" },
    ]);
    assert.deepEqual(paying.spentByAsset?.(), { [WCSPR]: "400" });

    await refused(await make({ allowedAssets: [ASSET_A] }), /none of the 2 payment options .* is acceptable: asset .* is not allowlisted/);
  });

  it("orders the acceptable options by preferStyles, and keeps the gateway's order without it", async () => {
    gateway.accepts = [legacyOption(), wcsprOption()];
    let { signed } = await payOnce(await make({ preferStyles: ["cep3009-value"] }));
    assert.equal(signed.accepted.asset, WCSPR);

    gateway.accepts = [wcsprOption(), legacyOption()];
    ({ signed } = await payOnce(await make({ preferStyles: ["legacy-amount", "cep3009-value"] })));
    assert.equal(signed.accepted.asset, LEGACY);
    assert.deepEqual(signed.accepted, legacyOption());

    ({ signed } = await payOnce(await make()));
    assert.equal(signed.accepted.asset, WCSPR, "no preference: the gateway's first acceptable option");
  });

  it("never makes a refused option payable through preferStyles", async () => {
    gateway.accepts = [wcsprOption(), legacyOption()];
    const { signed } = await payOnce(await make({ allowedAssets: [LEGACY], preferStyles: ["cep3009-value"] }));
    assert.equal(signed.accepted.asset, LEGACY);

    gateway.accepts = [wcsprOption()];
    await refused(await make({ allowedAssets: [LEGACY], preferStyles: ["cep3009-value"] }), /asset .* is not allowlisted/);
  });

  it("ranks and reports a token it knows by its known style, and reports no style for an unknown token that advertises none", async () => {
    const plain = (asset: string) => requirement({ asset, extra: { name: "Some Token", version: "1" } });
    gateway.accepts = [plain(ASSET_B), plain(LEGACY)];
    const payments: PaymentInfo[] = [];
    const paying = await make({ allowedAssets: [ASSET_B, LEGACY], preferStyles: ["legacy-amount"], onPayment: info => payments.push(info) });
    const { signed } = await payOnce(paying, payments);
    assert.equal(signed.accepted.asset, LEGACY, "a known legacy-amount token");
    assert.deepEqual(payments, [
      { amountRaw: "100", payTo: SELLER, network: "casper:casper-test", asset: LEGACY, authorizationStyle: "legacy-amount" },
    ]);

    gateway.accepts = [plain(ASSET_B)];
    await payOnce(paying, payments);
    assert.deepEqual(payments[1], { amountRaw: "100", payTo: SELLER, network: "casper:casper-test", asset: ASSET_B });
  });

  it("does not let a gateway steer preferStyles by mislabeling a token this client knows", async () => {
    // CasCet's legacy-amount token, labelled cep3009-value, next to Wrapped CSPR.
    const mislabeled = legacyOption({
      extra: { name: "CasCet X402 Token", symbol: "CXT", version: "1", decimals: "9", authorizationStyle: "cep3009-value" },
    });
    gateway.accepts = [mislabeled, wcsprOption()];
    const payments: PaymentInfo[] = [];
    const paying = await make({ preferStyles: ["cep3009-value"], onPayment: info => payments.push(info) });
    assert.equal((await payOnce(paying, payments)).signed.accepted.asset, WCSPR, "the token that really is cep3009-value");

    // Offered alone it is still paid (the label changes nothing that is signed), echoed as the gateway
    // sent it, and reported with the style this client knows.
    gateway.accepts = [mislabeled];
    const { signed } = await payOnce(paying, payments);
    assert.deepEqual(signed.accepted, mislabeled);
    assert.equal(signedFor(signed, "CasCet X402 Token", LEGACY), true);
    assert.deepEqual(payments, [
      { amountRaw: "400", payTo: SELLER, network: "casper:casper-test", asset: WCSPR, authorizationStyle: "cep3009-value" },
      { amountRaw: "500", payTo: SELLER, network: "casper:casper-test", asset: LEGACY, authorizationStyle: "legacy-amount" },
    ]);
  });

  it("skips an option with an unknown authorization style and aborts when every option has one", async () => {
    const unknownStyle = legacyOption({ extra: { name: "CasCet X402 Token", version: "1", authorizationStyle: "permit2" } });
    gateway.accepts = [unknownStyle, wcsprOption()];
    const { signed } = await payOnce(await make({ preferStyles: ["legacy-amount"] }));
    assert.equal(signed.accepted.asset, WCSPR);

    gateway.accepts = [unknownStyle];
    await refused(await make(), /unknown authorization style "permit2"; this client knows legacy-amount, cep3009-value/);
  });

  it("pays the next option when the first names no usable EIP-712 domain, and refuses when none does", async () => {
    // Listed first, such an option used to be selected and then fail at signing (missing_token_name)
    // instead of paying the next one.
    const style = { authorizationStyle: "cep3009-value" };
    const unusable = [
      wcsprOption({ extra: { version: "1", ...style } }),
      wcsprOption({ extra: { name: "Wrapped CSPR", ...style } }),
      wcsprOption({ extra: { name: "", version: "1", ...style } }),
      wcsprOption({ extra: { name: "W".repeat(101), version: "1", ...style } }),
    ];
    for (const option of unusable) {
      gateway.accepts = [option, legacyOption()];
      const payments: PaymentInfo[] = [];
      const paying = await make({ onPayment: info => payments.push(info) });
      const { signed } = await payOnce(paying, payments);
      assert.deepEqual(signed.accepted, legacyOption());
      assert.equal(signedFor(signed, "CasCet X402 Token", LEGACY), true);
      assert.deepEqual(payments, [
        { amountRaw: "500", payTo: SELLER, network: "casper:casper-test", asset: LEGACY, authorizationStyle: "legacy-amount" },
      ]);
      assert.deepEqual(paying.spentByAsset?.(), { [LEGACY]: "500" }, "nothing reserved for the refused option");
    }

    gateway.accepts = [unusable[0]];
    await refused(await make(), /^payment refused: malformed EIP-712 domain: extra\.name is missing$/);
    gateway.accepts = unusable;
    await refused(
      await make(),
      /^payment refused: none of the 4 payment options the gateway offers is acceptable: malformed EIP-712 domain: extra\.name is missing; malformed EIP-712 domain: extra\.version is missing; /,
    );
  });

  it("applies the per-call budget to every token and picks an option within it", async () => {
    gateway.accepts = [legacyOption({ amount: "500" }), wcsprOption({ amount: "450" })];
    const { signed } = await payOnce(await make({ budget: { maxPerCallRaw: "450", maxSessionRaw: "5000" } }));
    assert.equal(signed.accepted.asset, WCSPR);
    assert.equal(signed.payload.authorization.value, "450");

    gateway.accepts = [legacyOption({ amount: "500" }), wcsprOption({ amount: "451" })];
    const capped = await make({ budget: { maxPerCallRaw: "450", maxSessionRaw: "5000" } });
    await refused(capped, /price 500 exceeds the per-call budget 450; price 451 exceeds the per-call budget 450/);
    // The same without an asset allowlist (x402's spend controls are then open; the policy still caps).
    await refused(await make({ allowedAssets: undefined, budget: { maxPerCallRaw: "450" } }), /exceeds the per-call budget 450/);
  });

  it("refuses malformed amounts before signing, with or without an asset allowlist (M32)", async () => {
    const malformed: unknown[] = ["-1000000", "0x10", "1e5", "", "5.0", " 5", "0", "9".repeat(41), 100, null, undefined];
    for (const allowedAssets of [[LEGACY, WCSPR], undefined]) {
      const paying = await make({ allowedAssets });
      for (const amount of malformed) {
        gateway.accepts = [legacyOption({ amount })];
        await refused(paying, /malformed price/);
      }
      assert.equal(paying.spentRaw(), "0");
      // A malformed option next to a valid one: the valid one is paid.
      gateway.accepts = [legacyOption({ amount: "-5" }), wcsprOption()];
      const { signed } = await payOnce(paying);
      assert.equal(signed.accepted.asset, WCSPR);
      assert.equal(paying.spentRaw(), "400");
    }
  });

  it("pays the acceptable option of a 402 that also carries malformed entries, with or without an asset allowlist", async () => {
    // x402's own selection reads these fields before CasCet's policy runs: a null entry, or a
    // non-string asset next to an asset allowlist, used to fail the whole 402 with a TypeError.
    const malformed: unknown[] = [
      null,
      "exact",
      wcsprOption({ asset: 42 }),
      wcsprOption({ asset: { hash: WCSPR } }),
      legacyOption({ payTo: 7 }),
      wcsprOption({ network: ["casper:casper-test"] }),
      wcsprOption({ maxTimeoutSeconds: "300" }),
    ];
    for (const allowedAssets of [[LEGACY, WCSPR], undefined]) {
      gateway.accepts = [...malformed, wcsprOption()];
      const payments: PaymentInfo[] = [];
      const paying = await make({ allowedAssets, onPayment: info => payments.push(info) });
      const { signed } = await payOnce(paying, payments);
      assert.deepEqual(signed.accepted, wcsprOption(), "the gateway's own entry, unchanged");
      assert.equal(signedFor(signed, "Wrapped CSPR", WCSPR), true);
      assert.deepEqual(payments, [
        { amountRaw: "400", payTo: SELLER, network: "casper:casper-test", asset: WCSPR, authorizationStyle: "cep3009-value" },
      ]);

      gateway.accepts = malformed;
      await refused(paying, /^payment refused: none of the 7 payment options the gateway offers is acceptable: malformed payment requirements; /);
    }
  });

  it("refuses a 402 of another x402 version before x402 reads it, and quotes the version safely", async () => {
    gateway.accepts = [wcsprOption()];
    const paying = await make();
    try {
      for (const [version, shown] of [
        [1, "1"],
        ["2", '"2"'],
        [undefined, "(none)"],
        ["2\n[cascet] authorized 1 raw units", '"2\\n[cascet] authorized 1 raw units"'],
      ] as const) {
        gateway.x402Version = version;
        await refused(paying, /uses x402 version .*, but this client pays x402 version 2 only$/);
        await assert.rejects(paying.fetch(gateway.url(), { method: "POST", body: "{}" }), (err: Error) => {
          assert.ok(err.message.includes(`uses x402 version ${shown}, but`), err.message);
          assert.doesNotMatch(err.message, /\n/);
          return true;
        });
      }
    } finally {
      gateway.x402Version = 2;
    }
    assert.equal((await payOnce(paying)).signed.accepted.asset, WCSPR);
  });

  it("never lets concurrent payments overshoot the session budget together", async () => {
    gateway.accepts = [wcsprOption({ amount: "400" })];
    const paying = await make({ budget: { maxPerCallRaw: "400", maxSessionRaw: "700" } });
    // Whichever check refuses the later calls (the 402 check, or x402's selection through the
    // policy filter, see createPaymentClient), only one authorization may be signed, and the
    // refusal names the policy's reason.
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => paying.fetch(gateway.url(), { method: "POST", body: "{}" })),
    );
    const paid = results.filter(result => result.status === "fulfilled");
    const refusedCalls = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.equal(paid.length, 1);
    assert.equal(refusedCalls.length, 2);
    for (const { reason } of refusedCalls) {
      assert.ok(reason instanceof PaymentRefusedError, String(reason));
      assert.match(reason.message, /would exceed the session budget 700/);
    }
    assert.equal(paying.spentRaw(), "400");
  });

  it("pays an allowlisted token above x402's $1 default cap through the derived spend controls", async () => {
    gateway.accepts = [wcsprOption({ amount: "900000000000000" })];
    const paying = await make({ allowedAssets: [WCSPR], budget: { maxPerCallRaw: "900000000000000" } });
    const { signed } = await payOnce(paying);
    assert.equal(signed.payload.authorization.value, "900000000000000");
  });

  it("returns a 402 that answers the paid retry, and counts the signed authorization", async () => {
    gateway.accepts = [wcsprOption()];
    const paying = await make();
    const before = gateway.hits.length;
    const response = await paying.fetch(gateway.url("/reject-paid"), { method: "POST", body: "{}" });
    assert.equal(response.status, 402, "the gateway's answer to the paid retry");
    const hits = gateway.hits.slice(before);
    assert.equal(hits.length, 2);
    assert.equal(typeof hits[1]?.signature, "string", "the paid retry carried the payment");
    assert.equal(paying.spentRaw(), "400", "a signed authorization counts until it expires");
  });

  it("does not add a second payment to a request that already carries one", async () => {
    gateway.accepts = [wcsprOption()];
    const paying = await make();
    const before = gateway.hits.length;
    // /reject-paid answers 402 although the request carries a payment (the caller's own, rejected).
    await assert.rejects(
      paying.fetch(gateway.url("/reject-paid"), { method: "POST", body: "{}", headers: { "PAYMENT-SIGNATURE": "e30=" } }),
      (err: Error) => err instanceof PaymentRefusedError && /already carries an x402 payment header/.test(err.message),
    );
    assert.equal(gateway.hits.length - before, 1);
    assert.equal(paying.spentRaw(), "0");
  });

  it("validates preferStyles", async () => {
    await assert.rejects(make({ preferStyles: ["permit2" as never] }), /preferStyles: unknown authorization style "permit2"/);
    await assert.rejects(make({ preferStyles: [] }), /preferStyles must list at least one authorization style/);
    await assert.doesNotReject(make({ preferStyles: ["cep3009-value", "cep3009-value"] }));
  });
});

describe("buildSpendControls", () => {
  it("opens x402's controls when no asset is allowlisted", () => {
    assert.deepEqual(buildSpendControls(new SpendPolicy()), CASCET_SPEND_CONTROLS);
    assert.deepEqual(buildSpendControls(new SpendPolicy({ maxPerCallRaw: "400" })), CASCET_SPEND_CONTROLS);
  });

  it("lists every (network, asset) pair, capped at the per-call budget, without a USD cap", () => {
    const policy = new SpendPolicy({
      networks: ["casper:casper-test", "casper:casper"],
      allowedAssets: [`hash-${LEGACY}`, WCSPR.toUpperCase()],
      maxPerCallRaw: "400",
    });
    assert.deepEqual(buildSpendControls(policy), {
      maxAmountPerPayment: false,
      allowedAssets: [
        { network: "casper:casper-test", asset: LEGACY, maxAmountPerPayment: "400" },
        { network: "casper:casper-test", asset: WCSPR, maxAmountPerPayment: "400" },
        { network: "casper:casper", asset: LEGACY, maxAmountPerPayment: "400" },
        { network: "casper:casper", asset: WCSPR, maxAmountPerPayment: "400" },
      ],
    });
    assert.deepEqual(buildSpendControls(new SpendPolicy({ allowedAssets: [WCSPR] })), {
      maxAmountPerPayment: false,
      allowedAssets: [{ network: "casper:casper-test", asset: WCSPR }],
    });
  });

  it("is enforced by x402 itself, before CasCet's policy", async () => {
    const signer = clientSignerFromPem(PrivateKey.generate(KeyAlgorithm.ED25519).toPem());
    const clientFor = (policy: SpendPolicy) =>
      new x402Client()
        .register("casper:casper-test", createCasperClientScheme(signer, { network: "casper:casper-test" }))
        .setSpendControls(buildSpendControls(policy));

    const allowlisted = clientFor(new SpendPolicy({ allowedAssets: [WCSPR], maxPerCallRaw: "400" }));
    await assert.rejects(allowlisted.createPaymentPayload(challenge(legacyOption())), /rejected by spendControls/);
    await assert.rejects(allowlisted.createPaymentPayload(challenge(wcsprOption({ amount: "401" }))), /maxAmountPerPayment/);
    const paid = await allowlisted.createPaymentPayload(challenge(legacyOption(), wcsprOption()));
    assert.equal(paid.accepted.asset, WCSPR);

    // Without an allowlist x402 pays any token, above its $1 default too; CasCet's policy decides.
    const open = clientFor(new SpendPolicy());
    const any = await open.createPaymentPayload(challenge(legacyOption({ amount: "900000000000000" })));
    assert.equal(any.accepted.asset, LEGACY);
  });
});

describe("createPaymentClient", () => {
  const signer = clientSignerFromPem(PrivateKey.generate(KeyAlgorithm.ED25519).toPem());
  /** A signer that fails the test if it is ever asked to sign. */
  const neverSigns = {
    accountAddress: signer.accountAddress,
    publicKey: signer.publicKey,
    signEIP712: async (): Promise<Uint8Array> => assert.fail("nothing may be signed"),
  };
  /**
   * x402's own payment creation on `client`, without createPaymentClient's 402 check in front of it
   * (createPayingFetch's x402 client is configured the same way, without that check).
   */
  const x402Payload = (client: x402Client, paymentRequired: PaymentRequired) =>
    x402Client.prototype.createPaymentPayload.call(client, paymentRequired);

  it("registers one scheme per network the policy pays on, never a pattern", async () => {
    const policy = new SpendPolicy({ networks: ["casper:casper-test", "casper:casper"] });
    const client = createPaymentClient({ policy, signer, log: () => undefined });
    for (const network of ["casper:casper-test", "casper:casper"]) {
      const paid = await client.createPaymentPayload(challenge(wcsprOption({ network })));
      assert.equal(paid.accepted.network, network);
    }
    const elsewhere = challenge(wcsprOption({ network: "casper:other" }));
    await assert.rejects(x402Payload(client, elsewhere), /No network\/scheme registered/);
    // The client's 402 check refuses it first, naming the networks.
    await assert.rejects(
      client.createPaymentPayload(elsewhere),
      /^PaymentRefusedError: payment refused: the gateway asks for payment on casper:other, but this client only pays on casper:casper-test, casper:casper /,
    );
  });

  it("selects nothing when the policy accepts no option, e.g. when the budget ran out after the 402 was checked", async () => {
    const policy = new SpendPolicy({ allowedAssets: [LEGACY, WCSPR], maxPerCallRaw: "1000", maxSessionRaw: "700" });
    const payments: PaymentInfo[] = [];
    const client = createPaymentClient({ policy, signer: neverSigns, onPayment: info => payments.push(info), log: () => undefined });
    // A concurrent payment reserved 400 of the session budget after this 402 passed its check.
    assert.equal(policy.authorize(wcsprOption({ amount: "400" })).ok, true);
    const offer = challenge(wcsprOption({ amount: "400" }), legacyOption({ amount: "2000" }));
    // x402's own error, from the policy filter; createPayingFetch names the policy's reasons instead (see refusalReason).
    await assert.rejects(x402Payload(client, offer), /^Error: All payment requirements were filtered out by policies/);
    // The client's 402 check names them before x402 selects anything.
    await assert.rejects(
      client.createPaymentPayload(offer),
      (err: Error) =>
        err instanceof PaymentRefusedError &&
        err.message ===
          "payment refused: none of the 2 payment options the gateway offers is acceptable: " +
            `price 400 would exceed the session budget 700 for asset ${WCSPR} (already authorized 400); ` +
            "price 2000 exceeds the per-call budget 1000",
    );
    assert.deepEqual(policy.spentByAsset(), { [WCSPR]: "400" }, "the refusal reserved nothing");
    assert.deepEqual(payments, []);
  });

  it("hands x402 only the options the policy accepts, so malformed entries cannot fail a 402 that has a valid one", async () => {
    // x402's own selection reads these fields before the policy filter runs.
    const malformed: unknown[] = [
      null,
      "exact",
      wcsprOption({ asset: 42 }),
      wcsprOption({ asset: { hash: WCSPR } }),
      legacyOption({ payTo: 7 }),
      wcsprOption({ network: ["casper:casper-test"] }),
      wcsprOption({ maxTimeoutSeconds: "300" }),
    ];
    for (const allowedAssets of [[LEGACY, WCSPR], undefined]) {
      const policy = new SpendPolicy({ allowedAssets, maxSessionRaw: "1000" });
      const payments: PaymentInfo[] = [];
      const client = createPaymentClient({ policy, signer, onPayment: info => payments.push(info), log: () => undefined });
      // Handed to x402 as is, a null entry, or a non-string asset next to an asset allowlist, fails the whole 402.
      await assert.rejects(x402Payload(client, challenge(null, wcsprOption())), TypeError);
      if (allowedAssets) await assert.rejects(x402Payload(client, challenge(wcsprOption({ asset: 42 }), wcsprOption())), TypeError);

      const paid = await client.createPaymentPayload(challenge(...malformed, wcsprOption()));
      assert.deepEqual(paid.accepted, wcsprOption(), "the gateway's own entry, unchanged");
      assert.deepEqual(payments, [
        { amountRaw: "400", payTo: SELLER, network: "casper:casper-test", asset: WCSPR, authorizationStyle: "cep3009-value" },
      ]);
      assert.deepEqual(policy.spentByAsset(), { [WCSPR]: "400" });
    }
  });

  it("refuses a 402 of another x402 version, or whose options the policy all refuses, naming the reasons; nothing is reserved", async () => {
    const policy = new SpendPolicy({ allowedPayTo: [SELLER], allowedAssets: [LEGACY, WCSPR], maxSessionRaw: "1000" });
    const payments: PaymentInfo[] = [];
    const client = createPaymentClient({ policy, signer: neverSigns, onPayment: info => payments.push(info), log: () => undefined });
    const refused = async (paymentRequired: unknown, message: string) =>
      assert.rejects(client.createPaymentPayload(paymentRequired as PaymentRequired), (err: Error) => {
        assert.ok(err instanceof PaymentRefusedError, `expected PaymentRefusedError, got ${err.name}: ${err.message}`);
        assert.equal(err.message, `payment refused: ${message}`);
        return true;
      });

    await refused(
      challenge(null, "exact", wcsprOption({ asset: 42 }), wcsprOption({ payTo: OTHER_SELLER })),
      "none of the 4 payment options the gateway offers is acceptable: malformed payment requirements; " +
        `malformed asset 42; payTo ${OTHER_SELLER} is not allowlisted`,
    );
    await refused(challenge(wcsprOption({ extra: { version: "1" } })), "malformed EIP-712 domain: extra.name is missing");
    for (const accepts of [[], undefined, "exact", { 0: wcsprOption() }]) {
      await refused({ ...challenge(), accepts }, "the gateway's 402 offers no payment option");
    }
    // The x402 version first, as createPayingFetch checks it: the gateway's value is quoted as JSON.
    for (const [x402Version, shown] of [
      [1, "1"],
      ["2", '"2"'],
      [undefined, "(none)"],
    ] as const) {
      await refused(
        { ...challenge(wcsprOption()), x402Version },
        `the gateway's 402 uses x402 version ${shown}, but this client pays x402 version 2 only`,
      );
    }
    for (const notA402 of [null, "402", 2]) {
      await refused(notA402, "the gateway's 402 uses x402 version (none), but this client pays x402 version 2 only");
    }
    assert.deepEqual(policy.spentByAsset(), {}, "the refusals reserved nothing");
    assert.deepEqual(payments, []);
  });

  it("checks, selects and reserves in one step, so concurrent payments never overshoot the session budget", async () => {
    const policy = new SpendPolicy({ allowedAssets: [WCSPR], maxSessionRaw: "700" });
    const client = createPaymentClient({ policy, signer, log: () => undefined });
    const results = await Promise.allSettled([1, 2, 3].map(() => client.createPaymentPayload(challenge(wcsprOption({ amount: "400" })))));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const refusedPayments = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(refusedPayments.length, 2);
    for (const { reason } of refusedPayments) {
      // Refused by the client's own 402 check: x402's selection would refuse with a plain Error.
      assert.ok(reason instanceof PaymentRefusedError, String(reason));
      assert.match(reason.message, /would exceed the session budget 700/);
    }
    assert.deepEqual(policy.spentByAsset(), { [WCSPR]: "400" });
  });

  it("refuses in the before-payment hook when a policy registered later swaps in an option the spending policy refuses", async () => {
    const policy = new SpendPolicy({ allowedPayTo: [SELLER], allowedAssets: [LEGACY, WCSPR], maxSessionRaw: "1000" });
    const payments: PaymentInfo[] = [];
    const client = createPaymentClient({ policy, signer: neverSigns, onPayment: info => payments.push(info), log: () => undefined });
    client.registerPolicy(() => [wcsprOption({ payTo: OTHER_SELLER }) as unknown as PaymentRequirements]);
    await assert.rejects(
      client.createPaymentPayload(challenge(wcsprOption())),
      new RegExp(`^Error: Payment creation aborted: payTo ${OTHER_SELLER} is not allowlisted$`),
    );
    assert.deepEqual(policy.spentByAsset(), {}, "the refusal reserved nothing");
    assert.deepEqual(payments, []);
  });

  it("reserves before signing, reports after it, and gives the reservation back when signing fails", async () => {
    const policy = new SpendPolicy({ allowedAssets: [LEGACY, WCSPR], maxSessionRaw: "1000" });
    const payments: PaymentInfo[] = [];
    // The buyer's key, until it becomes unavailable: then signing throws, after the policy reserved the budget.
    let keyAvailable = true;
    const reservedWhenSigning: Array<string | undefined> = [];
    const flakySigner = {
      ...signer,
      signEIP712: async (digest: Uint8Array): Promise<Uint8Array> => {
        reservedWhenSigning.push(policy.spentByAsset()[WCSPR]);
        if (!keyAvailable) throw new Error("the signing key is unavailable");
        return signer.signEIP712(digest);
      },
    };
    const client = createPaymentClient({ policy, signer: flakySigner, preferStyles: ["cep3009-value"], onPayment: info => payments.push(info) });
    const paid = await client.createPaymentPayload(challenge(legacyOption(), wcsprOption()));
    assert.equal(paid.accepted.asset, WCSPR, "preferStyles applies");
    assert.deepEqual(paid.accepted, wcsprOption(), "the accepted entry is the gateway's, unchanged");
    assert.deepEqual(payments, [
      { amountRaw: "400", payTo: SELLER, network: "casper:casper-test", asset: WCSPR, authorizationStyle: "cep3009-value" },
    ]);
    assert.deepEqual(policy.spentByAsset(), { [WCSPR]: "400" });

    // The key becomes unavailable: @x402/casper throws after the reservation.
    keyAvailable = false;
    await assert.rejects(client.createPaymentPayload(challenge(wcsprOption())), /failed_to_sign: the signing key is unavailable/);
    assert.deepEqual(reservedWhenSigning, ["400", "800"], "each payment was reserved before it was signed");
    assert.deepEqual(policy.spentByAsset(), { [WCSPR]: "400" }, "the failed payment's reservation was given back");
    assert.equal(payments.length, 1);
  });

  it("pays the next option when the first names no usable EIP-712 domain, and reserves nothing for it", async () => {
    const policy = new SpendPolicy({ allowedAssets: [LEGACY, WCSPR], maxSessionRaw: "1000" });
    const payments: PaymentInfo[] = [];
    const client = createPaymentClient({ policy, signer, onPayment: info => payments.push(info), log: () => undefined });
    const noName = wcsprOption({ extra: { version: "1", authorizationStyle: "cep3009-value" } });
    const paid = await client.createPaymentPayload(challenge(noName, legacyOption()));
    assert.deepEqual(paid.accepted, legacyOption());
    assert.deepEqual(policy.spentByAsset(), { [LEGACY]: "500" });
    assert.deepEqual(payments, [
      { amountRaw: "500", payTo: SELLER, network: "casper:casper-test", asset: LEGACY, authorizationStyle: "legacy-amount" },
    ]);
  });

  it("binds each scheme to the policy's validity-window limit, which holds even if the selection changes after the policy check", async () => {
    const policy = new SpendPolicy({ maxAuthorizationSeconds: 600 });
    const client = createPaymentClient({ policy, signer: neverSigns, log: () => undefined });
    // A hook registered after CasCet's widens the window once the policy has accepted and reserved the option.
    client.onBeforePaymentCreation(async ctx => {
      (ctx.selectedRequirements as { maxTimeoutSeconds: unknown }).maxTimeoutSeconds = 601;
    });
    await assert.rejects(
      client.createPaymentPayload(challenge(wcsprOption({ maxTimeoutSeconds: 600 }))),
      /refusing to sign: validity window 601 s is longer than 600 s/,
    );
    assert.deepEqual(policy.spentByAsset(), {}, "the reservation was given back");
  });

  it("gives the reservation back when a before-payment hook registered later aborts or throws, which signs nothing", async () => {
    const policy = new SpendPolicy({ allowedAssets: [WCSPR], maxPerCallRaw: "400", maxSessionRaw: "800" });
    const payments: PaymentInfo[] = [];
    let signed = 0;
    const countingSigner = {
      ...signer,
      signEIP712: async (digest: Uint8Array): Promise<Uint8Array> => {
        signed++;
        return signer.signEIP712(digest);
      },
    };
    const client = createPaymentClient({ policy, signer: countingSigner, onPayment: info => payments.push(info), log: () => undefined });
    // A confirmation step, as @x402/core suggests for interactive approval. x402 runs it after CasCet's hook reserved
    // the budget, and an abort or throw there skips the failure hooks that give a reservation back.
    const declined = { ...challenge(wcsprOption()), resource: { url: "http://127.0.0.1/declined", description: "", mimeType: "" } };
    let crash = false;
    client.onBeforePaymentCreation(async ctx => {
      if (crash) throw new Error("the confirmation dialog crashed");
      return ctx.paymentRequired.resource?.url === declined.resource.url ? { abort: true as const, reason: "the user declined" } : undefined;
    });
    await assert.rejects(client.createPaymentPayload(declined), /^Error: Payment creation aborted: the user declined$/);
    assert.deepEqual(policy.spentByAsset(), {}, "the declined payment's reservation was given back");
    crash = true;
    await assert.rejects(client.createPaymentPayload(challenge(wcsprOption())), /^Error: the confirmation dialog crashed$/);
    assert.deepEqual(policy.spentByAsset(), {}, "so was the reservation of the payment whose confirmation threw");
    crash = false;

    // A declined payment next to an identical one that is paid: one reservation is given back, the other kept.
    const results = await Promise.allSettled([client.createPaymentPayload(declined), client.createPaymentPayload(challenge(wcsprOption()))]);
    assert.deepEqual(results.map(result => result.status), ["rejected", "fulfilled"]);
    assert.deepEqual(policy.spentByAsset(), { [WCSPR]: "400" });
    assert.deepEqual(payments, [
      { amountRaw: "400", payTo: SELLER, network: "casper:casper-test", asset: WCSPR, authorizationStyle: "cep3009-value" },
    ]);
    assert.equal(signed, 1);
  });

  it("logs, and does not fail the payment, when onPayment throws", async () => {
    const lines: string[] = [];
    const client = createPaymentClient({
      policy: new SpendPolicy(),
      signer,
      onPayment: () => {
        throw new Error("boom");
      },
      log: line => lines.push(line),
    });
    assert.equal((await client.createPaymentPayload(challenge(wcsprOption()))).accepted.asset, WCSPR);
    assert.deepEqual(lines, ["[cascet] onPayment callback threw: boom"]);
  });
});

describe("spendPolicyFilter", () => {
  const policy = new SpendPolicy({ allowedPayTo: [SELLER], allowedAssets: [LEGACY, WCSPR], maxPerCallRaw: "450" });
  const filter = spendPolicyFilter(policy);
  const asAccepts = (...options: Array<Record<string, unknown>>) => options as unknown as PaymentRequirements[];

  it("keeps only the options the policy accepts, in the gateway's order, and reserves nothing", () => {
    const offered = asAccepts(
      legacyOption({ amount: "500" }),
      wcsprOption(),
      legacyOption({ amount: "450" }),
      wcsprOption({ payTo: OTHER_SELLER }),
    );
    assert.deepEqual(filter(2, offered), [offered[1], offered[2]]);
    assert.deepEqual(policy.spentByAsset(), {});
  });

  it("returns no option at all when it refuses every one (it never falls back to the refused ones)", () => {
    const refusedOnly = asAccepts(
      legacyOption({ amount: "500" }),
      wcsprOption({ payTo: OTHER_SELLER }),
      wcsprOption({ asset: ASSET_A }),
      wcsprOption({ extra: { name: "Wrapped CSPR", version: "1", authorizationStyle: "permit2" } }),
    );
    assert.deepEqual(filter(2, refusedOnly), []);
    assert.deepEqual(filter(2, []), []);
  });
});

describe("preferStylesPolicy", () => {
  const options = [
    requirement({ asset: ASSET_A, extra: { name: "A", version: "1", authorizationStyle: "legacy-amount" } }),
    requirement({ asset: ASSET_B, extra: { name: "B", version: "1", authorizationStyle: "permit2" } }),
    requirement({ asset: WCSPR, extra: { name: "Wrapped CSPR", version: "1" } }),
    requirement({ asset: LEGACY, extra: { name: "CasCet X402 Token", version: "1", authorizationStyle: "cep3009-value" } }),
  ] as unknown as PaymentRequirements[];

  it("orders by preference, keeps the gateway's order within a rank and never drops an option", () => {
    const assets = (order: Parameters<typeof preferStylesPolicy>[0]) => preferStylesPolicy(order)(2, options).map(o => o.asset);
    // LEGACY advertises cep3009-value, but this client knows it as legacy-amount.
    assert.deepEqual(assets(["cep3009-value"]), [WCSPR, ASSET_A, ASSET_B, LEGACY]);
    assert.deepEqual(assets(["legacy-amount"]), [ASSET_A, LEGACY, ASSET_B, WCSPR]);
    assert.deepEqual(assets(["legacy-amount", "cep3009-value"]), [ASSET_A, LEGACY, WCSPR, ASSET_B]);
    assert.deepEqual(options.map(o => o.asset), [ASSET_A, ASSET_B, WCSPR, LEGACY], "the input is not reordered");
  });

  it("reads the style it knows for a token first, then the advertised one, then the default", () => {
    assert.deepEqual(options.map(optionAuthorizationStyle), ["legacy-amount", undefined, "cep3009-value", "legacy-amount"]);
    const style = (overrides: Record<string, unknown>) => optionAuthorizationStyle(requirement(overrides) as unknown as PaymentRequirements);
    const extra = (authorizationStyle?: unknown) => ({ extra: { name: "Token", version: "1", authorizationStyle } });
    const LEGACY_MAINNET = "8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41";
    // Known tokens, on their own network, whatever they advertise (any prefix or case).
    assert.equal(style({ asset: `hash-${LEGACY.toUpperCase()}`, ...extra() }), "legacy-amount");
    assert.equal(style({ asset: LEGACY_MAINNET, network: "casper:casper", ...extra("cep3009-value") }), "legacy-amount");
    assert.equal(style({ asset: WCSPR, ...extra("legacy-amount") }), "cep3009-value");
    // A known hash on another network is not that token: its label, else the default, decides.
    assert.equal(style({ asset: LEGACY, network: "casper:casper", ...extra("cep3009-value") }), "cep3009-value");
    assert.equal(style({ asset: WCSPR, network: "casper:casper", ...extra("legacy-amount") }), "legacy-amount");
    // Unknown tokens: the advertised style, else cep3009-value (the standard).
    assert.equal(style({ asset: ASSET_B, ...extra("legacy-amount") }), "legacy-amount");
    assert.equal(style({ asset: ASSET_B, ...extra() }), "cep3009-value");
    // An advertised style this client does not know: no rank, whatever the token.
    assert.equal(style({ asset: LEGACY, ...extra("permit2") }), undefined);
    assert.equal(style({ asset: ASSET_B, network: "constructor", ...extra("permit2") }), undefined);
    assert.equal(style({ asset: "__proto__", network: "constructor", ...extra() }), "cep3009-value");
  });
});

describe("explainPaymentError", () => {
  const policy = new SpendPolicy({ allowedAssets: [ASSET_A] });
  /** The escape sequence the client prints for a control character. */
  const esc = (code: number): string => "\\" + "u" + code.toString(16).padStart(4, "0");

  it("quotes x402's own text with control, separator and bidi characters escaped", () => {
    const raw =
      "Failed to create payment payload: No client registered for x402 version: 2" +
      `${String.fromCharCode(0x0a)}[cascet] fake${String.fromCharCode(0x202e)}txt${String.fromCharCode(0x1b)}[31m` +
      `${String.fromCharCode(0x2028)}end`;
    const err = new Error(raw);
    const explained = explainPaymentError(err, undefined, policy);
    assert.ok(explained instanceof PaymentRefusedError);
    assert.equal(
      explained.message,
      `payment refused: No client registered for x402 version: 2${esc(0x0a)}[cascet] fake${esc(0x202e)}txt${esc(0x1b)}[31m${esc(0x2028)}end`,
    );
    assert.equal(explained.cause, err);
  });

  it("names the policy's own reasons when x402 refused every option, and keeps errors it does not know", () => {
    const filtered = new Error("Failed to create payment payload: All payment requirements were filtered out by policies for x402 version: 2");
    const explained = explainPaymentError(filtered, [requirement({ asset: ASSET_B })], policy);
    assert.ok(explained instanceof PaymentRefusedError);
    assert.equal(explained.message, `payment refused: asset ${ASSET_B} is not allowlisted`);
    const unknown = new Error("socket hang up");
    assert.equal(explainPaymentError(unknown, undefined, policy), unknown);
  });
});

describe("refusalReason", () => {
  const policy = new SpendPolicy({ allowedPayTo: [SELLER], allowedAssets: [ASSET_A] });

  it("is undefined when at least one option is acceptable, and reserves nothing", () => {
    assert.equal(refusalReason(policy, [requirement({ asset: ASSET_B }), requirement()]), undefined);
    assert.deepEqual(policy.spentByAsset(), {});
  });

  it("names the one reason, or every distinct reason", () => {
    assert.equal(refusalReason(policy, [requirement({ asset: ASSET_B })]), `asset ${ASSET_B} is not allowlisted`);
    assert.equal(
      refusalReason(policy, [requirement({ asset: ASSET_B }), requirement({ asset: ASSET_B }), requirement({ payTo: OTHER_SELLER })]),
      `none of the 3 payment options the gateway offers is acceptable: asset ${ASSET_B} is not allowlisted; ` +
        `payTo ${OTHER_SELLER} is not allowlisted`,
    );
    assert.equal(refusalReason(policy, []), "the gateway's 402 offers no payment option");
  });

  it("names the networks when the 402 only asks for networks the client does not pay on", () => {
    assert.match(
      refusalReason(policy, [requirement({ network: "casper:casper" }), requirement({ network: "casper:casper\nfake" })]) ?? "",
      /^the gateway asks for payment on casper:casper, casper:casper\\nfake, but this client only pays on casper:casper-test/,
    );
  });
});

describe("PendingReservations", () => {
  const req = (overrides: Record<string, unknown> = {}) => requirement(overrides);

  it("finds a reservation by the same requirements object, even if it was mutated", () => {
    const book = new PendingReservations<string>();
    const selected = req();
    book.add(selected, "r1");
    selected.payTo = OTHER_SELLER;
    assert.equal(book.take(selected), "r1");
    assert.equal(book.size, 0);
  });

  it("finds a reservation by an identical copy (a later x402 may copy between hooks)", () => {
    const book = new PendingReservations<string>();
    const selected = req({ payTo: SELLER.toUpperCase() });
    book.add(selected, "r1");
    assert.equal(book.take({ ...selected, payTo: SELLER, extra: { name: "other" } }), "r1");
    assert.equal(book.take(selected), undefined, "taken once only");
  });

  it("keeps identical concurrent payments apart by count", () => {
    const book = new PendingReservations<string>();
    const [a, b, c] = [req(), req(), req({ amount: "200" })];
    book.add(a, "a");
    book.add(b, "b");
    book.add(c, "c");
    assert.equal(book.size, 3);
    assert.equal(book.take({ ...b }), "a", "identical payments are interchangeable");
    assert.equal(book.take(a), "b");
    assert.equal(book.take({ ...c }), "c");
    assert.equal(book.size, 0);
    assert.equal(book.take(req({ asset: ASSET_B })), undefined);
  });
});

