import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, it, mock } from "node:test";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { x402HTTPResourceServer } from "@x402/core/server";
import type { PaymentRequired } from "@x402/core/types";
import type { AnchorChain } from "./anchor.js";
import type { PreemptionOutcome, SettlementPreemptionChecker } from "./preemption.js";
import { SETTLE_TX } from "./testing/fake-facilitator.js";
import {
  ASSET,
  PAY_TO,
  PAYER,
  PRICE_RAW,
  callPaid,
  challengeOf,
  eventually,
  payFor,
  receipts,
  rpcCall,
  startHarness,
  type Harness,
} from "./testing/harness.js";

const CASPER_SETTLE_FAILED = "invalid_exact_casper_facilitator_settle_failed";

async function withHarness(
  opts: Parameters<typeof startHarness>[0],
  run: (h: Harness) => Promise<void>,
): Promise<void> {
  const h = await startHarness(opts);
  try {
    await run(h);
  } finally {
    await h.close();
  }
}

describe("402 answers are JSON-RPC (M19)", () => {
  it("answers an unpaid priced call with HTTP 402 and error -32002 carrying the decoded PaymentRequired", async () => {
    await withHarness({}, async h => {
      const res = await h.rpc("tools/call", { name: "paid_tool", arguments: {} });
      assert.equal(res.status, 402);
      assert.equal(res.body.jsonrpc, "2.0");
      assert.equal(typeof res.body.id, "number");
      assert.equal(res.body.error?.code, -32002);
      const data = res.body.error?.data as unknown as PaymentRequired;
      assert.equal(data.x402Version, 2);
      assert.equal(data.accepts[0]?.amount, PRICE_RAW);
      assert.equal(data.accepts[0]?.payTo, PAY_TO);
      assert.equal(data.accepts[0]?.asset, ASSET);
      assert.deepEqual(challengeOf(res).accepts, data.accepts);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);
      assert.equal(h.upstream.calls.length, 0);
    });
  });

  it("answers browser-looking requests with JSON-RPC as well, never the HTML paywall", async () => {
    await withHarness({}, async h => {
      const res = await h.rpc(
        "tools/call",
        { name: "paid_tool", arguments: {} },
        { accept: "text/html,application/json", "user-agent": "Mozilla/5.0" },
      );
      assert.equal(res.status, 402);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);
      assert.equal(res.body.error?.code, -32002);
    });
  });

  it("answers a failed settlement with HTTP 402, the PAYMENT-RESPONSE header and the facilitator's reason", async () => {
    await withHarness({}, async h => {
      h.facilitator.onSettle = () => ({
        json: {
          success: false,
          errorReason: CASPER_SETTLE_FAILED,
          errorMessage: "transaction execution failed: User error: 2",
          transaction: "",
          network: "casper:casper-test",
        },
      });
      const { header, nonce } = await payFor(h, "paid_tool");
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 402);
      assert.equal(res.body.error?.code, -32002);
      assert.match(res.body.error?.message ?? "", /settlement failed: .*transaction execution failed/);
      assert.equal((res.body.error?.data as { x402Version?: number }).x402Version, 2);
      assert.ok(res.body.error?.data?.paymentId);
      const paymentResponse = decodePaymentResponseHeader(res.headers.get("payment-response") ?? "");
      assert.equal(paymentResponse.success, false);
      assert.equal(res.body.result, undefined, "the tool result is withheld");
      const [receipt] = await receipts(h);
      assert.equal(receipt?.status, "failed");
      assert.equal(receipt?.nonce, nonce);
      assert.equal(receipt?.id, res.body.error?.data?.paymentId, "failure receipts keep the payment id forwarded upstream");
    });
  });
});

