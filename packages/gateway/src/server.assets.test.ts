import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import casperSdk from "casper-js-sdk";
import { x402Client } from "@x402/core/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import {
  FacilitatorTimeoutError,
  x402HTTPResourceServer,
  x402ResourceServer,
  type VerifiedPaymentCancelOptions,
} from "@x402/core/server";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactCasperScheme } from "@x402/casper/exact/client";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_FACILITATOR_URL, type CascetConfig } from "@cascet/core";
import type { PreemptionOutcome, PreemptionQuery, SettlementPreemptionChecker } from "./preemption.js";
import { startGateway, type GatewayOptions } from "./server.js";
import { startFakeFacilitator, type FakeFacilitator, type Reply } from "./testing/fake-facilitator.js";
import { startFakeNode, u256Response, wcsprBalanceCall, wcsprNodeRoutes, wcsprNonceCall } from "./testing/fake-node.js";
import { createFakeUpstream, type FakeTool } from "./testing/fake-upstream.js";
import {
  callPaid,
  challengeOf,
  LEGACY_PRICE_RAW,
  LEGACY_SETTLE_TX,
  LEGACY_TOKEN,
  PAY_TO,
  PAYER,
  paymentHeader,
  payInAsset,
  receipts,
  rpcCall,
  startTwoAssetHarness,
  twoAssetConfig,
  WCSPR_PRICE_RAW,
  WCSPR_SETTLE_TX,
  WCSPR_TOKEN,
  type RpcResponse,
  type TwoAssetHarness,
} from "./testing/harness.js";
import { ReceiptStore } from "./store.js";

const CASPER_SETTLE_FAILED = "invalid_exact_casper_facilitator_settle_failed";

/** What the in-memory hosted facilitator receives. */
interface HostedBody {
  paymentPayload?: { accepted?: { extra?: Record<string, unknown> }; payload?: { authorization?: { from?: string } } };
  paymentRequirements?: { asset?: string; extra?: Record<string, unknown> };
}

async function withTwoAssets(opts: Parameters<typeof startTwoAssetHarness>[0], run: (h: TwoAssetHarness) => Promise<void>): Promise<void> {
  const h = await startTwoAssetHarness(opts);
  try {
    await run(h);
  } finally {
    await h.close();
  }
}

/** Record every cancel() of x402's verified-payment cancellation dispatchers (reasons, in order). */
function spyOnCancellations(): { reasons: Array<VerifiedPaymentCancelOptions["reason"]>; restore: () => void } {
  const reasons: Array<VerifiedPaymentCancelOptions["reason"]> = [];
  const original = x402ResourceServer.prototype.createPaymentCancellationDispatcher;
  const patched = mock.method(
    x402ResourceServer.prototype,
    "createPaymentCancellationDispatcher",
    function (this: x402ResourceServer, ...args: Parameters<typeof original>) {
      const dispatcher = original.apply(this, args);
      return {
        cancel: (options: VerifiedPaymentCancelOptions) => {
          reasons.push(options.reason);
          return dispatcher.cancel(options);
        },
      };
    },
  );
  return { reasons, restore: () => patched.mock.restore() };
}

/** Make the receipt log unwritable (a directory where the file was). */
function breakLog(path: string): void {
  rmSync(path, { force: true });
  mkdirSync(path);
}

/** Facilitator calls other than /supported, as "<op> <asset>" lines. */
const work = (calls: Array<{ op: string; body?: { paymentRequirements?: Record<string, unknown> } }>) =>
  calls.filter(call => call.op !== "supported").map(call => `${call.op} ${String(call.body?.paymentRequirements?.asset)}`);

describe("a gateway that sells in two tokens, one per authorization style", () => {
  it("offers both tokens in config order, each with its EIP-712 domain, display fields and authorization style", async () => {
    await withTwoAssets({}, async h => {
      const res = await h.rpc("tools/call", { name: "paid_tool", arguments: {} });
      assert.equal(res.status, 402);
      const challenge = challengeOf(res);
      assert.deepEqual(challenge.accepts, (res.body.error?.data as unknown as PaymentRequired).accepts);
      const [legacy, wcspr] = challenge.accepts;
      assert.equal(challenge.accepts.length, 2);
      assert.deepEqual(
        { ...legacy, maxTimeoutSeconds: undefined },
        {
          scheme: "exact",
          network: "casper:casper-test",
          amount: LEGACY_PRICE_RAW,
          asset: LEGACY_TOKEN,
          payTo: PAY_TO,
          maxTimeoutSeconds: undefined,
          extra: { name: "CasCet X402 Token", version: "1", symbol: "CASCET", decimals: "9", authorizationStyle: "legacy-amount" },
        },
      );
      assert.deepEqual(
        { ...wcspr, maxTimeoutSeconds: undefined },
        {
          scheme: "exact",
          network: "casper:casper-test",
          amount: WCSPR_PRICE_RAW,
          asset: WCSPR_TOKEN,
          payTo: PAY_TO,
          maxTimeoutSeconds: undefined,
          extra: { name: "Wrapped CSPR", version: "1", symbol: "WCSPR", decimals: "9", authorizationStyle: "cep3009-value" },
        },
      );
      assert.equal(legacy?.maxTimeoutSeconds, wcspr?.maxTimeoutSeconds);
      assert.deepEqual([h.legacy.count("supported"), h.cep.count("supported")], [1, 1]);
      assert.deepEqual([...work(h.legacy.calls), ...work(h.cep.calls)], []);
    });
  });

  it("verifies and settles a Wrapped CSPR payment with the CEP-3009 token's facilitator only, and records that token", async () => {
    await withTwoAssets({}, async h => {
      const { header, nonce } = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(h.events, ["cep:verify", "exec:paid_tool", "cep:settle"]);
      assert.deepEqual(work(h.cep.calls), [`verify ${WCSPR_TOKEN}`, `settle ${WCSPR_TOKEN}`]);
      assert.deepEqual(work(h.legacy.calls), []);
      assert.deepEqual(
        h.cep.calls.map(call => call.authorization),
        ["cep-key", "cep-key", "cep-key"],
        "the default facilitator gets its raw key on every call",
      );
      assert.equal(h.cep.calls[2]?.body?.paymentRequirements?.amount, WCSPR_PRICE_RAW);

      const meta = (res.body.result?._meta as { cascet: Record<string, unknown> }).cascet;
      assert.deepEqual(
        [meta.asset, meta.assetSymbol, meta.amountRaw, meta.txHash],
        [WCSPR_TOKEN, "WCSPR", WCSPR_PRICE_RAW, WCSPR_SETTLE_TX],
      );
      const [receipt] = await receipts(h);
      assert.deepEqual(
        [receipt?.status, receipt?.asset, receipt?.assetSymbol, receipt?.amountRaw, receipt?.txHash, receipt?.nonce, receipt?.payer],
        ["settled", WCSPR_TOKEN, "WCSPR", WCSPR_PRICE_RAW, WCSPR_SETTLE_TX, nonce, PAYER],
      );
      assert.match(
        readFileSync(h.receiptsPath, "utf8"),
        new RegExp(`"kind":"authorization","payer":"${PAYER}","nonce":"${nonce}","validBefore":\\d+,"asset":"${WCSPR_TOKEN}"`),
        "the write-ahead record names the token",
      );
    });
  });

  it("verifies and settles a legacy-token payment with its self-hosted facilitator only", async () => {
    await withTwoAssets({}, async h => {
      const { header } = await payInAsset(h, "paid_tool", LEGACY_TOKEN);
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(h.events, ["legacy:verify", "exec:paid_tool", "legacy:settle"]);
      assert.deepEqual(work(h.cep.calls), []);
      assert.deepEqual(
        h.legacy.calls.map(call => call.authorization),
        ["Bearer self-key", "Bearer self-key", "Bearer self-key"],
      );
      const [receipt] = await receipts(h);
      assert.deepEqual(
        [receipt?.asset, receipt?.assetSymbol, receipt?.amountRaw, receipt?.txHash],
        [LEGACY_TOKEN, "CASCET", LEGACY_PRICE_RAW, LEGACY_SETTLE_TX],
      );
    });
  });

  it("settles before running the tool in the token the buyer chose (settleBeforeExecute)", async () => {
    const config = { pricing: { tools: { paid_tool: { price: "$0.01", settleBeforeExecute: true } }, freeTools: ["free_tool"] } };
    await withTwoAssets({ config }, async h => {
      const { header } = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
      assert.equal((await callPaid(h, "paid_tool", header)).status, 200);
      assert.deepEqual(h.events, ["cep:verify", "cep:settle", "exec:paid_tool"]);
    });
  });
});

