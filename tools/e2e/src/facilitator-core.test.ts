import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { VerifyResponse } from "@x402/core/types";
import { AuthorizationLedger } from "./authorization-ledger.js";
import {
  createFacilitatorCore,
  normalizeAsset,
  normalizePayTo,
  parsePaymentRequest,
  Reason,
  type FacilitatorCoreConfig,
  type ParsedPayment,
} from "./facilitator-core.js";
import { DailyGasBudget } from "./gas-budget.js";
import type { ExecutionOutcome, SettlementChain, SubmitOutcome } from "./settlement.js";
import { TokenStateError } from "./token-state.js";
import { FakeClock } from "./test-helpers.js";

const NETWORK = "casper:casper-test" as const;
const ASSET = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
const SELLER = `00${"88".repeat(32)}`;
const PAYER = `00${"65".repeat(32)}`;
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const CSPR = 1_000_000_000n;

function body(over: { nonce?: string; value?: string; from?: string; payTo?: string; asset?: string; validBefore?: number; publicKey?: string; signature?: string; extra?: Record<string, unknown> } = {}) {
  const now = Math.floor(T0 / 1000);
  const payTo = over.payTo ?? SELLER;
  const value = over.value ?? "500000000";
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: { scheme: "exact", network: NETWORK },
      payload: {
        signature: over.signature ?? `01${"ab".repeat(64)}`,
        publicKey: over.publicKey ?? `01${"cd".repeat(32)}`,
        authorization: {
          from: over.from ?? PAYER,
          to: payTo,
          value,
          validAfter: String(now - 600),
          validBefore: String(over.validBefore ?? now + 300),
          nonce: over.nonce ?? "9c".repeat(32),
        },
      },
    },
    paymentRequirements: {
      scheme: "exact",
      network: NETWORK,
      asset: over.asset ?? ASSET,
      amount: value,
      payTo,
      maxTimeoutSeconds: 300,
      extra: over.extra ?? { name: "CasCet X402 Token", version: "1", symbol: "WCSPR", decimals: "9" },
    },
  };
}

function parsed(over: Parameters<typeof body>[0] = {}): ParsedPayment {
  const p = parsePaymentRequest(body(over), NETWORK);
  assert.ok(p.ok, "fixture must parse");
  return p.value;
}

interface Harness {
  core: ReturnType<typeof createFacilitatorCore>;
  clock: FakeClock;
  ledger: AuthorizationLedger;
  gas: DailyGasBudget;
  chain: SettlementChain & { submits: number; builds: number; ttls: number[] };
  signatureChecks: { count: number };
  /** `readDelayMs`: how far each nonce read moves the clock (a slow node). */
  state: { balance: bigint; used: Set<string>; name: string; fail?: boolean; readDelayMs: number; deadlines: Array<number | undefined> };
  logs: string[];
}

