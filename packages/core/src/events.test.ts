import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isCascetEvent } from "./events.js";
import type { PaymentReceipt } from "./receipts.js";

const receipt: PaymentReceipt = {
  id: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
  createdAt: "2026-11-01T00:00:00.000Z",
  network: "casper:casper-test",
  server: "s",
  tool: "t",
  payer: `00${"aa".repeat(32)}`,
  payTo: `00${"bb".repeat(32)}`,
  amountRaw: "500",
  asset: "cc".repeat(32),
  assetSymbol: "TST",
  status: "settled",
};

const event = (r: Record<string, unknown>) => ({ type: "receipt", receipt: r });

describe("receipt events", () => {
  it("accepts the unknown status and the settlement fields", () => {
    assert.equal(isCascetEvent(event({ ...receipt, status: "unknown", note: "facilitator timed out", nonce: "dd".repeat(32) })), true);
    assert.equal(isCascetEvent(event({ ...receipt, settledBy: "third-party" })), true);
    assert.equal(isCascetEvent(event({ ...receipt, status: "failed" })), true);
  });

  it("rejects unknown statuses and malformed settlement fields", () => {
    assert.equal(isCascetEvent(event({ ...receipt, status: "pending" })), false);
    assert.equal(isCascetEvent(event({ ...receipt, settledBy: "someone" })), false);
    assert.equal(isCascetEvent(event({ ...receipt, note: "x".repeat(1_001) })), false);
    assert.equal(isCascetEvent(event({ ...receipt, nonce: 5 })), false);
    assert.equal(isCascetEvent(event({ ...receipt, amountRaw: "-1" })), false);
  });
});