describe("local checks work in the token the payment names", () => {
  const config = {
    pricing: { tools: { paid_tool: { price: "$0.01" }, wcspr_tool: { price: "$0.01", assets: ["wcspr"] } }, freeTools: ["free_tool"] },
  };
  const tools = [{ name: "paid_tool" }, { name: "wcspr_tool" }, { name: "free_tool" }];

  it("offers a tool restricted by pricing.tools.<name>.assets in its tokens only, and refuses other tokens before verification", async () => {
    await withTwoAssets({ config, tools }, async h => {
      const restricted = challengeOf(await h.rpc("tools/call", { name: "wcspr_tool", arguments: {} }));
      assert.deepEqual(
        restricted.accepts.map(entry => entry.asset),
        [WCSPR_TOKEN],
      );
      // A legacy-token payment, valid for paid_tool, presented to the WCSPR-only tool.
      const { header } = await payInAsset(h, "paid_tool", LEGACY_TOKEN);
      const refused = await callPaid(h, "wcspr_tool", header);
      assert.equal(refused.status, 402);
      assert.equal(refused.body.error?.code, -32002);
      assert.match(refused.body.error?.message ?? "", new RegExp(`unsupported_asset: this tool is not sold for token ${LEGACY_TOKEN} \\(it accepts wcspr\\)`));
      assert.deepEqual(
        challengeOf(refused).accepts.map(entry => entry.asset),
        [WCSPR_TOKEN],
        "the fresh challenge offers the tool's own tokens",
      );
      assert.deepEqual([...work(h.legacy.calls), ...work(h.cep.calls)], []);
      assert.equal(h.upstream.calls.length, 0);

      const paid = await payInAsset(h, "wcspr_tool", WCSPR_TOKEN);
      assert.equal((await callPaid(h, "wcspr_tool", paid.header)).status, 200);
    });
  });

  it("checks the amount against the price in the payment's own token", async () => {
    await withTwoAssets({ config, tools }, async h => {
      // The legacy price signed in WCSPR: 2.5× the WCSPR price.
      const { header } = await payInAsset(h, "paid_tool", WCSPR_TOKEN, { value: LEGACY_PRICE_RAW });
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 402);
      assert.match(res.body.error?.message ?? "", /authorization\.value 500000000 does not equal the price 200000000 \(WCSPR\)/);
      assert.deepEqual([...work(h.legacy.calls), ...work(h.cep.calls)], []);
    });
  });

  it("refuses a payment that names no token", async () => {
    await withTwoAssets({ config, tools }, async h => {
      const { accepted } = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
      const { header } = paymentHeader({ ...accepted, asset: "not-a-package-hash" } as PaymentRequirements);
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 402);
      assert.match(res.body.error?.message ?? "", /accepted\.asset is missing or not a contract package hash/);
      assert.deepEqual([...work(h.legacy.calls), ...work(h.cep.calls)], []);
    });
  });

  it("refuses a nonce already used in the other token (one replay key per payer and nonce)", async () => {
    await withTwoAssets({ config, tools }, async h => {
      const first = await payInAsset(h, "paid_tool", LEGACY_TOKEN);
      assert.equal((await callPaid(h, "paid_tool", first.header)).status, 200);
      const second = await payInAsset(h, "paid_tool", WCSPR_TOKEN, { nonce: first.nonce });
      const replay = await callPaid(h, "paid_tool", second.header);
      assert.equal(replay.status, 402);
      assert.match(replay.body.error?.message ?? "", /duplicate_payment/);
      assert.deepEqual(work(h.cep.calls), []);
    });
  });

  it("fails closed when x402 verified the payment in another token than the one checked locally", async () => {
    const original = x402HTTPResourceServer.prototype.processHTTPRequest;
    const patched = mock.method(
      x402HTTPResourceServer.prototype,
      "processHTTPRequest",
      async function (this: x402HTTPResourceServer, ...args: Parameters<typeof original>) {
        const result = await original.apply(this, args);
        return result.type === "payment-verified"
          ? { ...result, paymentRequirements: { ...result.paymentRequirements, asset: LEGACY_TOKEN, amount: LEGACY_PRICE_RAW } }
          : result;
      },
    );
    try {
      await withTwoAssets({ config, tools }, async h => {
        const { header } = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
        const res = await callPaid(h, "paid_tool", header);
        assert.equal(res.status, 402);
        assert.match(res.body.error?.message ?? "", /verified payment is in another asset/);
        assert.equal(h.upstream.calls.length, 0);
        assert.deepEqual([h.legacy.count("settle"), h.cep.count("settle")], [0, 0]);
      });
    } finally {
      patched.mock.restore();
    }
  });
});

describe("settlement outcomes stay with the token of the payment", () => {
  it("records an unknown receipt in Wrapped CSPR when its facilitator's own timeout expires, and the other token still settles", async () => {
    // The CEP-3009 token's facilitator (the default one) gets its own 400 ms timeout.
    const config = (urls: { cep: string }) => ({ facilitator: { url: urls.cep, apiKey: "cep-key", timeoutMs: 400 } });
    await withTwoAssets({ config }, async h => {
      h.cep.onSettle = () => ({ hang: true });
      const { header, nonce } = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
      const started = Date.now();
      const res = await callPaid(h, "paid_tool", header);
      assert.ok(Date.now() - started < 5_000, "bounded by the CEP-3009 facilitator's own timeout");
      assert.equal(res.body.error?.code, -32003);
      assert.equal(res.body.result, undefined);
      const [receipt] = await receipts(h);
      assert.deepEqual(
        [receipt?.status, receipt?.asset, receipt?.assetSymbol, receipt?.amountRaw, receipt?.nonce],
        ["unknown", WCSPR_TOKEN, "WCSPR", WCSPR_PRICE_RAW, nonce],
      );
      assert.match(String(receipt?.note), /timed out after 400 ms/);

      const other = await payInAsset(h, "paid_tool", LEGACY_TOKEN);
      assert.equal((await callPaid(h, "paid_tool", other.header)).status, 200);
      assert.deepEqual(
        (await receipts(h)).map(entry => [entry.asset, entry.status]),
        [
          [WCSPR_TOKEN, "unknown"],
          [LEGACY_TOKEN, "settled"],
        ],
      );
    });
  });

  it("maps x402's own facilitator timeout on settle to an unknown receipt in the payment's token", async () => {
    const patched = mock.method(x402ResourceServer.prototype, "settlePayment", async () => {
      throw new FacilitatorTimeoutError("settle", 90_000);
    });
    try {
      await withTwoAssets({}, async h => {
        const { header } = await payInAsset(h, "paid_tool", LEGACY_TOKEN);
        const res = await callPaid(h, "paid_tool", header);
        assert.equal(res.body.error?.code, -32003);
        assert.match(res.body.error?.message ?? "", /do not pay again/);
        const [receipt] = await receipts(h);
        assert.deepEqual([receipt?.status, receipt?.asset, receipt?.amountRaw], ["unknown", LEGACY_TOKEN, LEGACY_PRICE_RAW]);
        assert.match(String(receipt?.note), /Facilitator settle request timed out after 90000ms/);
      });
    } finally {
      patched.mock.restore();
    }
  });

  it("asks the on-chain check about the events of the token the payment was in", async () => {
    const seen: PreemptionQuery[] = [];
    const checker: SettlementPreemptionChecker = {
      check: async query => {
        seen.push(query);
        return { kind: "not-found", scanned: 64 };
      },
    };
    await withTwoAssets({ gateway: { preemptionChecker: checker } }, async h => {
      h.cep.onSettle = () => ({
        json: {
          success: false,
          errorReason: CASPER_SETTLE_FAILED,
          errorMessage: "transaction execution failed: User error: 64001",
          transaction: "",
          network: "casper:casper-test",
        },
      });
      const { header, nonce } = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
      assert.equal((await callPaid(h, "paid_tool", header)).status, 402);
      assert.deepEqual(seen, [{ payer: PAYER, nonce, payTo: PAY_TO, amount: WCSPR_PRICE_RAW, asset: WCSPR_TOKEN }]);
      const [receipt] = await receipts(h);
      assert.deepEqual([receipt?.status, receipt?.asset], ["failed", WCSPR_TOKEN]);
    });
  });
});

