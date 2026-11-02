import { test } from "node:test";
import assert from "node:assert/strict";
import { isKnownCep3009Asset, isLegacyAmountToken, type PaymentReceipt } from "@cascet/core";
import { INITIAL_ONCHAIN_STATE, parseOnchainPayload, reduceOnchain } from "./onchain";
import { WCSPR_TOKEN_PACKAGE, X402_TOKEN_PACKAGE } from "./casper/constants";
import { CEP18X402_ONLY_BEFORE, testnetReceiptToken } from "./casper/receipt-token";
import { OnchainReadError, readRegistryReceipts, type RegistryReadOptions } from "./casper/registry-reader";
import { computeEconomy } from "./economy";
import { spendByAsset } from "./spend";

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
    tokenOf: async () => ({ packageHash: "cc".repeat(32), symbol: "WCSPR" }),
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

// ── which token each anchored receipt was paid in ───────────────────────────

const settledIn = (id: string, ts: string, txHash: string) => ({
  ...deploy(id, ts),
  args: { ...deploy(id, ts).args, tx_hash: { parsed: txHash } },
});

test("each receipt names the token its own settlement paid in, never one assumed for the whole registry", async () => {
  // Two otherwise identical records (same payer, server, tool and amount): one paid in Cep18X402, one in Wrapped CSPR.
  const LEGACY_TX = "11".repeat(32);
  const WCSPR_TX = "22".repeat(32);
  const LOST_TX = "33".repeat(32);
  const fetchImpl = (async () =>
    jsonResponse({
      page_count: 1,
      data: [
        settledIn("legacy", "2026-11-02T10:00:00Z", LEGACY_TX),
        settledIn("wcspr", "2026-11-02T11:00:00Z", WCSPR_TX),
        settledIn("lost", "2026-11-02T12:00:00Z", LOST_TX),
      ],
    })) as typeof fetch;
  const tokens: Record<string, string> = { [LEGACY_TX]: X402_TOKEN_PACKAGE, [WCSPR_TX]: WCSPR_TOKEN_PACKAGE };
  const asked: string[] = [];
  const tokenOf = testnetReceiptToken(async (txHash) => {
    asked.push(txHash);
    return tokens[txHash];
  });
  const { receipts } = await readRegistryReceipts(options(fetchImpl, { tokenOf }));
  assert.deepEqual(
    receipts.map((r) => [r.id, r.asset, r.assetSymbol]),
    [
      ["lost", "", ""],
      ["wcspr", WCSPR_TOKEN_PACKAGE, "WCSPR"],
      ["legacy", X402_TOKEN_PACKAGE, "WCSPR"],
    ],
  );
  assert.deepEqual(asked.sort(), [LEGACY_TX, WCSPR_TX, LOST_TX].sort());

  // /connect's Session spend keeps the tokens apart, so a Wrapped CSPR allowlist sees its own spend.
  const rows = spendByAsset(receipts, () => true);
  assert.deepEqual(
    rows.map((r) => [r.asset, r.symbol, r.raw, r.calls]),
    [
      ["", "?", 500_000_000n, 1],
      [WCSPR_TOKEN_PACKAGE, "WCSPR", 500_000_000n, 1],
      [X402_TOKEN_PACKAGE, "WCSPR", 500_000_000n, 1],
    ],
  );
  // The totals keep the known symbol even when the newest receipt names no token.
  assert.equal(computeEconomy(receipts).assetSymbol, "WCSPR");
});

test("records anchored before Wrapped CSPR was ever settled are Cep18X402 without asking the node", async () => {
  const asked: string[] = [];
  const tokenOf = testnetReceiptToken(async (txHash) => {
    asked.push(txHash);
    return WCSPR_TOKEN_PACKAGE;
  });
  const cutoff = Date.parse(CEP18X402_ONLY_BEFORE);
  assert.equal(cutoff, Date.parse("2026-11-01T00:00:00Z"));
  assert.ok(isLegacyAmountToken(X402_TOKEN_PACKAGE), "Cep18X402 is CasCet's legacy-amount token");
  assert.ok(isKnownCep3009Asset("casper:casper-test", WCSPR_TOKEN_PACKAGE), "the official testnet Wrapped CSPR");
  const legacy = { packageHash: X402_TOKEN_PACKAGE, symbol: "WCSPR" };
  assert.deepEqual(await tokenOf({ txHash: "aa".repeat(32), anchoredAt: "2026-07-22T21:08:15Z" }), legacy);
  assert.deepEqual(await tokenOf({ txHash: "aa".repeat(32), anchoredAt: new Date(cutoff - 1).toISOString() }), legacy);
  assert.deepEqual(asked, []);
  // From then on, and when the time is unreadable, the settlement tells.
  assert.deepEqual(await tokenOf({ txHash: "bb".repeat(32), anchoredAt: CEP18X402_ONLY_BEFORE }), { packageHash: WCSPR_TOKEN_PACKAGE, symbol: "WCSPR" });
  assert.deepEqual(await tokenOf({ txHash: "cc".repeat(32), anchoredAt: "" }), { packageHash: WCSPR_TOKEN_PACKAGE, symbol: "WCSPR" });
  assert.deepEqual(asked, ["bb".repeat(32), "cc".repeat(32)]);
  // A token neither of the two keeps its hash and has no symbol; an unreadable settlement names no token.
  const other = testnetReceiptToken(async (txHash) => (txHash === "dd".repeat(32) ? "ee".repeat(32) : undefined));
  assert.deepEqual(await other({ txHash: "dd".repeat(32), anchoredAt: "2026-11-02T00:00:00Z" }), { packageHash: "ee".repeat(32), symbol: "" });
  assert.equal(await other({ txHash: "ff".repeat(32), anchoredAt: "2026-11-02T00:00:00Z" }), undefined);
});

