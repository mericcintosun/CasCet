import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { PaymentReceipt } from "@cascet/core";
import { ReceiptStore, ingestHeaders, isLoopbackHostname, makeEventPusher } from "./store.js";

function receipt(id: string, extra: Partial<PaymentReceipt> = {}): PaymentReceipt {
  return {
    id,
    createdAt: "2026-11-01T00:00:00.000Z",
    network: "casper:casper-test",
    server: "s",
    tool: "t",
    payer: "p",
    payTo: "q",
    amountRaw: "1",
    asset: "a",
    assetSymbol: "TST",
    status: "settled",
    ...extra,
  };
}

describe("ReceiptStore", () => {
  it("persists updates (e.g. the anchor hash) and keeps the latest version per id on reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "cascet-store-test-"));
    try {
      const path = join(dir, "nested", "receipts.jsonl");
      const store = new ReceiptStore(path);
      const r1 = receipt("r1");
      store.add(r1);
      store.add(receipt("r2", { status: "unknown" }));
      r1.anchoredTxHash = "ab".repeat(32);
      store.update(r1);
      assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 3, "append-only log");
      const reloaded = new ReceiptStore(path).list();
      assert.deepEqual(reloaded.map(r => r.id), ["r1", "r2"]);
      assert.equal(reloaded[0]?.anchoredTxHash, "ab".repeat(32));
      assert.equal(reloaded[1]?.status, "unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("makeEventPusher", () => {
  it("recognizes loopback hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "[::1]"]) assert.equal(isLoopbackHostname(host), true, host);
    for (const host of ["example.com", "10.0.0.1", "127.example.com"]) assert.equal(isLoopbackHostname(host), false, host);
  });

  it("never sends the ingest token in clear text to a remote host", () => {
    assert.equal(ingestHeaders(new URL("http://dashboard.example/api/ingest"), "tok").authorization, undefined);
    assert.equal(ingestHeaders(new URL("https://dashboard.example/api/ingest"), "tok").authorization, "Bearer tok");
    assert.equal(ingestHeaders(new URL("http://localhost:3939/api/ingest"), "tok").authorization, "Bearer tok");
    assert.equal(ingestHeaders(new URL("https://dashboard.example/api/ingest"), undefined).authorization, undefined);
  });

  it("sends the ingest token to a local dashboard", async () => {
    const seen: Array<string | undefined> = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      req.resume();
      req.on("end", () => res.end());
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const push = makeEventPusher(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ingest`, "tok");
      push({ type: "server-offline", server: "s" });
      const deadline = Date.now() + 2_000;
      while (seen.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.deepEqual(seen, ["Bearer tok"]);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