describe("x402's automatic retry of a settlement the facilitator reported as pending", () => {
  const PENDING_TX = "5e".repeat(32);
  const NETWORK = "casper:casper-test";

  /**
   * The legacy token's self-hosted facilitator answers the first /settle with
   * `settlement_pending` and a hash (broadcast, not seen executing in time), as
   * the real one does; x402 then settles again and the second answer is `retry`.
   */
  function pendingThen(h: TwoAssetHarness, retry: Reply): void {
    let settles = 0;
    h.legacy.onSettle = call => {
      settles++;
      if (settles > 1) return retry;
      return {
        json: {
          success: false,
          errorReason: "settlement_pending",
          errorMessage: "transaction submitted; its execution was not observed yet — reconcile by transaction hash",
          transaction: PENDING_TX,
          network: NETWORK,
          payer: call.body?.paymentPayload?.payload?.authorization?.from,
          extra: { settlementStatus: "pending" },
        },
      };
    };
  }

  /** The self-hosted facilitator's answer to a /settle its middleware refused before the core ran. */
  const refusal = (status: number, errorReason: string, errorMessage: string): Reply => ({
    status,
    json: { success: false, errorReason, errorMessage, transaction: "", network: NETWORK, extra: { settlementStatus: "not_submitted" } },
  });

  const retries: Array<[string, Reply]> = [
    ["429 rate_limited", refusal(429, "rate_limited", "too many requests; retry after the window resets")],
    ["503 facilitator_shutting_down", refusal(503, "facilitator_shutting_down", "the facilitator is shutting down; retry later")],
    ["a proxy's 404 page", { status: 404, raw: "<html>Not Found</html>" }],
  ];
  for (const [name, retry] of retries) {
    it(`records the payment as unknown with the pending transaction when the retry gets ${name}, and never invites a second payment`, async () => {
      await withTwoAssets({}, async h => {
        pendingThen(h, retry);
        const { header, nonce } = await payInAsset(h, "paid_tool", LEGACY_TOKEN);
        const res = await callPaid(h, "paid_tool", header);
        assert.equal(h.legacy.count("settle"), 2, "x402 settled twice");
        assert.equal(res.status, 200);
        assert.equal(res.body.error?.code, -32003);
        assert.match(res.body.error?.message ?? "", /do not pay again/);
        assert.equal(res.headers.get("payment-required"), null, "no fresh challenge");
        assert.equal((res.body.error?.data as { accepts?: unknown } | undefined)?.accepts, undefined);
        assert.equal(res.body.result, undefined);
        const [receipt] = await receipts(h);
        assert.deepEqual(
          [receipt?.status, receipt?.txHash, receipt?.asset, receipt?.nonce, receipt?.payer],
          ["unknown", PENDING_TX, LEGACY_TOKEN, nonce, PAYER],
        );
        assert.match(String(receipt?.note), new RegExp(`retry after pending transaction ${PENDING_TX} answered`));
        assert.equal(res.headers.get("x-cascet-payment-id"), receipt?.id);
      });
    });
  }

  it("keeps the pending transaction on an unknown receipt when the retry itself is indeterminate (502 without a verdict)", async () => {
    await withTwoAssets({}, async h => {
      pendingThen(h, { status: 502, raw: "<html>Bad Gateway</html>" });
      const { header } = await payInAsset(h, "paid_tool", LEGACY_TOKEN);
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.body.error?.code, -32003);
      const [receipt] = await receipts(h);
      assert.deepEqual([receipt?.status, receipt?.txHash], ["unknown", PENDING_TX]);
      assert.match(
        String(receipt?.note),
        new RegExp(`HTTP 502 and no settle verdict .*\\(retrying a settlement the facilitator had reported as pending with transaction ${PENDING_TX}\\)`),
      );
    });
  });

  it("keeps the hash a retry answers with (409 duplicate_nonce)", async () => {
    await withTwoAssets({}, async h => {
      pendingThen(h, {
        status: 409,
        json: {
          success: false,
          errorReason: "duplicate_nonce",
          errorMessage: `this authorization is already submitted at this facilitator (transaction ${PENDING_TX})`,
          transaction: PENDING_TX,
          network: NETWORK,
          extra: { settlementStatus: "duplicate" },
        },
      });
      const { header } = await payInAsset(h, "paid_tool", LEGACY_TOKEN);
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.body.error?.code, -32003);
      const [receipt] = await receipts(h);
      assert.deepEqual([receipt?.status, receipt?.txHash], ["unknown", PENDING_TX]);
    });
  });

  it("keeps the pending transaction, as possibly the one that paid, when the on-chain check finds the authorization paid", async () => {
    const paid: SettlementPreemptionChecker = { check: async () => ({ kind: "paid", eventIndex: 7 }) };
    for (const accept of [true, false]) {
      await withTwoAssets({ config: { settlement: { acceptThirdPartySettlement: accept } }, gateway: { preemptionChecker: paid } }, async h => {
        pendingThen(h, refusal(429, "rate_limited", "too many requests; retry after the window resets"));
        const { header } = await payInAsset(h, "paid_tool", LEGACY_TOKEN);
        const res = await callPaid(h, "paid_tool", header);
        const [receipt] = await receipts(h);
        assert.equal(receipt?.txHash, PENDING_TX, `the receipt keeps the facilitator's transaction (acceptThirdPartySettlement ${accept})`);
        assert.match(
          String(receipt?.note),
          new RegExp(`event #7 shows this exact authorization paid payTo.*possibly through transaction ${PENDING_TX}, which this gateway's facilitator broadcast`),
        );
        assert.doesNotMatch(String(receipt?.note), /another submitter|other than this gateway's facilitator/);
        if (accept) {
          assert.equal(res.status, 200, JSON.stringify(res.body));
          assert.deepEqual([receipt?.status, receipt?.settledBy], ["settled", "third-party"]);
          assert.equal((res.body.result?._meta as { cascet: Record<string, unknown> }).cascet.txHash, PENDING_TX);
          assert.equal(res.headers.get("payment-response"), null, "never the failed settle's PAYMENT-RESPONSE with a delivered result");
        } else {
          assert.equal(res.body.error?.code, -32003);
          assert.equal(receipt?.status, "unknown");
        }
      });
    }
  });

  it("does not take the pending transaction for the one that paid once the retry reports it reverted", async () => {
    // On x402's retry the facilitator follows its pending transaction and finds it reverted: another transaction had
    // used the nonce. The on-chain check then finds this exact authorization paid.
    const paid: SettlementPreemptionChecker = { check: async () => ({ kind: "paid", eventIndex: 7 }) };
    const reverted: Reply = {
      json: {
        success: false,
        errorReason: "settlement_failed",
        errorMessage: "transaction execution failed: User error: 64001",
        transaction: PENDING_TX,
        network: NETWORK,
        extra: { settlementStatus: "failed", reconciled: true },
      },
    };
    for (const accept of [true, false]) {
      await withTwoAssets({ config: { settlement: { acceptThirdPartySettlement: accept } }, gateway: { preemptionChecker: paid } }, async h => {
        pendingThen(h, reverted);
        const { header } = await payInAsset(h, "paid_tool", LEGACY_TOKEN);
        const res = await callPaid(h, "paid_tool", header);
        assert.equal(h.legacy.count("settle"), 2, "x402 settled twice");
        const [receipt] = await receipts(h);
        assert.doesNotMatch(String(receipt?.note), /possibly through/, `acceptThirdPartySettlement ${accept}`);
        if (accept) {
          assert.equal(res.status, 200, JSON.stringify(res.body));
          assert.deepEqual([receipt?.status, receipt?.settledBy, receipt?.txHash], ["settled", "third-party", undefined]);
          assert.equal((res.body.result?._meta as { cascet: Record<string, unknown> }).cascet.txHash, undefined);
          assert.match(String(receipt?.note), new RegExp(`settled by another submitter; transaction ${PENDING_TX} of this gateway's facilitator reverted`));
        } else {
          assert.equal(res.body.error?.code, -32003);
          assert.equal(receipt?.status, "unknown");
          assert.match(String(receipt?.note), /paid payTo, executed by a submitter other than this gateway's facilitator;/);
        }
      });
    }
  });

  it("gives the retry only what is left of the facilitator's settle timeout, and keeps the hash when it does not answer", async () => {
    const config = (urls: { legacy: string }) => ({
      facilitators: { self: { url: urls.legacy, apiKey: "self-key", authScheme: "bearer", timeoutMs: 600 } },
    });
    await withTwoAssets({ config }, async h => {
      let settles = 0;
      h.legacy.onSettle = call => {
        settles++;
        if (settles > 1) return { hang: true };
        return {
          delayMs: 200,
          json: { success: false, errorReason: "settlement_pending", transaction: PENDING_TX, network: NETWORK, payer: call.body?.paymentPayload?.payload?.authorization?.from },
        };
      };
      const { header } = await payInAsset(h, "paid_tool", LEGACY_TOKEN);
      const started = Date.now();
      const res = await callPaid(h, "paid_tool", header);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 1_100, `the settle phase stayed within one 600 ms settle timeout plus the call (${elapsed} ms)`);
      assert.equal(res.body.error?.code, -32003);
      assert.equal(h.legacy.count("settle"), 2);
      const [receipt] = await receipts(h);
      assert.deepEqual([receipt?.status, receipt?.txHash], ["unknown", PENDING_TX]);
      assert.match(String(receipt?.note), /answered nothing within the 600 ms settle timeout/);
    });
  });
});