function harness(opts: {
  config?: Partial<FacilitatorCoreConfig>;
  submit?: () => SubmitOutcome | Promise<SubmitOutcome>;
  outcome?: () => ExecutionOutcome | Promise<ExecutionOutcome>;
  verifySignature?: () => VerifyResponse;
  preflight?: boolean;
} = {}): Harness {
  const clock = new FakeClock(T0);
  const ledger = new AuthorizationLedger({ now: clock.now });
  const gas = new DailyGasBudget({ capMotes: 12n * CSPR, now: clock.now });
  const state = {
    balance: 10n * CSPR,
    used: new Set<string>(),
    name: "CasCet X402 Token" as string,
    fail: false,
    readDelayMs: 0,
    deadlines: [] as Array<number | undefined>,
  };
  const signatureChecks = { count: 0 };
  const logs: string[] = [];
  let txCounter = 0;
  const chain = {
    feePayerAccountHash: "fe".repeat(32),
    feePayerPublicKey: `01${"fe".repeat(32)}`,
    txTtlMs: 600_000,
    submits: 0,
    builds: 0,
    ttls: [] as number[],
    build(_input: unknown, _paymentMotes: bigint, ttlMs: number) {
      chain.builds++;
      chain.ttls.push(ttlMs);
      txCounter++;
      return { hash: txCounter.toString(16).padStart(64, "0"), json: {} };
    },
    async submit(tx: { hash: string }) {
      chain.submits++;
      return opts.submit ? opts.submit() : ({ kind: "accepted", hash: tx.hash } as SubmitOutcome);
    },
    async waitForExecution() {
      return opts.outcome ? opts.outcome() : ({ kind: "success", costMotes: 3_010_000_000n } as ExecutionOutcome);
    },
  };
  const core = createFacilitatorCore(
    {
      network: NETWORK,
      allowedPayTo: [SELLER],
      allowedAssets: [ASSET],
      tokenVersion: "1",
      paymentMotes: 4n * CSPR,
      settleWaitMs: 12_000,
      maxValiditySeconds: 3_600,
      ...opts.config,
    },
    {
      verifySignature: async () => {
        signatureChecks.count++;
        return opts.verifySignature ? opts.verifySignature() : { isValid: true, payer: PAYER };
      },
      ...(opts.preflight === false
        ? {}
        : {
            tokenState: {
              isNonceUsed: async (_asset: string, _from: string, nonce: string, readOpts?: { deadlineMs?: number }) => {
                state.deadlines.push(readOpts?.deadlineMs);
                clock.advance(state.readDelayMs);
                if (state.fail) throw new TokenStateError("node unreachable");
                return state.used.has(nonce);
              },
              balanceOf: async (_asset: string, _from: string, readOpts?: { deadlineMs?: number }) => {
                state.deadlines.push(readOpts?.deadlineMs);
                if (state.fail) throw new TokenStateError("node unreachable");
                return state.balance;
              },
              tokenName: async (_asset: string, readOpts?: { deadlineMs?: number }) => {
                state.deadlines.push(readOpts?.deadlineMs);
                return state.name;
              },
            },
          }),
      chain,
      ledger,
      gas,
      log: { info: m => logs.push(m), warn: m => logs.push(m), error: m => logs.push(m) },
      now: clock.now,
    },
  );
  return { core, clock, ledger, gas, chain, signatureChecks, state, logs };
}

describe("request parsing (HTTP 400)", () => {
  test("rejects malformed bodies without touching the core", () => {
    const cases: Array<[unknown, string]> = [
      [null, Reason.invalidRequest],
      [{}, Reason.invalidRequest],
      [{ paymentPayload: {}, paymentRequirements: {} }, Reason.unsupportedVersion],
      [{ ...body(), paymentPayload: { ...body().paymentPayload, x402Version: 1 } }, Reason.unsupportedVersion],
      [{ ...body(), paymentRequirements: { ...body().paymentRequirements, network: "casper:casper" } }, Reason.unsupportedNetwork],
      [{ ...body(), paymentRequirements: { ...body().paymentRequirements, scheme: "upto" } }, Reason.unsupportedScheme],
      [{ ...body(), paymentRequirements: { ...body().paymentRequirements, payTo: 7 } }, Reason.invalidRequest],
      [{ ...body(), paymentRequirements: { ...body().paymentRequirements, amount: "1".repeat(500) } }, Reason.invalidRequest],
    ];
    for (const [input, reason] of cases) {
      const r = parsePaymentRequest(input, NETWORK);
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.status, 400);
        assert.equal(r.reason, reason);
      }
    }
  });

  test("allowlist entries are normalized and validated", () => {
    assert.equal(normalizePayTo(`account-hash-${"AA".repeat(32)}`), `00${"aa".repeat(32)}`);
    assert.equal(normalizeAsset(`hash-${ASSET}`), ASSET);
    assert.throws(() => normalizePayTo(`01${"aa".repeat(32)}`));
    assert.throws(() => normalizeAsset("hash-123"));
  });
});