describe("fail closed after verification (M19)", () => {
  it("refuses a verified payment whose requirements differ from the configured price with a full JSON-RPC 402", async () => {
    // Unreachable through the public API (x402 returns the route's own requirements), so
    // simulate an x402 layer that verified something else than this tool's price.
    const original = x402HTTPResourceServer.prototype.processHTTPRequest;
    const patched = mock.method(
      x402HTTPResourceServer.prototype,
      "processHTTPRequest",
      async function (this: x402HTTPResourceServer, ...args: Parameters<typeof original>) {
        const result = await original.apply(this, args);
        return result.type === "payment-verified" ? { ...result, paymentRequirements: { ...result.paymentRequirements, amount: "1" } } : result;
      },
    );
    try {
      await withHarness({}, async h => {
        const { header } = await payFor(h, "paid_tool");
        const res = await callPaid(h, "paid_tool", header);
        assert.equal(res.status, 402);
        assert.equal(res.body.error?.code, -32002);
        assert.match(res.body.error?.message ?? "", /amount does not equal the configured price/);
        const data = res.body.error?.data as unknown as PaymentRequired;
        assert.equal(data.x402Version, 2);
        assert.equal(data.accepts[0]?.amount, PRICE_RAW);
        assert.match(challengeOf(res).error ?? "", /amount does not equal/, "the PAYMENT-REQUIRED header carries the reason");
        assert.equal(h.upstream.calls.length, 0);
        assert.equal(h.facilitator.count("settle"), 0);
      });
    } finally {
      patched.mock.restore();
    }
  });
});

describe("paid calls", () => {
  it("runs the tool, then settles, and returns the result with the payment metadata", async () => {
    await withHarness({}, async h => {
      const { header, nonce } = await payFor(h, "paid_tool");
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 200);
      assert.equal(res.body.result?.content?.[0]?.text, "ok:paid_tool");
      const meta = (res.body.result?._meta as { cascet: { paymentId: string; txHash: string; amountRaw: string } }).cascet;
      assert.match(meta.paymentId, /^[0-9a-f-]{36}$/);
      assert.equal(meta.txHash, SETTLE_TX);
      assert.equal(meta.amountRaw, PRICE_RAW);
      assert.equal(res.headers.get("x-cascet-payment-id"), meta.paymentId);
      assert.equal(decodePaymentResponseHeader(res.headers.get("payment-response") ?? "").success, true);
      assert.deepEqual(h.events, ["verify", "exec:paid_tool", "settle"]);
      assert.deepEqual(h.upstream.calls[0]?.meta, { cascet: { paymentId: meta.paymentId, server: "test-gateway" } });
      const [receipt] = await receipts(h);
      assert.equal(receipt?.status, "settled");
      assert.equal(receipt?.settledBy, "facilitator");
      assert.equal(receipt?.payer, PAYER);
      assert.equal(receipt?.nonce, nonce);
      assert.equal(receipt?.amountRaw, PRICE_RAW);
    });
  });

  it("does not settle when the tool returns an error (the buyer is not charged)", async () => {
    await withHarness(
      { tools: [{ name: "paid_tool", handler: () => ({ isError: true, content: [{ type: "text", text: "boom" }] }) }] },
      async h => {
        const { header } = await payFor(h, "paid_tool");
        const res = await callPaid(h, "paid_tool", header);
        assert.equal(res.status, 200);
        assert.equal(res.body.result?.isError, true);
        assert.equal(h.facilitator.count("settle"), 0);
        assert.deepEqual(await receipts(h), []);
      },
    );
  });

  it("records a valid parent id and ignores a malformed one", async () => {
    await withHarness({}, async h => {
      const parent = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
      const first = await payFor(h, "paid_tool");
      assert.equal((await callPaid(h, "paid_tool", first.header, { "x-cascet-parent-id": parent })).status, 200);
      const second = await payFor(h, "paid_tool");
      assert.equal((await callPaid(h, "paid_tool", second.header, { "x-cascet-parent-id": "not-a-uuid" })).status, 200);
      const list = await receipts(h);
      assert.equal(list[0]?.parentId, parent);
      assert.equal(list[1]?.parentId, undefined);
    });
  });
});

