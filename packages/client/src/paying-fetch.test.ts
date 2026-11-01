import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import casperSdk from "casper-js-sdk";
import { createPayingFetch, PaymentRefusedError, type PayingFetchOptions } from "./paying-fetch.js";
import { RequestTimeoutError } from "./http.js";

const { KeyAlgorithm, PrivateKey } = casperSdk;

const SELLER = "00" + "a1".repeat(32);
const OTHER_SELLER = "00" + "b2".repeat(32);
const ASSET_A = "d4".repeat(32);
const ASSET_B = "e5".repeat(32);

interface Hit {
  path: string;
  signature?: string;
  parentId?: string;
}

interface FakeGateway {
  url: (path?: string) => string;
  hits: Hit[];
  /** Requirements served in the next 402s. */
  accepts: Array<Record<string, unknown>>;
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

/** A tiny x402 resource: 402 without PAYMENT-SIGNATURE, 200 with it. /hang never answers; /redirect redirects. */
async function startFakeGateway(): Promise<FakeGateway> {
  const hits: Hit[] = [];
  const state = { accepts: [requirement()] };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = req.url ?? "/";
      hits.push({
        path,
        signature: req.headers["payment-signature"] as string | undefined,
        parentId: req.headers["x-cascet-parent-id"] as string | undefined,
      });
      if (path === "/hang") return; // never answer
      if (path === "/redirect") {
        res.writeHead(307, { location: "/elsewhere" }).end();
        return;
      }
      const signature = req.headers["payment-signature"];
      if (typeof signature !== "string") {
        const paymentRequired = {
          x402Version: 2,
          resource: { url: `http://127.0.0.1${path}`, description: "paid tool", mimeType: "application/json" },
          accepts: state.accepts,
        };
        res
          .writeHead(402, {
            "content-type": "application/json",
            "payment-required": Buffer.from(JSON.stringify(paymentRequired)).toString("base64"),
          })
          .end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    });
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
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function decodeSignature(header: string): { accepted: Record<string, unknown>; payload: { authorization: Record<string, string> } } {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

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