describe("/verify", () => {
  test("a valid, funded, fresh authorization verifies once; a replay is 409", async () => {
    const h = harness();
    const first = await h.core.verify(parsed());
    assert.deepEqual(first, { status: 200, body: { isValid: true, payer: PAYER } });
    const replay = await h.core.verify(parsed());
    assert.equal(replay.status, 409);
    assert.equal(replay.body.invalidReason, Reason.duplicateNonce);
  });

  test("policy and CEP-3009 format checks (no gas, no RPC)", async () => {
    const h = harness();
    const now = Math.floor(T0 / 1000);
    const cases: Array<[Parameters<typeof body>[0], number, string]> = [
      [{ payTo: `00${"99".repeat(32)}` }, 403, Reason.payToNotAllowlisted],
      [{ asset: "dd".repeat(32) }, 403, Reason.assetNotAllowlisted],
      [{ payTo: `01${"88".repeat(32)}` }, 200, Reason.invalidPayTo],
      [{ from: `01${"65".repeat(32)}` }, 200, Reason.invalidPayer],
      [{ value: "0" }, 200, Reason.invalidAmount],
      [{ value: "0500" }, 200, Reason.invalidAmount],
      [{ validBefore: now - 1 }, 200, Reason.expired],
      [{ validBefore: now + 19 }, 200, Reason.expiresTooSoon],
      [{ validBefore: now + 7_200 }, 200, Reason.validityTooLong],
      [{ nonce: "abc" }, 200, Reason.invalidNonce],
      [{ publicKey: `02${"cd".repeat(33)}` }, 200, Reason.algorithmMismatch],
      [{ signature: "ab".repeat(64) }, 200, Reason.invalidSignature],
      [{ extra: { name: "CasCet X402 Token", version: "2" } }, 200, Reason.tokenDomainMismatch],
    ];
    for (const [over, status, reason] of cases) {
      const r = await h.core.verify(parsed(over));
      assert.equal(r.status, status, `status for ${reason}`);
      assert.equal(r.body.invalidReason, reason);
    }
    assert.equal(h.signatureChecks.count, 0, "rejected before the signature check");
  });

  test("the minimum settle window is configurable", async () => {
    const now = Math.floor(T0 / 1000);
    const strict = harness({ config: { minSettleWindowSeconds: 60 } });
    assert.equal((await strict.core.verify(parsed({ validBefore: now + 59 }))).body.invalidReason, Reason.expiresTooSoon);
    const lax = harness({ config: { minSettleWindowSeconds: 6 } });
    assert.equal((await lax.core.verify(parsed({ validBefore: now + 10 }))).body.isValid, true);
  });

  test("passes through the casper-x402 signature verdict", async () => {
    const h = harness({ verifySignature: () => ({ isValid: false, invalidReason: "invalid_exact_casper_facilitator_invalid_signature" }) });
    const r = await h.core.verify(parsed());
    assert.deepEqual(r.body.invalidReason, "invalid_exact_casper_facilitator_invalid_signature");
    assert.equal(h.ledger.size, 0);
  });

  test("on-chain preflight: used nonce (409), low balance, wrong domain name, RPC down (503)", async () => {
    const h = harness();
    h.state.used.add("9c".repeat(32));
    assert.equal((await h.core.verify(parsed())).status, 409);
    assert.equal((await h.core.verify(parsed())).body.invalidReason, Reason.nonceAlreadyUsed);

    h.state.balance = 499_999_999n;
    const poor = await h.core.verify(parsed({ nonce: "01".repeat(32) }));
    assert.deepEqual([poor.status, poor.body.invalidReason], [200, Reason.insufficientFunds]);

    h.state.balance = 10n * CSPR;
    const wrongName = await h.core.verify(parsed({ nonce: "02".repeat(32), extra: { name: "Wrapped CSPR", version: "1" } }));
    assert.equal(wrongName.body.invalidReason, Reason.tokenDomainMismatch);

    h.state.fail = true;
    const down = await h.core.verify(parsed({ nonce: "03".repeat(32) }));
    assert.deepEqual([down.status, down.body.invalidReason], [503, Reason.preflightUnavailable]);
    assert.equal(h.ledger.size, 0, "nothing is marked when a check fails");
  });

  test("every preflight read shares one deadline (default 10 s, configurable)", async () => {
    const h = harness();
    await h.core.verify(parsed());
    assert.deepEqual(h.state.deadlines, [T0 + 10_000, T0 + 10_000, T0 + 10_000]);
    const custom = harness({ config: { preflightDeadlineMs: 4_000 } });
    await custom.core.settle(parsed());
    assert.deepEqual(custom.state.deadlines, [T0 + 4_000, T0 + 4_000, T0 + 4_000]);
  });

  test("one balance cannot back several in-flight authorizations", async () => {
    const h = harness();
    h.state.balance = 1_000_000_000n; // covers two payments of 0.5
    assert.equal((await h.core.verify(parsed({ nonce: "01".repeat(32) }))).body.isValid, true);
    assert.equal((await h.core.verify(parsed({ nonce: "02".repeat(32) }))).body.isValid, true);
    const third = await h.core.verify(parsed({ nonce: "03".repeat(32) }));
    assert.equal(third.body.invalidReason, Reason.insufficientFunds);
    assert.match(third.body.invalidMessage ?? "", /already in flight/);
  });
});

