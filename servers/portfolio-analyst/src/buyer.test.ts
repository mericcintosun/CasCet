import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDataBuyer, paymentGuard, withAbortSignal, type FetchLike } from "./buyer.js";
import { loadAnalystConfig, type AnalystConfig } from "./config.js";
import { REASONS, classifyPurchaseError } from "./sanitize.js";
import { within } from "./test-fakes.js";

describe("withAbortSignal", () => {
  it("passes the signal and keeps the rest of the request init", async () => {
    const seen: RequestInit[] = [];
    const inner: FetchLike = async (_input, init) => {
      seen.push(init ?? {});
      return new Response("ok");
    };
    const ac = new AbortController();
    await withAbortSignal(inner, ac.signal)("http://x.test/mcp", { method: "POST", body: "{}", headers: { a: "b" } });
    assert.equal(seen[0]?.method, "POST");
    assert.equal(seen[0]?.body, "{}");
    assert.deepEqual(seen[0]?.headers, { a: "b" });
    assert.equal(seen[0]?.signal, ac.signal);
  });

  it("never calls the inner fetch once aborted", async () => {
    let calls = 0;
    const inner: FetchLike = async () => {
      calls++;
      return new Response("ok");
    };
    const ac = new AbortController();
    ac.abort(new Error("stop"));
    await assert.rejects(withAbortSignal(inner, ac.signal)("http://x.test/mcp"), /stop/);
    assert.equal(calls, 0);
  });

  it("combines with a signal the caller already set: either one aborts the request", async () => {
    const signals: AbortSignal[] = [];
    const inner: FetchLike = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Response("ok");
    };
    const mine = new AbortController();
    const theirs = new AbortController();
    await withAbortSignal(inner, mine.signal)("http://x.test", { signal: theirs.signal });
    const combined = signals[0];
    assert.ok(combined && combined !== mine.signal && combined !== theirs.signal);
    theirs.abort();
    assert.equal(combined.aborted, true);

    const mine2 = new AbortController();
    await withAbortSignal(inner, mine2.signal)("http://x.test", { signal: new AbortController().signal });
    mine2.abort();
    assert.equal(signals[1]?.aborted, true);
  });
});

describe("paymentGuard", () => {
  const info = { amountRaw: "500000000", payTo: `00${"a".repeat(64)}`, network: "casper:casper-test" };

  it("lets an allowed payment through and logs it", () => {
    const lines: string[] = [];
    paymentGuard({ networks: ["casper:casper-test"], signal: new AbortController().signal, log: l => lines.push(l) })(info);
    assert.equal(lines.length, 1);
  });

  it("vetoes a network that is not in CASCET_NETWORK", () => {
    const guard = paymentGuard({ networks: ["casper:casper-test"], signal: new AbortController().signal, log: () => {} });
    assert.throws(() => guard({ ...info, network: "casper:casper" }), /network casper:casper is not in CASCET_NETWORK/);
  });

  it("refuses to sign once the analysis is aborted", () => {
    const ac = new AbortController();
    const guard = paymentGuard({ networks: ["casper:casper-test"], signal: ac.signal, log: () => {} });
    ac.abort();
    assert.throws(() => guard(info), /aborted, not paying/);
  });
});

// ---------------------------------------------------------------------------
// The real @cascet/client paying fetch against a local fake gateway that only
// ever answers with a 402 challenge (or never answers). A throwaway key is
// generated per run; no test reaches the signing step, nothing touches a chain.
// ---------------------------------------------------------------------------

const ACCOUNT = "881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36";
const TOKEN = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";

interface FakeGateway {
  url: string;
  requests: Array<{ paid: boolean }>;
  /** Resolves when the gateway received its first request. */
  firstRequest: Promise<void>;
  close: () => Promise<void>;
}