describe("replay protection (M18)", () => {
  it("refuses a replayed authorization before the facilitator or the upstream is involved", async () => {
    await withHarness({}, async h => {
      const { header } = await payFor(h, "paid_tool");
      assert.equal((await callPaid(h, "paid_tool", header)).status, 200);
      const replay = await callPaid(h, "paid_tool", header);
      assert.equal(replay.status, 402);
      assert.equal(replay.body.error?.code, -32002);
      assert.match(replay.body.error?.message ?? "", /duplicate_payment/);
      assert.equal(h.facilitator.count("verify"), 1);
      assert.equal(h.facilitator.count("settle"), 1);
      assert.equal(h.upstream.calls.length, 1);
    });
  });

  it("lets only one of two concurrent identical payments through", async () => {
    await withHarness({}, async h => {
      h.facilitator.onVerify = call => ({
        delayMs: 150,
        json: { isValid: true, payer: call.body?.paymentPayload?.payload?.authorization?.from },
      });
      const { header } = await payFor(h, "paid_tool");
      const results = await Promise.all([callPaid(h, "paid_tool", header), callPaid(h, "paid_tool", header)]);
      assert.deepEqual(results.map(r => r.status).sort(), [200, 402]);
      assert.equal(h.facilitator.count("verify"), 1);
      assert.equal(h.upstream.calls.length, 1);
    });
  });

  it("frees the authorization again when verification fails, so a corrected retry is possible", async () => {
    await withHarness({}, async h => {
      let verifies = 0;
      h.facilitator.onVerify = call => {
        verifies++;
        return verifies === 1
          ? { json: { isValid: false, invalidReason: "insufficient_funds" } }
          : { json: { isValid: true, payer: call.body?.paymentPayload?.payload?.authorization?.from } };
      };
      const { header } = await payFor(h, "paid_tool");
      const rejected = await callPaid(h, "paid_tool", header);
      assert.equal(rejected.status, 402);
      assert.match(rejected.body.error?.message ?? "", /insufficient_funds/);
      assert.equal(h.upstream.calls.length, 0);
      assert.equal((await callPaid(h, "paid_tool", header)).status, 200);
    });
  });

  it("still refuses the replay after a restart (nonces are persisted in the receipt log)", async () => {
    const first = await startHarness();
    try {
      const { header } = await payFor(first, "paid_tool");
      assert.equal((await callPaid(first, "paid_tool", header)).status, 200);
      await first.gateway.close();
      await withHarness({ gateway: { receiptsPath: first.receiptsPath } }, async second => {
        const replay = await callPaid(second, "paid_tool", header);
        assert.equal(replay.status, 402);
        assert.match(replay.body.error?.message ?? "", /duplicate_payment/);
        assert.equal(second.facilitator.count("verify"), 0);
      });
    } finally {
      await first.close();
    }
  });

  it("records the payer it verified and still refuses the replay after a restart when the facilitator spells the payer differently", async () => {
    const first = await startHarness();
    try {
      first.facilitator.onSettle = () => ({
        json: { success: true, transaction: SETTLE_TX, network: "casper:casper-test", payer: `account-hash-${PAYER.slice(2).toUpperCase()}` },
      });
      const { header } = await payFor(first, "paid_tool");
      assert.equal((await callPaid(first, "paid_tool", header)).status, 200);
      assert.equal((await receipts(first))[0]?.payer, PAYER, "the receipt carries the verified payer");
      await first.gateway.close();
      // Drop the write-ahead record to prove the receipt alone is enough.
      const receiptLines = readFileSync(first.receiptsPath, "utf8")
        .split("\n")
        .filter(line => line && !line.includes('"kind":"authorization"'));
      writeFileSync(first.receiptsPath, `${receiptLines.join("\n")}\n`);
      await withHarness({ gateway: { receiptsPath: first.receiptsPath } }, async second => {
        const replay = await callPaid(second, "paid_tool", header);
        assert.equal(replay.status, 402);
        assert.match(replay.body.error?.message ?? "", /duplicate_payment/);
        assert.equal(second.facilitator.count("verify"), 0);
      });
    } finally {
      await first.close();
    }
  });

  it("refuses the replay after a restart even when the first gateway never wrote a receipt (write-ahead record)", async () => {
    let release!: () => void;
    const running = new Promise<void>(resolve => (release = resolve));
    const slow = [{ name: "paid_tool", handler: async () => (await running, { content: [{ type: "text" as const, text: "late" }] }) }];
    const first = await startHarness({ tools: slow });
    try {
      const { header, nonce } = await payFor(first, "paid_tool");
      const pending = callPaid(first, "paid_tool", header);
      await eventually(() => first.upstream.calls.length === 1, 3_000, "the tool to start");
      // The tool is running and nothing has settled: as if the process died right now.
      const log = readFileSync(first.receiptsPath, "utf8");
      assert.match(log, new RegExp(`"kind":"authorization","payer":"${PAYER}","nonce":"${nonce}"`));
      assert.equal(await receipts(first).then(list => list.length), 0);
      await withHarness({ gateway: { receiptsPath: first.receiptsPath } }, async second => {
        const replay = await callPaid(second, "paid_tool", header);
        assert.equal(replay.status, 402);
        assert.match(replay.body.error?.message ?? "", /duplicate_payment/);
        assert.equal(second.facilitator.count("verify"), 0);
      });
      release();
      assert.equal((await pending).status, 200);
    } finally {
      release();
      await first.close();
    }
  });

  it("checks the authorization terms locally before verification", async () => {
    await withHarness({}, async h => {
      const now = Math.floor(Date.now() / 1_000);
      const cases: Array<[Parameters<typeof payFor>[2], RegExp]> = [
        [{ value: "1" }, /does not equal the price/],
        [{ to: `00${"55".repeat(32)}` }, /not this gateway's payTo/],
        [{ validBefore: now + 20 }, /authorization_expires_too_soon/],
        [{ validBefore: now + 3_600 }, /authorization_validity_too_long/],
        [{ nonce: "abc" }, /nonce must be 32 bytes/],
      ];
      for (const [overrides, expected] of cases) {
        const { header } = await payFor(h, "paid_tool", overrides);
        const res = await callPaid(h, "paid_tool", header);
        assert.equal(res.status, 402);
        assert.equal(res.body.error?.code, -32002);
        assert.match(res.body.error?.message ?? "", expected);
        assert.match(challengeOf(res).error ?? "", expected, "the fresh challenge carries the reason");
      }
      assert.equal(h.facilitator.count("verify"), 0);
      assert.equal(h.upstream.calls.length, 0);
    });
  });

  it("counts the facilitator's verify time in the validity an authorization needs", async () => {
    // Defaults: facilitatorMs 15 s + upstreamMs 60 s + 30 s settle headroom = 105 s.
    await withHarness({}, async h => {
      const now = Math.floor(Date.now() / 1_000);
      const tooShort = await payFor(h, "paid_tool", { validBefore: now + 60 + 30 + 1 });
      const refused = await callPaid(h, "paid_tool", tooShort.header);
      assert.equal(refused.status, 402);
      assert.match(refused.body.error?.message ?? "", /authorization_expires_too_soon: it must stay valid for at least 105 s/);
      assert.equal(h.facilitator.count("verify"), 0);
      const enough = await payFor(h, "paid_tool", { validBefore: Math.floor(Date.now() / 1_000) + 107 });
      assert.equal((await callPaid(h, "paid_tool", enough.header)).status, 200);
    });
  });

  it("needs only verify time, the upstream ping and headroom when the tool settles before it runs", async () => {
    // Defaults: facilitatorMs 15 s + the upstream ping before the settlement (5 s at most) + 30 s settle headroom = 50 s.
    const config = { pricing: { tools: { paid_tool: { price: "$0.01", settleBeforeExecute: true } } } };
    await withHarness({ config }, async h => {
      const tooShort = await payFor(h, "paid_tool", { validBefore: Math.floor(Date.now() / 1_000) + 15 + 30 + 2 });
      const refused = await callPaid(h, "paid_tool", tooShort.header);
      assert.match(refused.body.error?.message ?? "", /authorization_expires_too_soon: it must stay valid for at least 50 s/);
      const { header } = await payFor(h, "paid_tool", { validBefore: Math.floor(Date.now() / 1_000) + 15 + 5 + 30 + 2 });
      assert.equal((await callPaid(h, "paid_tool", header)).status, 200);
    });
  });

  it("refuses authorizations that casper-x402 would verify but that can never settle, before verify", async () => {
    await withHarness({}, async h => {
      const cases: Array<[Parameters<typeof payFor>[2], RegExp]> = [
        // "01" + the payer's account hash: settles as an account-hash key, so the signed digest never matches.
        [{ from: `01${PAYER.slice(2)}` }, /only accounts sign authorizations/],
        // A secp256k1-tagged signature next to the payer's ed25519 key.
        [{ signature: `02${"00".repeat(64)}` }, /algorithm tag does not match/],
        // A public key of somebody else.
        [{ publicKey: `01${"55".repeat(32)}` }, /publicKey does not belong/],
      ];
      for (const [overrides, expected] of cases) {
        const { header } = await payFor(h, "paid_tool", overrides);
        const res = await callPaid(h, "paid_tool", header);
        assert.equal(res.status, 402);
        assert.equal(res.body.error?.code, -32002);
        assert.match(res.body.error?.message ?? "", expected);
        assert.equal((res.body.error?.data as unknown as PaymentRequired).x402Version, 2, "error.data is the fresh challenge");
      }
      assert.equal(h.facilitator.count("verify"), 0);
      assert.equal(h.facilitator.count("settle"), 0);
      assert.equal(h.upstream.calls.length, 0);
    });
  });
});

describe("settleBeforeExecute (M18)", () => {
  const config = {
    pricing: { tools: { paid_tool: { price: "$0.01", settleBeforeExecute: true } }, freeTools: ["free_tool"] },
  };

  it("settles before running the tool", async () => {
    await withHarness({ config }, async h => {
      const { header } = await payFor(h, "paid_tool");
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 200);
      assert.equal(res.body.result?.content?.[0]?.text, "ok:paid_tool");
      assert.deepEqual(h.events, ["verify", "settle", "exec:paid_tool"]);
    });
  });

  it("never runs the tool when settlement fails", async () => {
    await withHarness({ config }, async h => {
      h.facilitator.onSettle = () => ({
        json: { success: false, errorReason: "insufficient_balance", transaction: "", network: "casper:casper-test" },
      });
      const { header } = await payFor(h, "paid_tool");
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 402);
      assert.equal(h.upstream.calls.length, 0);
      assert.equal((await receipts(h))[0]?.status, "failed");
    });
  });

  it("never runs the tool when the settlement outcome is unknown", async () => {
    await withHarness({ config: { ...config, timeouts: { settleMs: 200 } } }, async h => {
      h.facilitator.onSettle = () => ({ hang: true });
      const { header } = await payFor(h, "paid_tool");
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.body.error?.code, -32003);
      assert.equal(h.upstream.calls.length, 0);
      assert.equal((await receipts(h))[0]?.status, "unknown");
    });
  });

  it("does not settle when the upstream stopped answering during verification", async () => {
    await withHarness({ config, gateway: { reconnect: { maxAttempts: 50, baseDelayMs: 1_000, maxDelayMs: 1_000 } } }, async h => {
      const { header } = await payFor(h, "paid_tool");
      h.facilitator.onVerify = async call => {
        h.upstream.failConnections = true;
        await h.upstream.crash();
        return { json: { isValid: true, payer: call.body?.paymentPayload?.payload?.authorization?.from } };
      };
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 503);
      assert.match(res.body.error?.message ?? "", /nothing was charged/);
      assert.equal(h.facilitator.count("settle"), 0);
      assert.deepEqual(await receipts(h), []);
    });
  });

  it("reports a tool failure after settlement as not refunded and notes it on the receipt", async () => {
    await withHarness(
      {
        config,
        tools: [
          {
            name: "paid_tool",
            handler: () => {
              throw new Error("upstream exploded");
            },
          },
        ],
      },
      async h => {
        const { header } = await payFor(h, "paid_tool");
        const res = await callPaid(h, "paid_tool", header);
        assert.equal(res.status, 200);
        assert.equal(res.body.error?.code, -32603);
        assert.match(res.body.error?.message ?? "", /not refunded/);
        const [receipt] = await receipts(h);
        assert.equal(receipt?.status, "settled");
        assert.match(String(receipt?.note), /not refunded/);
      },
    );
  });
});