test("telling the tokens is bounded: a few lookups at once, none reaches the node after the budget, a failure names no token", async () => {
  const data = Array.from({ length: 10 }, (_, i) => settledIn(`r${i}`, `2026-11-02T10:00:0${i}Z`, String(i).repeat(64)));
  const fetchImpl = (async () => jsonResponse({ page_count: 1, data })) as typeof fetch;
  let clock = 0;
  let inFlight = 0;
  let peak = 0;
  const started: string[] = [];
  const tokenOf = async ({ txHash }: { txHash: string }, { offline }: { offline: boolean }) => {
    if (offline) return undefined;
    started.push(txHash);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    clock += 100; // each lookup takes 100 ms of the budget
    if (txHash === "9".repeat(64)) throw new Error("node down");
    return { packageHash: "cc".repeat(32), symbol: "WCSPR" };
  };
  const { receipts } = await readRegistryReceipts(options(fetchImpl, { tokenOf, tokenConcurrency: 3, tokenBudgetMs: 450, now: () => clock }));
  assert.equal(peak, 3);
  // Newest first: r9 (whose lookup throws) and the next ones are asked; none starts once 450 ms have passed.
  assert.ok(started.length < 10 && started.length >= 3, `started ${started.length}`);
  assert.equal(started[0], "9".repeat(64));
  const named = receipts.filter((r) => r.asset !== "");
  assert.equal(named.length, started.length - 1);
  assert.equal(receipts[0]!.id, "r9");
  assert.equal(receipts[0]!.asset, "");
  for (const r of receipts.slice(started.length)) assert.equal(r.asset, "", `${r.id} was never looked up`);
});

test("a slow node costs only the receipts that need it: older and already-known ones keep their token", async () => {
  // Three records from before the cutoff (known without the node) and a known hash, behind new ones that are slow.
  const data = [
    settledIn("old0", "2026-07-01T10:00:00Z", "a".repeat(64)),
    settledIn("old1", "2026-07-01T10:00:01Z", "b".repeat(64)),
    settledIn("known", "2026-11-02T09:00:00Z", "c".repeat(64)),
    ...Array.from({ length: 6 }, (_, i) => settledIn(`new${i}`, `2026-11-02T10:00:0${i}Z`, String(i).repeat(64))),
  ];
  const fetchImpl = (async () => jsonResponse({ page_count: 1, data })) as typeof fetch;
  let clock = 0;
  const asked: string[] = [];
  const tokenOf = testnetReceiptToken(async (txHash, opts) => {
    if (txHash === "c".repeat(64)) return WCSPR_TOKEN_PACKAGE;
    if (opts?.offline) return undefined;
    asked.push(txHash);
    await new Promise((resolve) => setImmediate(resolve));
    clock += 100; // past the budget after the first lookup
    return WCSPR_TOKEN_PACKAGE;
  });
  const { receipts } = await readRegistryReceipts(options(fetchImpl, { tokenOf, tokenConcurrency: 1, tokenBudgetMs: 50, now: () => clock }));
  assert.equal(asked.length, 1, "the budget stops the node lookups");
  const byId = new Map(receipts.map((r) => [r.id, r]));
  assert.equal(byId.get("new5")!.asset, WCSPR_TOKEN_PACKAGE);
  assert.equal(byId.get("new0")!.asset, "", "needs the node, so it names no token this time");
  assert.equal(byId.get("known")!.asset, WCSPR_TOKEN_PACKAGE, "already known");
  assert.equal(byId.get("old0")!.asset, X402_TOKEN_PACKAGE, "from before the cutoff");
  assert.equal(byId.get("old1")!.asset, X402_TOKEN_PACKAGE);
});