async function startFakeGateway(mode: { challenge: Record<string, unknown> } | { hang: true }): Promise<FakeGateway> {
  const requests: Array<{ paid: boolean }> = [];
  let notify: () => void = () => {};
  const firstRequest = new Promise<void>(resolve => (notify = resolve));
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push({ paid: req.headers["payment-signature"] !== undefined || req.headers["x-payment"] !== undefined });
      notify();
      if ("hang" in mode) return; // never answer: the client has to abort
      const paymentRequired = {
        x402Version: 2,
        error: "Payment required",
        resource: { url: "http://127.0.0.1/tools/get_cspr_market_data", description: "test", mimeType: "application/json" },
        accepts: [mode.challenge],
      };
      res.writeHead(402, {
        "content-type": "application/json",
        "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(paymentRequired)).toString("base64"),
      });
      res.end("{}");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    firstRequest,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function challenge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "exact",
    network: "casper:casper-test",
    amount: "500000000",
    asset: TOKEN,
    payTo: `00${ACCOUNT}`,
    maxTimeoutSeconds: 60,
    extra: { name: "Test Token", symbol: "TST", version: "1", decimals: "9" },
    ...overrides,
  };
}

describe("createDataBuyer with the real paying fetch", { timeout: 15_000 }, () => {
  let dir: string;
  let keyPath: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cascet-analyst-test-"));
    keyPath = join(dir, "throwaway.pem");
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  function configFor(url: string, extra: Record<string, string> = {}): AnalystConfig {
    const r = loadAnalystConfig({
      DATA_GATEWAY_URL: url,
      CASCET_KEY_PATH: keyPath,
      // Written the way an operator might: account-hash- and hash- forms are normalized.
      CASCET_ALLOWED_PAYTO: `account-hash-${ACCOUNT}`,
      CASCET_ALLOWED_ASSETS: `hash-${TOKEN}`,
      CASCET_MAX_PER_CALL: "1000000000",
      CASCET_MAX_SESSION: "5000000000",
      ...extra,
    });
    assert.ok(r.ok, JSON.stringify(r));
    return r.config;
  }

  async function buyOnce(gateway: FakeGateway, cfg: AnalystConfig, signal = new AbortController().signal): Promise<unknown> {
    const buyer = await createDataBuyer(cfg, { signal, log: () => {} });
    try {
      await buyer.callTool("get_cspr_market_data", {});
    } catch (err) {
      return err;
    }
    assert.fail("the purchase must not succeed");
  }

  it("vetoes a 402 for a network outside CASCET_NETWORK before signing", async () => {
    const gateway = await startFakeGateway({ challenge: challenge({ network: "casper:casper" }) });
    try {
      const err = await buyOnce(gateway, configFor(gateway.url));
      // Reaching the network veto proves the normalized payTo/asset allowlists
      // and the budget all matched inside the real client first.
      assert.match(String(err), /network casper:casper is not in CASCET_NETWORK/);
      const idle = new AbortController().signal;
      assert.equal(classifyPurchaseError(err, { signal: idle, cancelled: idle }), REASONS.policy);
      assert.deepEqual(gateway.requests, [{ paid: false }], "no paid request was sent");
    } finally {
      await gateway.close();
    }
  });

  it("refuses a payee that is not allowlisted", async () => {
    const gateway = await startFakeGateway({ challenge: challenge({ payTo: `00${"e".repeat(64)}` }) });
    try {
      const err = await buyOnce(gateway, configFor(gateway.url));
      assert.match(String(err), /not allowlisted/);
      assert.deepEqual(gateway.requests, [{ paid: false }]);
    } finally {
      await gateway.close();
    }
  });

  it("refuses a price above CASCET_MAX_PER_CALL", async () => {
    const gateway = await startFakeGateway({ challenge: challenge({ amount: "1000000001" }) });
    try {
      const err = await buyOnce(gateway, configFor(gateway.url));
      assert.match(String(err), /exceeds per-call budget/);
      assert.deepEqual(gateway.requests, [{ paid: false }]);
    } finally {
      await gateway.close();
    }
  });

  it("aborts an in-flight purchase when the analysis is aborted, and pays nothing", async () => {
    const gateway = await startFakeGateway({ hang: true });
    try {
      const inbound = new AbortController();
      const pending = buyOnce(gateway, configFor(gateway.url), inbound.signal);
      await within(gateway.firstRequest, 5_000, "the probe to reach the gateway");
      inbound.abort();
      const err = await within(pending, 5_000, "the aborted purchase to settle");
      assert.equal(classifyPurchaseError(err, { signal: inbound.signal, cancelled: inbound.signal }), REASONS.cancelled);
      assert.deepEqual(gateway.requests, [{ paid: false }]);
    } finally {
      await gateway.close();
    }
  });
});