describe("indeterminate settlement (M35)", () => {
  it("records an unknown receipt and answers -32003 when settle times out after execution", async () => {
    await withHarness({ config: { timeouts: { settleMs: 200 } } }, async h => {
      h.facilitator.onSettle = () => ({ hang: true });
      const { header, nonce } = await payFor(h, "paid_tool");
      const started = Date.now();
      const res = await callPaid(h, "paid_tool", header);
      assert.ok(Date.now() - started < 5_000, "the buyer is not kept waiting");
      assert.equal(res.status, 200);
      assert.equal(res.body.error?.code, -32003);
      assert.match(res.body.error?.message ?? "", /indeterminate/);
      assert.equal(res.body.error?.data?.status, "unknown");
      assert.equal(res.body.result, undefined);
      assert.equal(h.upstream.calls.length, 1);
      const [receipt] = await receipts(h);
      assert.equal(receipt?.status, "unknown");
      assert.equal(receipt?.nonce, nonce);
      assert.equal(receipt?.id, res.body.error?.data?.paymentId);
      assert.match(String(receipt?.note), /timed out/);
    });
  });

  it("treats a proxy error page from /settle as unknown, not as failed", async () => {
    await withHarness({}, async h => {
      h.facilitator.onSettle = () => ({ status: 502, raw: "<html>Bad Gateway</html>" });
      const { header } = await payFor(h, "paid_tool");
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.body.error?.code, -32003);
      assert.equal((await receipts(h))[0]?.status, "unknown");
    });
  });

  it("treats a casper-x402 polling timeout as unknown", async () => {
    await withHarness({}, async h => {
      h.facilitator.onSettle = () => ({
        json: {
          success: false,
          errorReason: CASPER_SETTLE_FAILED,
          errorMessage: "Timed out waiting for transaction 9f…",
          transaction: "",
          network: "casper:casper-test",
        },
      });
      const { header } = await payFor(h, "paid_tool");
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.body.error?.code, -32003);
      assert.equal((await receipts(h))[0]?.status, "unknown");
    });
  });

  it("treats a definite rejection that mentions the network as failed, not unknown", async () => {
    await withHarness({}, async h => {
      h.facilitator.onSettle = () => ({
        json: { success: false, errorReason: "unsupported_network", transaction: "", network: "casper:casper-test" },
      });
      const { header } = await payFor(h, "paid_tool");
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 402);
      assert.equal(res.body.error?.code, -32002);
      assert.equal((await receipts(h))[0]?.status, "failed");
    });
  });

  it("treats an unsuccessful answer that carries a transaction hash as unknown (the transfer was submitted)", async () => {
    await withHarness({}, async h => {
      h.facilitator.onSettle = () => ({
        json: { success: false, errorReason: "rpc_unavailable", transaction: SETTLE_TX, network: "casper:casper-test" },
      });
      const { header } = await payFor(h, "paid_tool");
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.body.error?.code, -32003);
      const [receipt] = await receipts(h);
      assert.equal(receipt?.status, "unknown");
      assert.equal(receipt?.txHash, SETTLE_TX);
    });
  });

  it("answers a facilitator verify timeout with a 402 and charges nothing", async () => {
    await withHarness({ config: { timeouts: { facilitatorMs: 200 } } }, async h => {
      h.facilitator.onVerify = () => ({ hang: true });
      const { header } = await payFor(h, "paid_tool");
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 402);
      assert.match(res.body.error?.message ?? "", /timed out/);
      assert.equal(h.upstream.calls.length, 0);
      assert.equal(h.facilitator.count("settle"), 0);
    });
  });
});