describe("x402 2.29 flow hooks", () => {
  it("tells x402 when verified work ends before settlement: a throwing tool, a tool that returns an error", async () => {
    const cancels = spyOnCancellations();
    const tools = [
      {
        name: "boom",
        handler: () => {
          throw new Error("upstream exploded");
        },
      },
      { name: "soft", handler: () => ({ isError: true, content: [{ type: "text" as const, text: "nope" }] }) },
      { name: "paid_tool" },
    ];
    const config = { pricing: { tools: { boom: { price: "$0.01" }, soft: { price: "$0.01" }, paid_tool: { price: "$0.01" } } } };
    try {
      await withTwoAssets({ config, tools }, async h => {
        const boom = await payInAsset(h, "boom", WCSPR_TOKEN);
        assert.match((await callPaid(h, "boom", boom.header)).body.error?.message ?? "", /not charged/);
        const soft = await payInAsset(h, "soft", LEGACY_TOKEN);
        assert.equal((await callPaid(h, "soft", soft.header)).body.result?.isError, true);
        const ok = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
        assert.equal((await callPaid(h, "paid_tool", ok.header)).status, 200);
        assert.deepEqual(cancels.reasons, ["handler_threw", "handler_failed"], "a settled call is never canceled");
        assert.deepEqual([h.legacy.count("settle"), h.cep.count("settle")], [0, 1]);
        assert.deepEqual(await receipts(h).then(list => list.map(receipt => receipt.tool)), ["paid_tool"]);
      });
    } finally {
      cancels.restore();
    }
  });

  it("cancels a verified payment whose authorization cannot be recorded (write-ahead failure), and runs nothing", async () => {
    const cancels = spyOnCancellations();
    try {
      await withTwoAssets({}, async h => {
        const { header } = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
        breakLog(h.receiptsPath);
        const res = await callPaid(h, "paid_tool", header);
        assert.equal(res.status, 503);
        assert.match(res.body.error?.message ?? "", /cannot record payments right now; the tool was not run and nothing was charged/);
        assert.deepEqual(cancels.reasons, ["after_verify_aborted"]);
        assert.deepEqual([h.cep.count("verify"), h.cep.count("settle")], [1, 0]);
        assert.equal(h.upstream.calls.length, 0);
      });
    } finally {
      cancels.restore();
    }
  });

  it("cancels a payment x402 verified without the gateway's local checks (no payment header it could read), and runs nothing", async () => {
    const cancels = spyOnCancellations();
    const original = x402HTTPResourceServer.prototype.processHTTPRequest;
    let smuggled: string | undefined;
    const patched = mock.method(
      x402HTTPResourceServer.prototype,
      "processHTTPRequest",
      async function (this: x402HTTPResourceServer, ...args: Parameters<typeof original>) {
        const [context, ...rest] = args;
        const header = smuggled;
        if (header === undefined) return original.apply(this, args);
        // x402 reads a payment the gateway never saw (as if their decoders disagreed).
        smuggled = undefined;
        const adapter = { ...context.adapter, getHeader: (name: string) => (/^payment-signature$/i.test(name) ? header : context.adapter.getHeader(name)) };
        return original.call(this, { ...context, adapter }, ...rest);
      },
    );
    try {
      await withTwoAssets({}, async h => {
        const { header } = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
        smuggled = header;
        const res = await h.rpc("tools/call", { name: "paid_tool", arguments: {} });
        assert.equal(res.status, 500);
        assert.match(res.body.error?.message ?? "", /payment could not be verified; the tool was not run and nothing was charged/);
        assert.deepEqual(cancels.reasons, ["after_verify_aborted"]);
        assert.deepEqual([h.cep.count("verify"), h.cep.count("settle")], [1, 0]);
        assert.equal(h.upstream.calls.length, 0);
      });
    } finally {
      patched.mock.restore();
      cancels.restore();
    }
  });

  it("answers the same when the cancellation dispatcher throws or rejects", async () => {
    let dispatchers = 0;
    const patched = mock.method(x402ResourceServer.prototype, "createPaymentCancellationDispatcher", () => {
      dispatchers++;
      const first = dispatchers === 1;
      return {
        cancel: (): Promise<void> => {
          if (first) throw new Error("cancel hook exploded");
          return Promise.reject(new Error("cancel hook rejected"));
        },
      };
    });
    const tools = [
      {
        name: "boom",
        handler: () => {
          throw new Error("upstream exploded");
        },
      },
      { name: "soft", handler: () => ({ isError: true, content: [{ type: "text" as const, text: "nope" }] }) },
    ];
    const config = { pricing: { tools: { boom: { price: "$0.01" }, soft: { price: "$0.01" } } } };
    try {
      await withTwoAssets({ config, tools }, async h => {
        const boom = await callPaid(h, "boom", (await payInAsset(h, "boom", WCSPR_TOKEN)).header);
        assert.equal(boom.status, 200);
        assert.match(boom.body.error?.message ?? "", /^upstream tool failed \(not charged\): .*upstream exploded/);
        const soft = await callPaid(h, "soft", (await payInAsset(h, "soft", LEGACY_TOKEN)).header);
        assert.equal(soft.status, 200);
        assert.deepEqual([soft.body.result?.isError, soft.body.result?.content?.[0]?.text], [true, "nope"]);
        assert.equal(dispatchers, 2, "both payments were verified and canceled");
        assert.deepEqual([h.legacy.count("settle"), h.cep.count("settle")], [0, 0]);
        assert.deepEqual(await receipts(h), []);
      });
    } finally {
      patched.mock.restore();
    }
  });

  it("cancels a verified payment the gateway refuses to run, and one whose upstream is gone before settlement", async () => {
    const cancels = spyOnCancellations();
    const original = x402HTTPResourceServer.prototype.processHTTPRequest;
    let tamper = true;
    const patched = mock.method(
      x402HTTPResourceServer.prototype,
      "processHTTPRequest",
      async function (this: x402HTTPResourceServer, ...args: Parameters<typeof original>) {
        const result = await original.apply(this, args);
        return tamper && result.type === "payment-verified"
          ? { ...result, paymentRequirements: { ...result.paymentRequirements, amount: "1" } }
          : result;
      },
    );
    const config = { pricing: { tools: { paid_tool: { price: "$0.01", settleBeforeExecute: true } } } };
    try {
      await withTwoAssets({ config, gateway: { reconnect: { maxAttempts: 50, baseDelayMs: 1_000, maxDelayMs: 1_000 } } }, async h => {
        const refused = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
        assert.match((await callPaid(h, "paid_tool", refused.header)).body.error?.message ?? "", /amount does not equal the configured price/);
        assert.deepEqual(cancels.reasons, ["after_verify_aborted"]);

        tamper = false;
        const { header } = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
        h.cep.onVerify = async call => {
          h.upstream.failConnections = true;
          await h.upstream.crash();
          return { json: { isValid: true, payer: call.body?.paymentPayload?.payload?.authorization?.from } };
        };
        const res = await callPaid(h, "paid_tool", header);
        assert.equal(res.status, 503);
        assert.deepEqual(cancels.reasons, ["after_verify_aborted", "handler_failed"]);
        assert.equal(h.cep.count("settle"), 0);
      });
    } finally {
      patched.mock.restore();
      cancels.restore();
    }
  });

  it("fails closed when the facilitators ask for x402's upfront flow: it does not start, naming each facilitator, its asset and the flow; nothing is verified, settled or run", async () => {
    // @x402/casper copies a facilitator's extension values into the requirements; "upfront" would
    // make x402 skip verify and settle before the gateway's checks. The CasCet scheme refuses it, and
    // x402 would refuse every paid call with a generic error, so the gateway refuses to start instead.
    const askForUpfront = (facilitator: FakeFacilitator) => {
      facilitator.onSupported = () => ({
        json: { kinds: [{ x402Version: 2, scheme: "exact", network: "casper:casper-test", extra: { paymentFlow: "upfront" } }], extensions: ["paymentFlow"], signers: {} },
      });
    };
    const legacy = await startFakeFacilitator({ label: "legacy" });
    const cep = await startFakeFacilitator({ label: "cep" });
    askForUpfront(legacy);
    askForUpfront(cep);
    const upstream = createFakeUpstream({ tools: [{ name: "paid_tool" }] });
    const refused = (facilitator: string, url: string, asset: string, hash: string) =>
      `facilitator "${facilitator}" (${url}) advertises payment flow "upfront" for x402 v2 "exact" payments on casper:casper-test, ` +
      `which asset "${asset}" (${hash}) needs: CasCet supports only the "authorization" flow (verify before the tool runs, ` +
      `settle after the gateway's own checks), so x402 would refuse every paid call in that asset`;
    try {
      await assert.rejects(
        startGateway(twoAssetConfig(legacy.url, cep.url), { createUpstreamTransport: () => upstream.createTransport(), preemptionChecker: null }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(err.message, `${refused("self", legacy.url, "cascet", LEGACY_TOKEN)}; ${refused("default", cep.url, "wcspr", WCSPR_TOKEN)}`);
          return true;
        },
      );
      assert.deepEqual([...legacy.calls, ...cep.calls].map(call => call.op), ["supported", "supported"], "only asked for /supported");
      assert.equal(upstream.connections, 0, "the upstream is not started either");
    } finally {
      await legacy.close();
      await cep.close();
    }
  });

  it("never settles twice: a before-handler settlement x402 hands over is passed back, and x402 echoes it", async () => {
    const UPFRONT_TX = "77".repeat(32);
    const original = x402HTTPResourceServer.prototype.processHTTPRequest;
    const patched = mock.method(
      x402HTTPResourceServer.prototype,
      "processHTTPRequest",
      async function (this: x402HTTPResourceServer, ...args: Parameters<typeof original>) {
        const result = await original.apply(this, args);
        if (result.type !== "payment-verified") return result;
        // CASCET_PAYMENT_FLOWS accepts no flow that settles before the handler, so x402 never does this
        // for a CasCet route; if it did, the gateway must not settle the payment a second time.
        return {
          ...result,
          beforeHandlerSettlement: {
            phase: "before-handler" as const,
            flow: "upfront" as const,
            result: { success: true, transaction: UPFRONT_TX, network: result.paymentRequirements.network, payer: PAYER },
            requirements: result.paymentRequirements,
          },
        };
      },
    );
    try {
      await withTwoAssets({}, async h => {
        const { header } = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
        const res = await callPaid(h, "paid_tool", header);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(h.cep.count("settle"), 0, "no second settlement");
        const [receipt] = await receipts(h);
        assert.deepEqual([receipt?.status, receipt?.txHash, receipt?.asset], ["settled", UPFRONT_TX, WCSPR_TOKEN]);
      });
    } finally {
      patched.mock.restore();
    }
  });
});