describe("/settle", () => {
  test("verify → settle succeeds, counts the real gas cost, and locks the nonce", async () => {
    const h = harness();
    await h.core.verify(parsed());
    const r = await h.core.settle(parsed());
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.transaction, "1".padStart(64, "0"));
    assert.deepEqual(r.body.extra, { settlementStatus: "success", gasCostMotes: "3010000000" });
    assert.equal(h.gas.snapshot().spentMotes, 3_010_000_000n);
    assert.equal(h.signatureChecks.count, 2, "full verification runs again at settle (M21)");

    const again = await h.core.settle(parsed());
    assert.deepEqual([again.status, again.body.errorReason], [409, Reason.duplicateNonce]);
    assert.equal(again.body.transaction, r.body.transaction, "a retry learns the earlier transaction hash");
    assert.deepEqual(again.body.extra, { settlementStatus: "duplicate" }, "not 'not_submitted': the earlier tx charged the payer");
    assert.equal(h.chain.submits, 1);
  });

  test("concurrent duplicates: exactly one submission", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const h = harness({
      outcome: async () => {
        await gate;
        return { kind: "success", costMotes: 3n * CSPR };
      },
    });
    const a = h.core.settle(parsed());
    const b = h.core.settle(parsed());
    const second = await b;
    release();
    const first = await a;
    assert.equal(first.body.success, true);
    assert.deepEqual([second.status, second.body.errorReason], [409, Reason.duplicateNonce]);
    assert.deepEqual(second.body.extra, { settlementStatus: "duplicate" });
    assert.equal(h.chain.submits, 1);
  });

  test("a nonce already used on-chain is a duplicate (409), not a determinate non-payment", async () => {
    const h = harness();
    h.state.used.add("9c".repeat(32));
    const r = await h.core.settle(parsed());
    assert.deepEqual([r.status, r.body.errorReason, r.body.transaction], [409, Reason.nonceAlreadyUsed, ""]);
    assert.deepEqual(r.body.extra, { settlementStatus: "duplicate" });
    assert.deepEqual([h.chain.builds, h.chain.submits, h.ledger.size], [0, 0, 0]);
  });

  test("a settle that fails before submission releases gas and the nonce", async () => {
    const h = harness({ submit: () => ({ kind: "rejected", error: "Invalid transaction (code -32016)" }) });
    const r = await h.core.settle(parsed());
    assert.deepEqual([r.status, r.body.errorReason, r.body.transaction], [200, Reason.rejectedByNode, ""]);
    assert.deepEqual(r.body.extra, { settlementStatus: "not_submitted" });
    const s = h.gas.snapshot();
    assert.equal(s.reservedMotes + s.spentMotes, 0n);
    assert.equal(h.ledger.size, 0);
  });

  test("an authorization about to expire is not submitted (it would revert and burn the gas limit)", async () => {
    const h = harness();
    const now = Math.floor(T0 / 1000);
    assert.equal((await h.core.verify(parsed({ validBefore: now + 120 }))).body.isValid, true);
    h.clock.advance(105_000); // the gateway ran a slow tool: 15 s left at settle time
    const r = await h.core.settle(parsed({ validBefore: now + 120 }));
    assert.deepEqual([r.status, r.body.errorReason, r.body.transaction], [200, Reason.expiresTooSoon, ""]);
    assert.deepEqual(r.body.extra, { settlementStatus: "not_submitted" });
    assert.equal(h.chain.submits, 0);
    const s = h.gas.snapshot();
    assert.equal(s.reservedMotes + s.spentMotes, 0n);
  });

  test("the window is checked again after a slow preflight: nothing is built or submitted", async () => {
    const h = harness();
    const now = Math.floor(T0 / 1000);
    // 30 s left when /settle starts (a gateway's settle headroom). One timed-out
    // read plus its retry takes 16 s, which leaves 14 s: below the 20 s window.
    h.state.readDelayMs = 16_000;
    const r = await h.core.settle(parsed({ validBefore: now + 30 }));
    assert.deepEqual([r.status, r.body.errorReason, r.body.transaction], [200, Reason.expiresTooSoon, ""]);
    assert.deepEqual(r.body.extra, { settlementStatus: "not_submitted" });
    assert.deepEqual([h.chain.builds, h.chain.submits], [0, 0]);
    const s = h.gas.snapshot();
    assert.equal(s.reservedMotes + s.spentMotes, 0n);
    assert.equal(h.ledger.size, 0, "the settle claim is released");
  });

  test("a slow preflight at /verify does not approve an authorization that is about to expire", async () => {
    const h = harness();
    const now = Math.floor(T0 / 1000);
    h.state.readDelayMs = 16_000;
    const r = await h.core.verify(parsed({ validBefore: now + 30 }));
    assert.deepEqual([r.status, r.body.invalidReason], [200, Reason.expiresTooSoon]);
    assert.equal(h.ledger.size, 0);
  });

  test("the settlement TTL ends before validBefore (whole seconds), so a late transaction is dropped, not executed", async () => {
    const h = harness({ outcome: () => ({ kind: "pending", seen: true }) });
    const now = Math.floor(T0 / 1000);
    h.clock.advance(250); // not on a second boundary
    await h.core.settle(parsed({ nonce: "01".repeat(32), validBefore: now + 300 }));
    await h.core.settle(parsed({ nonce: "02".repeat(32), validBefore: now + 3_000 }));
    // 300 s − 0.25 s − 2 s margin, rounded down; the second is capped at the chain's 10-minute TTL.
    assert.deepEqual(h.chain.ttls, [297_000, 600_000]);
    // A pending settle locks its nonce only until it can no longer execute: validBefore + grace.
    const first = h.ledger.peek({ network: NETWORK, asset: ASSET, from: PAYER, nonce: "01".repeat(32) });
    assert.equal(first?.state, "submitted");
    assert.equal(first?.expiresAtMs, (now + 300) * 1000 + 60_000);
  });

  test("gas is reserved only right before submission (M08)", async () => {
    const h = harness();
    h.state.balance = 1n;
    const poor = await h.core.settle(parsed());
    assert.equal(poor.body.errorReason, Reason.insufficientFunds);
    assert.equal(h.chain.builds, 0);
    const s = h.gas.snapshot();
    assert.equal(s.reservedMotes + s.spentMotes, 0n, "rejected settles never touch the gas budget");
  });

  test("daily cap: 503 when reached, the nonce stays usable, the cap reopens next UTC day", async () => {
    const h = harness({ outcome: () => ({ kind: "success" }) }); // unknown cost: counts the full 4 CSPR
    assert.equal((await h.core.settle(parsed({ nonce: "01".repeat(32) }))).body.success, true);
    assert.equal((await h.core.settle(parsed({ nonce: "02".repeat(32) }))).body.success, true);
    assert.equal((await h.core.settle(parsed({ nonce: "03".repeat(32) }))).body.success, true);
    const capped = await h.core.settle(parsed({ nonce: "04".repeat(32) }));
    assert.deepEqual([capped.status, capped.body.errorReason], [503, Reason.gasCapReached]);
    assert.equal(h.chain.submits, 3);

    h.clock.ms = Date.UTC(2026, 10, 2, 0, 0, 5);
    const nextDay = parsed({ nonce: "04".repeat(32), validBefore: Math.floor(h.clock.ms / 1000) + 300 });
    assert.equal((await h.core.settle(nextDay)).body.success, true);
  });

  test("an on-chain revert reports the hash, counts its cost, and is not resubmitted", async () => {
    const h = harness({ outcome: () => ({ kind: "failure", errorMessage: "User error: 64658", costMotes: 4n * CSPR }) });
    const r = await h.core.settle(parsed());
    assert.equal(r.body.success, false);
    assert.equal(r.body.errorReason, Reason.failedOnChain);
    assert.equal(r.body.transaction, "1".padStart(64, "0"));
    assert.deepEqual(r.body.extra, { settlementStatus: "failed" });
    assert.equal(h.gas.snapshot().spentMotes, 4n * CSPR);
    assert.equal((await h.core.settle(parsed())).status, 409);
  });

  test("M22: an unobserved outcome is 'pending' with the hash, never a failure with an empty hash", async () => {
    const h = harness({ outcome: () => ({ kind: "pending", seen: true, lastError: "info_get_transaction: timeout" }) });
    const r = await h.core.settle(parsed());
    assert.equal(r.status, 200);
    assert.equal(r.body.success, false);
    assert.equal(r.body.errorReason, Reason.pending);
    assert.equal(r.body.transaction, "1".padStart(64, "0"));
    assert.deepEqual(r.body.extra, { settlementStatus: "pending" });
    assert.equal(h.gas.snapshot().spentMotes, 4n * CSPR, "full limit counted while unknown");
    const retry = await h.core.settle(parsed());
    assert.equal(retry.status, 409, "the nonce stays locked");
    assert.equal(retry.body.transaction, r.body.transaction, "and a retry is pointed at the pending transaction");
    assert.equal(h.chain.submits, 1);
  });

  test("an ambiguous submission the node never shows is 'unknown', still with the hash", async () => {
    const h = harness({
      submit: () => ({ kind: "unknown", hash: "77".repeat(32), error: "socket hang up" }),
      outcome: () => ({ kind: "pending", seen: false }),
    });
    const r = await h.core.settle(parsed());
    assert.equal(r.body.errorReason, Reason.unknown);
    assert.equal(r.body.transaction, "77".repeat(32));
    assert.deepEqual(r.body.extra, { settlementStatus: "unknown" });
  });

  test("an ambiguous submission that turns out executed is reported as success", async () => {
    const h = harness({
      submit: () => ({ kind: "unknown", hash: "78".repeat(32), error: "timeout" }),
      outcome: () => ({ kind: "success", costMotes: 3n * CSPR }),
    });
    const r = await h.core.settle(parsed());
    assert.equal(r.body.success, true);
    assert.equal(r.body.transaction, "78".repeat(32));
  });

  test("settle re-checks the chain even after /verify (balance drained in between)", async () => {
    const h = harness();
    assert.equal((await h.core.verify(parsed())).body.isValid, true);
    h.state.balance = 0n;
    const r = await h.core.settle(parsed());
    assert.equal(r.body.errorReason, Reason.insufficientFunds);
    assert.equal(h.chain.submits, 0);
    assert.equal(h.ledger.peek({ network: NETWORK, asset: ASSET, from: PAYER, nonce: "9c".repeat(32) })?.state, "verified");
  });

  test("a pinned domain name is checked without RPC, and the on-chain name still applies with the preflight on", async () => {
    const offline = harness({ preflight: false, config: { tokenName: "CasCet X402 Token" } });
    const wrong = await offline.core.settle(parsed({ extra: { name: "Wrapped CSPR", version: "1" } }));
    assert.deepEqual([wrong.body.errorReason, offline.chain.builds], [Reason.tokenDomainMismatch, 0]);
    assert.equal(offline.signatureChecks.count, 0, "rejected before the signature check");

    // A pin that disagrees with the chain is caught by the preflight instead of reverting on-chain.
    const mispinned = harness({ config: { tokenName: "Wrapped CSPR" } });
    const r = await mispinned.core.verify(parsed({ extra: { name: "Wrapped CSPR", version: "1" } }));
    assert.equal(r.body.invalidReason, Reason.tokenDomainMismatch);
    assert.match(r.body.invalidMessage ?? "", /CasCet X402 Token/);
  });

  test("without preflight the in-flight ledger still blocks duplicates", async () => {
    const h = harness({ preflight: false });
    assert.equal((await h.core.settle(parsed())).body.success, true);
    assert.equal((await h.core.settle(parsed())).status, 409);
  });

  test("log lines carry no raw request text", async () => {
    const h = harness();
    await h.core.verify(parsed({ payTo: `00${"99".repeat(32)}` }));
    await h.core.settle(parsed());
    for (const line of h.logs) assert.doesNotMatch(line, /[\r\n]/);
  });
});

test("supported() advertises the fee payer for the configured network", () => {
  const h = harness();
  assert.deepEqual(h.core.supported(), {
    kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra: { feePayer: "fe".repeat(32) } }],
    extensions: [],
    signers: { "casper:*": ["fe".repeat(32)] },
  });
});
