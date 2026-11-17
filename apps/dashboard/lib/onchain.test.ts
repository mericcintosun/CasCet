import { test } from "node:test";
import assert from "node:assert/strict";
import type { PaymentReceipt } from "@cascet/core";
import { INITIAL_ONCHAIN_STATE, parseOnchainPayload, reduceOnchain } from "./onchain";
import { OnchainReadError, readRegistryReceipts, type RegistryReadOptions } from "./casper/registry-reader";

const receipt = (id: string): PaymentReceipt => ({
  id,
  createdAt: "2026-10-01T00:00:00Z",
  network: "casper:casper-test",
  server: "s",
  tool: "t",
  payer: `00${"aa".repeat(32)}`,
  payTo: `00${"bb".repeat(32)}`,
  amountRaw: "100",
  asset: "cc".repeat(32),
  assetSymbol: "WCSPR",
  status: "settled",
});

// ── client state machine ────────────────────────────────────────────────────

test("a failed first read is an error state, not an empty live economy", () => {
  const r = parseOnchainPayload(false, 503, { ok: false, error: "CSPR_CLOUD_TOKEN is not configured" });
  assert.deepEqual(r, { ok: false, error: "CSPR_CLOUD_TOKEN is not configured" });
  const s = reduceOnchain(INITIAL_ONCHAIN_STATE, r, 1);
  assert.equal(s.status, "error");
  assert.equal(s.receipts.length, 0);
  assert.equal(s.updatedAt, null);
});

test("a failure after a good read keeps the data and reports degraded", () => {
  const good = reduceOnchain(
    INITIAL_ONCHAIN_STATE,
    parseOnchainPayload(true, 200, { ok: true, network: "casper:casper-test", receipts: [receipt("a")] }),
    10,
  );
  assert.equal(good.status, "live");
  const bad = reduceOnchain(good, parseOnchainPayload(false, 502, { ok: false, error: "HTTP 429" }), 20);
  assert.equal(bad.status, "degraded");
  assert.equal(bad.receipts.length, 1, "previous receipts are kept");
  assert.equal(bad.updatedAt, 10);
  assert.equal(bad.error, "HTTP 429");
  const again = reduceOnchain(bad, parseOnchainPayload(true, 200, { ok: true, receipts: [] }), 30);
  assert.equal(again.status, "live");
  assert.equal(again.error, null);
});

test("a legitimately empty registry is live with zero receipts", () => {
  const s = reduceOnchain(INITIAL_ONCHAIN_STATE, parseOnchainPayload(true, 200, { ok: true, receipts: [] }), 5);
  assert.equal(s.status, "live");
  assert.equal(s.receipts.length, 0);
});

test("legacy 200 + error bodies, non-JSON bodies and malformed payloads are failures", () => {
  assert.equal(parseOnchainPayload(true, 200, { ok: false, receipts: [], error: "boom" }).ok, false);
  assert.equal(parseOnchainPayload(true, 200, null).ok, false);
  assert.equal(parseOnchainPayload(true, 200, { receipts: "nope" }).ok, false);
  const r = parseOnchainPayload(false, 500, null);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /HTTP 500/);
});

test("non-receipt rows are dropped and the truncated flag passes through", () => {
  const r = parseOnchainPayload(true, 200, { ok: true, receipts: [receipt("a"), { junk: 1 }, null], truncated: true });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.receipts.length, 1);
    assert.equal(r.truncated, true);
  }
});

// ── server reader ───────────────────────────────────────────────────────────

const deploy = (id: string, ts: string, extra: Record<string, unknown> = {}) => ({
  deploy_hash: `anchor-${id}`,
  timestamp: ts,
  status: "processed",
  args: {
    payment_id: { parsed: id },
    parent_id: { parsed: "" },
    payer: { parsed: `00${"aa".repeat(32)}` },
    payee: { parsed: `00${"bb".repeat(32)}` },
    amount: { parsed: "500000000" },
    server: { parsed: "casper-defi-data" },
    tool: { parsed: "get_rwa_price" },
    tx_hash: { parsed: "ab".repeat(32) },
  },
  ...extra,
});

function options(fetchImpl: typeof fetch, over: Partial<RegistryReadOptions> = {}): RegistryReadOptions {
  return {
    token: "token",
    apiBase: "https://api.example",
    registryPackageHash: "dd".repeat(32),
    network: "casper:casper-test",
    assetPackageHash: "cc".repeat(32),
    assetSymbol: "WCSPR",
    fetchImpl,
    ...over,
  };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("no CSPR_CLOUD_TOKEN is a 503 not_configured error, not an empty list", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return jsonResponse({ data: [] });
  }) as typeof fetch;
  await assert.rejects(readRegistryReceipts(options(fetchImpl, { token: undefined })), (e: unknown) => {
    return e instanceof OnchainReadError && e.status === 503 && e.code === "not_configured";
  });
  assert.equal(called, false);
});

test("an upstream non-2xx on any page is an error, even after a good first page", async () => {
  let page = 0;
  const fetchImpl = (async () => {
    page += 1;
    return page === 1 ? jsonResponse({ data: [deploy("a", "2026-10-01T00:00:00Z")], page_count: 2 }) : jsonResponse({}, 429);
  }) as typeof fetch;
  await assert.rejects(readRegistryReceipts(options(fetchImpl)), (e: unknown) => {
    return e instanceof OnchainReadError && e.status === 502 && /429/.test(e.message);
  });
});

test("network failures and unexpected bodies are errors", async () => {
  const boom = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(readRegistryReceipts(options(boom)), (e: unknown) => e instanceof OnchainReadError && e.status === 502);
  const timeout = (async () => {
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  }) as typeof fetch;
  await assert.rejects(readRegistryReceipts(options(timeout)), (e: unknown) => e instanceof OnchainReadError && e.status === 504);
  const weird = (async () => jsonResponse({ items: [] })) as typeof fetch;
  await assert.rejects(readRegistryReceipts(options(weird)), (e: unknown) => e instanceof OnchainReadError && e.code === "bad_upstream_payload");
});

test("records become receipts: fixtures and failed deploys are skipped, newest first, asset supplied", async () => {
  const fetchImpl = (async () =>
    jsonResponse({
      page_count: 1,
      data: [
        deploy("old", "2026-09-01T00:00:00Z"),
        deploy("new", "2026-10-01T00:00:00Z"),
        deploy("fixture", "2026-10-02T00:00:00Z"),
        deploy("reverted", "2026-10-03T00:00:00Z", { error_message: "User error: 1" }),
        { ...deploy("demo", "2026-10-04T00:00:00Z"), args: { ...deploy("demo", "x").args, tx_hash: { parsed: "demo-tx" } } },
        { deploy_hash: "init", timestamp: "2026-08-01T00:00:00Z", args: {} },
      ],
    })) as typeof fetch;
  const { receipts, truncated } = await readRegistryReceipts(options(fetchImpl, { excludedIds: new Set(["fixture"]) }));
  assert.deepEqual(receipts.map(r => r.id), ["new", "old"]);
  assert.equal(truncated, false);
  assert.equal(receipts[0]!.asset, "cc".repeat(32));
  assert.equal(receipts[0]!.network, "casper:casper-test");
  assert.equal(receipts[0]!.anchoredTxHash, "anchor-new");
});

test("more pages than the read limit are reported as truncated", async () => {
  const fetchImpl = (async () => jsonResponse({ data: [], page_count: 12 })) as typeof fetch;
  const { truncated } = await readRegistryReceipts(options(fetchImpl, { maxPages: 2 }));
  assert.equal(truncated, true);
});