describe("pricing and discovery documents list every token", () => {
  it("shows each tool's tokens and amounts from its own accepts", async () => {
    const config = {
      pricing: { tools: { paid_tool: { price: "$0.01" }, wcspr_tool: { price: "$0.01", assets: ["wcspr"] } }, freeTools: ["free_tool"] },
    };
    await withTwoAssets({ config, tools: [{ name: "paid_tool" }, { name: "wcspr_tool" }, { name: "free_tool" }] }, async h => {
      const pricing = (await (await fetch(`${h.base}/pricing`)).json()) as {
        asset: { symbol: string; packageHash: string };
        assets: Array<{ id: string; packageHash: string; authorizationStyle: string }>;
        tools: Array<{ name: string; amountRaw?: string; asset?: string; accepts?: Array<{ asset: string; amountRaw: string; authorizationStyle: string }> }>;
      };
      assert.deepEqual(pricing.asset, { symbol: "CASCET", packageHash: LEGACY_TOKEN }, "the preferred token, as before");
      assert.deepEqual(
        pricing.assets.map(asset => [asset.id, asset.packageHash, asset.authorizationStyle]),
        [
          ["cascet", LEGACY_TOKEN, "legacy-amount"],
          ["wcspr", WCSPR_TOKEN, "cep3009-value"],
        ],
      );
      const byName = new Map(pricing.tools.map(tool => [tool.name, tool]));
      assert.deepEqual(
        byName.get("paid_tool")?.accepts?.map(entry => [entry.asset, entry.amountRaw, entry.authorizationStyle]),
        [
          ["cascet", LEGACY_PRICE_RAW, "legacy-amount"],
          ["wcspr", WCSPR_PRICE_RAW, "cep3009-value"],
        ],
      );
      // amountRaw is in the preferred token (the top-level asset), as before; a tool that does not
      // accept that token has none, and its WCSPR amount is only in accepts.
      assert.deepEqual([byName.get("paid_tool")?.amountRaw, byName.get("paid_tool")?.asset], [LEGACY_PRICE_RAW, "cascet"]);
      assert.deepEqual([byName.get("wcspr_tool")?.amountRaw, byName.get("wcspr_tool")?.asset], [undefined, undefined]);
      assert.deepEqual(
        byName.get("wcspr_tool")?.accepts?.map(entry => [entry.asset, entry.amountRaw]),
        [["wcspr", WCSPR_PRICE_RAW]],
      );
      assert.deepEqual(byName.get("free_tool"), { name: "free_tool" });

      const discovery = (await (await fetch(`${h.base}/.well-known/x402.json`)).json()) as {
        items: Array<{ metadata: { tool: string }; accepts: Array<{ asset: string; amount: string; payTo: string; extra: Record<string, string> }> }>;
      };
      const items = new Map(discovery.items.map(item => [item.metadata.tool, item.accepts]));
      assert.deepEqual(
        items.get("paid_tool")?.map(entry => [entry.asset, entry.amount, entry.extra.authorizationStyle, entry.payTo]),
        [
          [LEGACY_TOKEN, LEGACY_PRICE_RAW, "legacy-amount", PAY_TO],
          [WCSPR_TOKEN, WCSPR_PRICE_RAW, "cep3009-value", PAY_TO],
        ],
      );
      assert.deepEqual(
        items.get("wcspr_tool")?.map(entry => entry.asset),
        [WCSPR_TOKEN],
      );
    });
  });
});

/** What the in-memory hosted facilitator answers instead of its default (undefined keeps the default). */
type HostedReply = { status?: number; json?: unknown; raw?: string } | undefined;

/** Scripted parts of a hosted gateway: its upstream's tools, and the hosted facilitator's answers by path. */
interface HostedScript {
  tools?: FakeTool[];
  answer?: (path: string, body: HostedBody | undefined) => HostedReply | Promise<HostedReply>;
}