describe("settlement preemption", () => {
  const reverted = () => ({
    json: {
      success: false,
      errorReason: CASPER_SETTLE_FAILED,
      errorMessage: "transaction execution failed: User error: 64001",
      transaction: "",
      network: "casper:casper-test",
    },
  });
  const checker = (outcome: PreemptionOutcome, seen: unknown[] = []): SettlementPreemptionChecker => ({
    check: async query => {
      seen.push(query);
      return outcome;
    },
  });

  it("delivers the result when the exact authorization was executed by someone else and that is allowed", async () => {
    const seen: unknown[] = [];
    await withHarness(
      {
        config: { settlement: { acceptThirdPartySettlement: true } },
        gateway: { preemptionChecker: checker({ kind: "paid", eventIndex: 41 }, seen) },
      },
      async h => {
        h.facilitator.onSettle = reverted;
        const { header, nonce } = await payFor(h, "paid_tool");
        const res = await callPaid(h, "paid_tool", header);
        assert.equal(res.status, 200);
        assert.equal(res.body.result?.content?.[0]?.text, "ok:paid_tool");
        assert.deepEqual(seen, [{ payer: PAYER, nonce, payTo: PAY_TO, amount: PRICE_RAW, asset: ASSET }]);
        const [receipt] = await receipts(h);
        assert.equal(receipt?.status, "settled");
        assert.equal(receipt?.settledBy, "third-party");
        assert.match(String(receipt?.note), /event #41/);
      },
    );
  });

  it("withholds the result and records unknown when third-party settlement is not accepted", async () => {
    await withHarness({ gateway: { preemptionChecker: checker({ kind: "paid", eventIndex: 3 }) } }, async h => {
      h.facilitator.onSettle = reverted;
      const { header } = await payFor(h, "paid_tool");
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.body.error?.code, -32003);
      assert.equal(res.body.result, undefined);
      assert.equal((await receipts(h))[0]?.status, "unknown");
    });
  });

  it("never takes a transaction the facilitator reported as reverted for the one that paid", async () => {
    // CasCet's self-hosted facilitator names the transaction that reverted: another one had used the nonce.
    const REVERTED_TX = "ab".repeat(32);
    const revertedWithHash = () => ({
      json: {
        success: false,
        errorReason: "settlement_failed",
        errorMessage: "transaction execution failed: User error: 64001",
        transaction: REVERTED_TX,
        network: "casper:casper-test",
      },
    });
    const anchoring = { contractPackageHash: `hash-${"99".repeat(32)}`, keyPath: "/nonexistent/recorder.pem", nodeUrl: "http://127.0.0.1:9/rpc" };
    for (const accept of [true, false]) {
      const anchored: Array<string | undefined> = [];
      const chain: AnchorChain = {
        submit: async receipt => {
          anchored.push(receipt.txHash);
          return "cd".repeat(32);
        },
        status: async () => ({ state: "executed" }),
      };
      await withHarness(
        {
          config: { settlement: { acceptThirdPartySettlement: accept }, anchoring },
          gateway: { preemptionChecker: checker({ kind: "paid", eventIndex: 41 }), anchorChain: chain, anchorPollIntervalMs: 1 },
        },
        async h => {
          h.facilitator.onSettle = revertedWithHash;
          const { header } = await payFor(h, "paid_tool");
          const res = await callPaid(h, "paid_tool", header);
          const [receipt] = await receipts(h);
          assert.doesNotMatch(String(receipt?.note), /possibly through/, `acceptThirdPartySettlement ${accept}`);
          if (accept) {
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual([receipt?.status, receipt?.settledBy, receipt?.txHash], ["settled", "third-party", undefined]);
            assert.equal((res.body.result?._meta as { cascet: Record<string, unknown> }).cascet.txHash, undefined);
            assert.match(String(receipt?.note), new RegExp(`\\(settled by another submitter; transaction ${REVERTED_TX} of this gateway's facilitator reverted\\)`));
            await eventually(async () => (await receipts(h))[0]?.anchoredTxHash !== undefined, 3_000, "the anchor");
            assert.deepEqual(anchored, [undefined], "nor anchored with it");
          } else {
            assert.equal(res.body.error?.code, -32003);
            assert.equal(receipt?.status, "unknown");
            assert.equal(receipt?.txHash, undefined, "reconciling by txHash must not land on the reverted transfer");
            assert.match(String(receipt?.note), new RegExp(`its transaction ${REVERTED_TX} reverted`));
            assert.match(String(receipt?.note), /paid payTo, executed by a submitter other than this gateway's facilitator( \(its transaction [0-9a-f]+ reverted\))?;/);
            assert.deepEqual(anchored, []);
          }
        },
      );
    }
  });

  it("records a failure when the payer canceled the nonce on-chain", async () => {
    await withHarness(
      {
        config: { settlement: { acceptThirdPartySettlement: true }, timeouts: { settleMs: 200 } },
        gateway: { preemptionChecker: checker({ kind: "canceled", eventIndex: 9 }) },
      },
      async h => {
        h.facilitator.onSettle = () => ({ hang: true });
        const { header } = await payFor(h, "paid_tool");
        const res = await callPaid(h, "paid_tool", header);
        assert.equal(res.status, 402);
        const [receipt] = await receipts(h);
        assert.equal(receipt?.status, "failed");
        assert.match(String(receipt?.note), /canceled/);
      },
    );
  });

  it("keeps an indeterminate settlement unknown when the nonce looks consumed elsewhere (layout-dependent evidence)", async () => {
    const consumed: PreemptionOutcome = { kind: "consumed-elsewhere", eventIndex: 12, detail: "no transfer event follows the authorization" };
    await withHarness({ config: { timeouts: { settleMs: 200 } }, gateway: { preemptionChecker: checker(consumed) } }, async h => {
      h.facilitator.onSettle = () => ({ hang: true });
      const { header } = await payFor(h, "paid_tool");
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.body.error?.code, -32003, "the buyer is told not to pay again");
      const [receipt] = await receipts(h);
      assert.equal(receipt?.status, "unknown");
      assert.match(String(receipt?.note), /event #12/);
    });
  });

  it("keeps a reverted settlement failed and notes where the nonce went", async () => {
    const consumed: PreemptionOutcome = { kind: "consumed-elsewhere", eventIndex: 7, detail: "the authorization paid a different recipient" };
    await withHarness({ gateway: { preemptionChecker: checker(consumed) } }, async h => {
      h.facilitator.onSettle = reverted;
      const { header } = await payFor(h, "paid_tool");
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 402);
      const [receipt] = await receipts(h);
      assert.equal(receipt?.status, "failed");
      assert.match(String(receipt?.note), /different recipient/);
    });
  });

  it("does not consult the chain for rejections that happen before submission", async () => {
    const seen: unknown[] = [];
    await withHarness({ gateway: { preemptionChecker: checker({ kind: "paid", eventIndex: 1 }, seen) } }, async h => {
      h.facilitator.onSettle = () => ({
        json: {
          success: false,
          errorReason: "invalid_exact_casper_facilitator_expired",
          transaction: "",
          network: "casper:casper-test",
        },
      });
      const { header } = await payFor(h, "paid_tool");
      assert.equal((await callPaid(h, "paid_tool", header)).status, 402);
      assert.deepEqual(seen, []);
    });
  });
});