describe("the hosted facilitator", () => {
  /**
   * A gateway whose Wrapped CSPR is settled by the hosted facilitator (played in
   * memory: nothing reaches the real host) and whose legacy token is settled by
   * a local fake facilitator.
   */
  async function hostedGateway(input: Record<string, unknown> = {}, script: HostedScript = {}, gatewayOptions: Pick<GatewayOptions, "preemptionChecker"> = {}) {
    const hosted: Array<{ path: string; authorization: string | null; body?: HostedBody }> = [];
    const facilitatorFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== DEFAULT_FACILITATOR_URL) return fetch(input, init);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as HostedBody) : undefined;
      hosted.push({ path: url.pathname, authorization: new Headers(init?.headers).get("authorization"), body });
      const reply = await script.answer?.(url.pathname, body);
      if (reply) {
        return new Response(reply.raw ?? JSON.stringify(reply.json), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
      }
      const json =
        url.pathname === "/supported"
          ? {
              kinds: [{ x402Version: 2, scheme: "exact", network: "casper:casper-test", extra: { feePayer: "81".repeat(32) } }],
              extensions: [],
              signers: { "casper:*": ["81".repeat(32)] },
            }
          : url.pathname === "/verify"
            ? { isValid: true, payer: body?.paymentPayload?.payload?.authorization?.from }
            : { success: true, transaction: WCSPR_SETTLE_TX, network: "casper:casper-test", payer: body?.paymentPayload?.payload?.authorization?.from };
      return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const legacy = await startFakeFacilitator({ label: "legacy", settleTx: LEGACY_SETTLE_TX });
    const upstream = createFakeUpstream({ tools: script.tools ?? [{ name: "paid_tool" }] });
    const dir = mkdtempSync(join(tmpdir(), "cascet-gateway-test-"));
    const cfg = twoAssetConfig(legacy.url, DEFAULT_FACILITATOR_URL, {
      facilitator: { url: DEFAULT_FACILITATOR_URL, apiKey: "cspr-cloud-key" },
      ...input,
    });
    let gateway;
    try {
      gateway = await startGateway(cfg, {
        createUpstreamTransport: () => upstream.createTransport(),
        receiptsPath: join(dir, "receipts.jsonl"),
        preemptionChecker: null,
        facilitatorFetch,
        ...gatewayOptions,
      });
    } catch (err) {
      await legacy.close();
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    const url = gateway.url;
    return {
      hosted,
      legacy,
      upstream,
      h: {
        rpc: (method: string, params?: Record<string, unknown>, headers?: Record<string, string>) => rpcCall(url, method, params, headers),
        base: url.replace(/\/mcp$/, ""),
      },
      close: async () => {
        await gateway.close();
        await legacy.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it("gets the raw access key and requirements without CasCet's authorizationStyle, which buyers still see", async () => {
    const { hosted, legacy, h, close } = await hostedGateway();
    try {
      const { header, accepted } = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
      assert.equal(accepted.extra?.authorizationStyle, "cep3009-value", "the 402 still tells buyers the style");
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(
        hosted.map(call => [call.path, call.authorization]),
        [
          ["/supported", "cspr-cloud-key"],
          ["/verify", "cspr-cloud-key"],
          ["/settle", "cspr-cloud-key"],
        ],
      );
      for (const call of hosted.slice(1)) {
        const expected = { name: "Wrapped CSPR", version: "1", symbol: "WCSPR", decimals: "9" };
        assert.deepEqual(call.body?.paymentRequirements?.extra, expected);
        assert.deepEqual(call.body?.paymentPayload?.accepted?.extra, expected);
        assert.equal(call.body?.paymentRequirements?.asset, WCSPR_TOKEN);
      }
      // The self-hosted facilitator of the legacy token keeps receiving the full requirements.
      const legacyPayment = await payInAsset(h, "paid_tool", LEGACY_TOKEN);
      assert.equal((await callPaid(h, "paid_tool", legacyPayment.header)).status, 200);
      const verify = legacy.calls.find(call => call.op === "verify");
      assert.equal((verify?.body?.paymentRequirements?.extra as Record<string, unknown> | undefined)?.authorizationStyle, "legacy-amount");
      assert.equal(hosted.length, 3, "the legacy payment never reached the hosted facilitator");
    } finally {
      await close();
    }
  });

  it("gets no payment the token state refuses, when a node is configured: a spent nonce, a short balance, an unreadable node", async () => {
    const spent = "5a".repeat(32);
    const routes = wcsprNodeRoutes({ usedNonces: [{ payer: PAYER, nonce: spent }] });
    let balance = BigInt(WCSPR_PRICE_RAW);
    routes[wcsprBalanceCall(PAYER)] = () => u256Response(balance);
    const node = await startFakeNode(routes);
    const { hosted, legacy, h, close } = await hostedGateway({ settlement: { nodeUrl: node.url } });
    const askedToWork = () => hosted.filter(call => call.path !== "/supported").map(call => call.path);
    const refusedWith = async (header: string, reason: string) => {
      const res = await callPaid(h, "paid_tool", header);
      assert.equal(res.status, 402);
      assert.equal(res.body.error?.code, -32002);
      assert.equal(res.body.error?.message, `payment rejected: ${reason}`);
      assert.equal(challengeOf(res).error, reason);
    };
    try {
      // The hosted facilitator's own nonce check would let this one through, and its settle would revert.
      await refusedWith((await payInAsset(h, "paid_tool", WCSPR_TOKEN, { nonce: spent })).header, "nonce_already_used");
      balance -= 1n;
      const later = await payInAsset(h, "paid_tool", WCSPR_TOKEN);
      await refusedWith(later.header, "insufficient_funds");
      balance += 1n;
      node.down = true;
      await refusedWith(later.header, "preflight_unavailable");
      assert.deepEqual(askedToWork(), [], "the hosted facilitator was never asked to verify or settle");

      // The node is back: the same authorization (released after each refusal) goes through.
      node.down = false;
      const res = await callPaid(h, "paid_tool", later.header);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(askedToWork(), ["/verify", "/settle"]);
      assert.ok(node.calls.includes(wcsprNonceCall(PAYER, later.nonce)));

      // A payment in the legacy token goes to its self-hosted facilitator, which preflights it itself.
      const read = node.calls.length;
      assert.equal((await callPaid(h, "paid_tool", (await payInAsset(h, "paid_tool", LEGACY_TOKEN)).header)).status, 200);
      assert.equal(node.calls.length, read, "the gateway read no token state for it");
      assert.equal(legacy.count("settle"), 1);
    } finally {
      await close();
      await node.close();
    }
  });

  it("is refused at startup for a legacy-amount token, before anyone is contacted", async () => {
    const valid = twoAssetConfig("http://127.0.0.1:4501", "http://127.0.0.1:4502");
    const cfg = { ...valid, facilitators: { ...valid.facilitators, self: { url: `${DEFAULT_FACILITATOR_URL}/`, apiKey: "k", authScheme: "raw" as const } } } as CascetConfig;
    const contacted: string[] = [];
    const upstream = createFakeUpstream({ tools: [{ name: "paid_tool" }] });
    await assert.rejects(
      startGateway(cfg, {
        createUpstreamTransport: () => upstream.createTransport(),
        preemptionChecker: null,
        facilitatorFetch: (async (input: string | URL | Request) => {
          contacted.push(String(input));
          throw new Error("unexpected");
        }) as typeof fetch,
      }),
      /asset "cascet" is a legacy-amount token, but its facilitator "self" is the hosted one/,
    );
    assert.deepEqual(contacted, []);
    assert.equal(upstream.connections, 0, "the upstream is not started either");
  });

  describe("counts the payments in flight of a payer whose balance funds one payment", () => {
    const IN_FLIGHT_REASON = "insufficient_funds: insufficient balance once 1 in-flight payment is counted";
    const ok = (): CallToolResult => ({ content: [{ type: "text", text: "ok" }] });
    const refusedInFlight = (res: RpcResponse) => assert.deepEqual([res.status, res.body.error?.message], [402, `payment rejected: ${IN_FLIGHT_REASON}`]);
    const expired = { json: { success: false, errorReason: "invalid_exact_casper_facilitator_expired", transaction: "", network: "casper:casper-test" } };
    const settleFirst = { pricing: { tools: { paid_tool: { price: "$0.01", settleBeforeExecute: true } } } };

    /**
     * A hosted gateway that preflights Wrapped CSPR payments on a node where the payer's
     * balance funds exactly one payment. `pay()` presents a new payment of that payer. The
     * script gets `whileInFlight`: called at some stage of the first payment's call, it
     * presents one more payment of the payer right then (once) and keeps its answer in `during`.
     * `setBalance()` changes the balance the node reports.
     */
    async function fundsOne(
      script: (whileInFlight: () => Promise<void>) => HostedScript = () => ({}),
      input: Record<string, unknown> = {},
      gatewayOptions: Pick<GatewayOptions, "preemptionChecker"> = {},
    ) {
      const routes = wcsprNodeRoutes({ balances: { [PAYER]: BigInt(WCSPR_PRICE_RAW) } });
      const node = await startFakeNode(routes);
      const during: RpcResponse[] = [];
      let pay: (() => Promise<RpcResponse>) | undefined;
      let presented = false;
      const whileInFlight = async (): Promise<void> => {
        if (presented || !pay) return;
        presented = true;
        during.push(await pay());
      };
      let gateway: Awaited<ReturnType<typeof hostedGateway>>;
      try {
        gateway = await hostedGateway({ settlement: { nodeUrl: node.url }, ...input }, script(whileInFlight), gatewayOptions);
      } catch (err) {
        await node.close();
        throw err;
      }
      const close = async () => {
        await gateway.close();
        await node.close();
      };
      try {
        const { accepted } = await payInAsset(gateway.h, "paid_tool", WCSPR_TOKEN);
        pay = () => callPaid(gateway.h, "paid_tool", paymentHeader(accepted).header);
        /** The payer's balance as the node reports it from now on (a settled payment spent it, say). */
        const setBalance = (value: bigint): void => {
          routes[wcsprBalanceCall(PAYER)] = u256Response(value);
        };
        return { ...gateway, during, pay, close, setBalance };
      } catch (err) {
        await close();
        throw err;
      }
    }

    type FundsOne = Awaited<ReturnType<typeof fundsOne>>;

    /** A script answer that runs `first` on the first call to `path` and keeps the default otherwise. */
    const onFirst = (path: string, first: () => Promise<HostedReply>): HostedScript["answer"] => {
      let calls = 0;
      return at => (at === path && ++calls === 1 ? first() : undefined);
    };
    /** paid_tool, whose first run is `first`; every later run answers "ok". */
    const toolFirst = (first: () => Promise<CallToolResult>): FakeTool[] => {
      let runs = 0;
      return [{ name: "paid_tool", handler: () => (++runs === 1 ? first() : ok()) }];
    };

    it("lets exactly one of two concurrent payments through, and refuses the other naming the payment in flight", async () => {
      // Neither payment counts before the hosted facilitator verified it, so both pass the checks before verify;
      // both wait at /verify until both are there (2 s at most). Once verified, exactly one is reserved: without
      // in-flight counting both would run and the test would fail, not hang.
      let arrived = 0;
      let open = (): void => {};
      const gate = new Promise<void>(resolve => {
        open = resolve;
        setTimeout(resolve, 2_000).unref();
      });
      const g = await fundsOne(() => ({
        answer: async path => {
          if (path !== "/verify") return undefined;
          if (++arrived === 2) open();
          return gate.then(() => undefined);
        },
      }));
      try {
        const results = await Promise.all([g.pay(), g.pay()]);
        assert.deepEqual(results.map(res => res.status).sort(), [200, 402]);
        const refused = results.find(res => res.status === 402);
        assert.ok(refused);
        refusedInFlight(refused);
        assert.equal(challengeOf(refused).error, IN_FLIGHT_REASON, "the 402 challenge names it too");
        assert.deepEqual(
          g.hosted.filter(call => call.path !== "/supported").map(call => call.path),
          ["/verify", "/verify", "/settle"],
          "both were verified, only one settled",
        );
        assert.equal(g.upstream.calls.length, 1, "and only one tool ran");
        assert.deepEqual((await receipts(g.h)).map(receipt => receipt.status), ["settled"]);
      } finally {
        await g.close();
      }
    });

    it("refuses a payment whose funds another payment of the payer spent while it was being verified", async () => {
      // Payment A waits at /verify until B, presented meanwhile, passed its checks before verify (nothing was in flight)
      // and waits at /verify too. B waits there until A's call ended: A was verified, reserved, ran and settled (the
      // node shows its debit from then on), and is no longer in flight. The balance B was checked on is spent.
      let a: Promise<RpcResponse> | undefined;
      let b: Promise<RpcResponse> | undefined;
      let bAtVerify = (): void => {};
      const bWaits = new Promise<void>(resolve => (bAtVerify = resolve));
      let verifies = 0;
      const g: FundsOne = await fundsOne(() => ({
        answer: async path => {
          if (path === "/verify" && ++verifies === 1) {
            b = g.pay();
            await Promise.race([bWaits, b]);
          } else if (path === "/verify") {
            bAtVerify();
            await a;
          } else if (path === "/settle") {
            g.setBalance(0n);
          }
          return undefined;
        },
      }));
      try {
        a = g.pay();
        const first = await a;
        assert.deepEqual([first.status, first.body.result?.content?.[0]?.text], [200, "ok:paid_tool"]);
        const second = await b;
        assert.deepEqual([second?.status, second?.body.error?.message], [402, "payment rejected: insufficient_funds"]);
        assert.deepEqual(
          g.hosted.filter(call => call.path !== "/supported").map(call => call.path),
          ["/verify", "/verify", "/settle"],
          "both were verified, only the first settled",
        );
        assert.equal(g.upstream.calls.length, 1, "and only its tool ran");
      } finally {
        await g.close();
      }
    });

    it("never counts a payment the hosted facilitator does not verify (a forged signature, a failed /verify): the payer's other payments pass meanwhile", async () => {
      const refusals: Array<[HostedReply, string]> = [
        [{ json: { isValid: false, invalidReason: "invalid_exact_casper_payload_signature" } }, "payment rejected: invalid_exact_casper_payload_signature"],
        [{ status: 500, raw: "verify exploded" }, "payment rejected: facilitator verify failed with HTTP 500: verify exploded"],
      ];
      for (const [reply, message] of refusals) {
        const g = await fundsOne(whileInFlight => ({
          answer: onFirst("/verify", async () => {
            await whileInFlight();
            return reply;
          }),
        }));
        try {
          const first = await g.pay();
          assert.deepEqual([first.status, first.body.error?.message], [402, message]);
          assert.equal(g.during.length, 1, "a payment was presented while the first one waited at /verify");
          assert.equal(g.during[0]!.status, 200, `the unverified payment held nothing back: ${JSON.stringify(g.during[0]!.body)}`);
          assert.equal((await g.pay()).status, 200);
        } finally {
          await g.close();
        }
      }
    });

    const endings: Array<{
      name: string;
      input?: Record<string, unknown>;
      script: (whileInFlight: () => Promise<void>) => HostedScript;
      /** How the first payment's call ends. */
      first: (res: RpcResponse) => void;
      /** What the payment presented during that call gets: refused as in flight unless said otherwise. */
      during?: (res: RpcResponse) => void;
    }> = [
      {
        name: "its tool throws (not charged)",
        script: whileInFlight => ({
          tools: toolFirst(async () => {
            await whileInFlight();
            throw new Error("upstream exploded");
          }),
        }),
        first: res => assert.match(res.body.error?.message ?? "", /^upstream tool failed \(not charged\): .*upstream exploded/),
      },
      {
        name: "its tool returns an error (not charged)",
        script: whileInFlight => ({
          tools: toolFirst(async () => {
            await whileInFlight();
            return { isError: true, content: [{ type: "text", text: "nope" }] };
          }),
        }),
        first: res => assert.deepEqual([res.status, res.body.result?.isError], [200, true]),
      },
      {
        name: "its tool times out (not charged)",
        input: { timeouts: { upstreamMs: 1_000 } },
        script: whileInFlight => ({
          tools: toolFirst(async () => {
            await whileInFlight();
            return new Promise<CallToolResult>(() => {});
          }),
        }),
        first: res => assert.equal(res.body.error?.message, "upstream tool timed out (not charged)"),
      },
      {
        name: "it settled",
        script: whileInFlight => ({ answer: onFirst("/settle", async () => (await whileInFlight(), undefined)) }),
        first: res => assert.deepEqual([res.status, res.body.result?.content?.[0]?.text], [200, "ok:paid_tool"]),
      },
      {
        name: "its settlement failed",
        script: whileInFlight => ({ answer: onFirst("/settle", async () => (await whileInFlight(), expired)) }),
        first: res => assert.deepEqual([res.status, res.body.error?.message], [402, "payment settlement failed: invalid_exact_casper_facilitator_expired"]),
      },
      {
        name: "its settlement failed before its tool would run (settleBeforeExecute)",
        input: settleFirst,
        script: whileInFlight => ({ answer: onFirst("/settle", async () => (await whileInFlight(), expired)) }),
        first: res => assert.deepEqual([res.status, res.body.error?.message], [402, "payment settlement failed: invalid_exact_casper_facilitator_expired"]),
      },
      {
        name: "it settled before its tool runs (settleBeforeExecute), already while the tool runs",
        input: settleFirst,
        script: whileInFlight => ({
          tools: toolFirst(async () => {
            await whileInFlight();
            return ok();
          }),
        }),
        first: res => assert.deepEqual([res.status, res.body.result?.content?.[0]?.text], [200, "ok"]),
        during: res => assert.equal(res.status, 200, `settled, so no longer in flight: ${JSON.stringify(res.body)}`),
      },
    ];

    for (const ending of endings) {
      it(`releases the payment when ${ending.name}`, async () => {
        const g = await fundsOne(ending.script, ending.input);
        try {
          ending.first(await g.pay());
          assert.equal(g.during.length, 1, "a payment was presented while the first one was in flight");
          (ending.during ?? refusedInFlight)(g.during[0]!);
          const next = await g.pay();
          assert.equal(next.status, 200, `the next payment passes once the call ended: ${JSON.stringify(next.body)}`);
        } finally {
          await g.close();
        }
      });
    }

    it("keeps counting a payment whose settlement outcome is unknown, until its authorization expires: its transfer may still execute", async () => {
      const unknown = { status: 502, raw: "<html>Bad Gateway</html>" };
      const g = await fundsOne(whileInFlight => ({ answer: onFirst("/settle", async () => (await whileInFlight(), unknown)) }));
      try {
        const first = await g.pay();
        assert.deepEqual([first.status, first.body.error?.code], [200, -32003]);
        refusedInFlight(g.during[0]!);
        // Its call ended, but the balance, which funds one payment, is still committed to its transfer.
        refusedInFlight(await g.pay());
        assert.equal(g.upstream.calls.length, 1, "no tool ran for a payment that balance cannot fund");
      } finally {
        await g.close();
      }
    });

    it("stops counting a payment whose outcome is unknown once the token's events show its nonce used", async () => {
      // The on-chain check finds this authorization executed (third-party settlement is off, so the outcome stays
      // unknown), or its nonce used without the expected transfer (layout-dependent evidence: the outcome stays
      // unknown too). Either way the authorization cannot execute again: whatever it moved is in the balance the
      // node reports (which is fixed in this test) from now on, not in flight.
      const unknown = { status: 502, raw: "<html>Bad Gateway</html>" };
      const findings: Array<[PreemptionOutcome, RegExp]> = [
        [{ kind: "paid", eventIndex: 3 }, /token event #3 shows this exact authorization paid payTo/],
        [
          { kind: "consumed-elsewhere", eventIndex: 4, detail: "no transfer event follows the authorization" },
          /nonce was used on-chain without the expected transfer to payTo right after it \(token event #4/,
        ],
      ];
      for (const [finding, note] of findings) {
        const checker: SettlementPreemptionChecker = { check: async () => finding };
        const g = await fundsOne(() => ({ answer: onFirst("/settle", async () => unknown) }), {}, { preemptionChecker: checker });
        try {
          const first = await g.pay();
          assert.deepEqual([first.status, first.body.error?.code], [200, -32003], finding.kind);
          assert.match(String(first.body.error?.data?.note), note);
          const next = await g.pay();
          assert.equal(next.status, 200, `${finding.kind}: ${JSON.stringify(next.body)}`);
        } finally {
          await g.close();
        }
      }
    });

    it("keeps counting a payment whose outcome is unknown when the on-chain check finds nothing about it, or fails", async () => {
      const unknown = { status: 502, raw: "<html>Bad Gateway</html>" };
      const checks: Array<[string, SettlementPreemptionChecker]> = [
        ["nothing found", { check: async () => ({ kind: "not-found", scanned: 64 }) }],
        ["the check failed", { check: () => Promise.reject(new Error("node unreachable")) }],
      ];
      for (const [name, checker] of checks) {
        const g = await fundsOne(() => ({ answer: onFirst("/settle", async () => unknown) }), {}, { preemptionChecker: checker });
        try {
          const first = await g.pay();
          assert.deepEqual([first.status, first.body.error?.code], [200, -32003], name);
          refusedInFlight(await g.pay());
          assert.equal(g.upstream.calls.length, 1, `${name}: no tool ran for a payment that balance cannot fund`);
        } finally {
          await g.close();
        }
      }
    });

    it("releases the payment when the gateway refuses it after verification, or x402 throws after the preflight", async () => {
      const original = x402HTTPResourceServer.prototype.processHTTPRequest;
      let whileInFlight = async (): Promise<void> => {};
      let next: "tamper" | "throw" | undefined;
      const patched = mock.method(
        x402HTTPResourceServer.prototype,
        "processHTTPRequest",
        async function (this: x402HTTPResourceServer, ...args: Parameters<typeof original>) {
          const result = await original.apply(this, args);
          const step = next;
          if (step === undefined || result.type !== "payment-verified") return result;
          next = undefined;
          // The preflight let this payment through: it is in flight now.
          await whileInFlight();
          if (step === "throw") throw new Error("x402 failed after the preflight");
          return { ...result, paymentRequirements: { ...result.paymentRequirements, amount: "1" } };
        },
      );
      try {
        for (const [step, status, message] of [
          ["tamper", 402, "payment rejected: verified payment amount does not equal the configured price"],
          ["throw", 502, "payment verification failed: the facilitator gave an unusable answer; nothing was charged"],
        ] as const) {
          next = step;
          const g = await fundsOne(probe => {
            whileInFlight = probe;
            return {};
          });
          try {
            const first = await g.pay();
            assert.deepEqual([first.status, first.body.error?.message], [status, message]);
            assert.equal(g.during.length, 1, step);
            refusedInFlight(g.during[0]!);
            assert.equal((await g.pay()).status, 200, step);
          } finally {
            await g.close();
          }
        }
      } finally {
        patched.mock.restore();
      }
    });

    it("releases the payment when its authorization cannot be recorded (write-ahead failure)", async () => {
      const original = x402HTTPResourceServer.prototype.processHTTPRequest;
      const append = ReceiptStore.prototype.appendAuthorization;
      let whileInFlight = async (): Promise<void> => {};
      let verifiedOnce = false;
      let fail = false;
      const verified = mock.method(
        x402HTTPResourceServer.prototype,
        "processHTTPRequest",
        async function (this: x402HTTPResourceServer, ...args: Parameters<typeof original>) {
          const result = await original.apply(this, args);
          if (verifiedOnce || result.type !== "payment-verified") return result;
          verifiedOnce = true;
          // Verified, so reserved: present one more payment now, then fail this one's write-ahead record.
          await whileInFlight();
          fail = true;
          return result;
        },
      );
      const recorded = mock.method(ReceiptStore.prototype, "appendAuthorization", function (this: ReceiptStore, ...args: Parameters<typeof append>) {
        if (!fail) return append.apply(this, args);
        fail = false;
        throw new Error("disk full");
      });
      try {
        const g = await fundsOne(probe => {
          whileInFlight = probe;
          return {};
        });
        try {
          const first = await g.pay();
          assert.deepEqual(
            [first.status, first.body.error?.message],
            [503, "gateway cannot record payments right now; the tool was not run and nothing was charged"],
          );
          assert.equal(g.during.length, 1);
          refusedInFlight(g.during[0]!);
          assert.equal((await g.pay()).status, 200);
        } finally {
          await g.close();
        }
      } finally {
        verified.mock.restore();
        recorded.mock.restore();
      }
    });
  });
});

describe("@x402 2.29 buyers and a two-token 402", () => {
  it("a buyer whose policy prefers Wrapped CSPR pays in it, and only its facilitator settles", async () => {
    await withTwoAssets({}, async h => {
      const key = casperSdk.PrivateKey.generate(casperSdk.KeyAlgorithm.ED25519);
      const signer = {
        accountAddress: () => `00${key.publicKey.accountHash().toHex()}`,
        publicKey: () => key.publicKey.toHex(),
        signEIP712: async (digest: Uint8Array) => key.signAndAddAlgorithmBytes(digest),
      };
      const client = new x402Client()
        .register("casper:casper-test", new ExactCasperScheme(signer))
        .setSpendControls({ allowedAssets: true, maxAmountPerPayment: false })
        .registerPolicy((_version, requirements) => requirements.filter(entry => entry.extra?.authorizationStyle === "cep3009-value"));
      const paymentRequired = challengeOf(await h.rpc("tools/call", { name: "paid_tool", arguments: {} }));
      const payment = await client.createPaymentPayload(paymentRequired);
      assert.equal(payment.accepted.asset, WCSPR_TOKEN);
      const res = await callPaid(h, "paid_tool", encodePaymentSignatureHeader(payment));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(work(h.cep.calls), [`verify ${WCSPR_TOKEN}`, `settle ${WCSPR_TOKEN}`]);
      assert.deepEqual(work(h.legacy.calls), []);
      assert.equal((await receipts(h))[0]?.payer, signer.accountAddress());
    });
  });
});