describe("receipt log durability", () => {
  /** Make the receipt log unwritable (a directory where the file was). */
  const breakLog = (path: string) => {
    rmSync(path, { force: true });
    mkdirSync(path);
  };

  it("still returns the paid result when the receipt cannot be written after settlement", async () => {
    let onRun = () => {};
    const tools = [{ name: "paid_tool", handler: () => (onRun(), { content: [{ type: "text" as const, text: "ok:paid_tool" }] }) }];
    await withHarness({ tools }, async h => {
      onRun = () => breakLog(h.receiptsPath);
      const { header } = await payFor(h, "paid_tool");
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 200, "the buyer paid, so the result is delivered");
      assert.equal(res.body.result?.content?.[0]?.text, "ok:paid_tool");
      assert.equal(h.facilitator.count("settle"), 1);
      const [receipt] = await receipts(h);
      assert.equal(receipt?.status, "settled", "the receipt is kept in memory");
    });
  });

  it("refuses to run a paid call whose authorization cannot be recorded, and accepts it again later", async () => {
    await withHarness({}, async h => {
      const { header } = await payFor(h, "paid_tool");
      breakLog(h.receiptsPath);
      const refused = await callPaid(h, "paid_tool", header);
      assert.equal(refused.status, 503);
      assert.match(refused.body.error?.message ?? "", /nothing was charged/);
      assert.equal(h.upstream.calls.length, 0);
      assert.equal(h.facilitator.count("settle"), 0);
      rmSync(h.receiptsPath, { recursive: true, force: true });
      writeFileSync(h.receiptsPath, "");
      assert.equal((await callPaid(h, "paid_tool", header)).status, 200, "the authorization was released");
    });
  });

  it("lets a paid call that is settling finish (with its receipt) when the gateway closes", async () => {
    await withHarness({}, async h => {
      h.facilitator.onSettle = call => ({
        delayMs: 300,
        json: { success: true, transaction: SETTLE_TX, network: "casper:casper-test", payer: call.body?.paymentPayload?.payload?.authorization?.from },
      });
      const { header } = await payFor(h, "paid_tool");
      const pending = callPaid(h, "paid_tool", header);
      await eventually(() => h.facilitator.count("settle") === 1, 3_000, "settlement to start");
      const closing = h.gateway.close();
      const late = await rpcCall(h.gateway.url, "tools/list").then(
        r => r.status,
        () => "refused",
      );
      assert.ok(late === 503 || late === "refused", `new calls are refused while draining (got ${late})`);
      const res = await pending;
      assert.equal(res.status, 200);
      await closing;
      const logged = readFileSync(h.receiptsPath, "utf8");
      assert.match(logged, new RegExp(`"id":"${res.headers.get("x-cascet-payment-id")}"[^\\n]*"status":"settled"`));
    });
  });
});
