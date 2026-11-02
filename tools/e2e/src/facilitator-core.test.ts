import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { VerifyResponse } from "@x402/core/types";
import type { AuthorizationStyle } from "@cascet/core";
import { TokenStateError, TokenUnsupportedError } from "@cascet/gateway";
import { AuthorizationLedger } from "./authorization-ledger.js";
import {
  assetPolicyFor,
  createFacilitatorCore,
  knownAuthorizationStyle,
  normalizeAsset,
  normalizePayTo,
  parsePaymentRequest,
  paymentFingerprint,
  Reason,
  type AssetPolicy,
  type FacilitatorCoreConfig,
  type ParsedPayment,
} from "./facilitator-core.js";
import { DailyGasBudget } from "./gas-budget.js";
import type { ExecutionOutcome, SettlementChain, SettlementSettings, SubmitOutcome } from "./settlement.js";
import { FakeClock } from "./test-helpers.js";

const NETWORK = "casper:casper-test" as const;
/** CasCet X402 Token on testnet (legacy-amount). */
const ASSET = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
/** Official Wrapped CSPR on testnet (cep3009-value). */
const WCSPR = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";
const SELLER = `00${"88".repeat(32)}`;
const PAYER = `00${"65".repeat(32)}`;
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const CSPR = 1_000_000_000n;

const LEGACY_POLICY: AssetPolicy = { asset: ASSET, style: "legacy-amount", name: "CasCet X402 Token", version: "1", paymentMotes: 4n * CSPR };
const WCSPR_POLICY: AssetPolicy = { asset: WCSPR, style: "cep3009-value", name: "Wrapped CSPR", version: "1", paymentMotes: 3_500_000_000n };

type BodyOverrides = {
  nonce?: string;
  value?: string;
  from?: string;
  payTo?: string;
  asset?: string;
  validAfter?: number;
  validBefore?: number;
  publicKey?: string;
  signature?: string;
  extra?: Record<string, unknown>;
};

function body(over: BodyOverrides = {}) {
  const now = Math.floor(T0 / 1000);
  const payTo = over.payTo ?? SELLER;
  const value = over.value ?? "500000000";
  const asset = over.asset ?? ASSET;
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
          validAfter: String(over.validAfter ?? now - 600),
          validBefore: String(over.validBefore ?? now + 300),
          nonce: over.nonce ?? "9c".repeat(32),
        },
      },
    },
    paymentRequirements: {
      scheme: "exact",
      network: NETWORK,
      asset,
      amount: value,
      payTo,
      maxTimeoutSeconds: 300,
      extra: over.extra ?? {
        name: asset === WCSPR ? "Wrapped CSPR" : "CasCet X402 Token",
        version: "1",
        symbol: asset === WCSPR ? "WCSPR" : "CCX",
        decimals: "9",
      },
    },
  };
}

function parsed(over: BodyOverrides = {}): ParsedPayment {
  const p = parsePaymentRequest(body(over), NETWORK);
  assert.ok(p.ok, "fixture must parse");
  return p.value;
}

interface TokenState {
  style: AuthorizationStyle;
  /** On-chain `name`; undefined = the token has no such named key. */
  name?: string;
  /** On-chain `chain_name`; undefined = the token has no such named key. */
  chainName?: string;
  /** Thrown by authorizationStyle (e.g. TokenUnsupportedError). */
  abiError?: Error;
}

interface Harness {
  core: ReturnType<typeof createFacilitatorCore>;
  clock: FakeClock;
  ledger: AuthorizationLedger;
  gas: DailyGasBudget;
  chain: SettlementChain & { submits: number; builds: SettlementSettings[]; ttls: number[]; waits: string[] };
  signatureChecks: { count: number };
  /** `readDelayMs`: how far each nonce read moves the clock (a slow node). */
  state: {
    balance: bigint;
    used: Set<string>;
    tokens: Record<string, TokenState>;
    fail?: boolean;
    readDelayMs: number;
    deadlines: Array<number | undefined>;
  };
  logs: string[];
}

function harness(
  opts: {
    config?: Partial<FacilitatorCoreConfig>;
    submit?: () => SubmitOutcome | Promise<SubmitOutcome>;
    outcome?: () => ExecutionOutcome | Promise<ExecutionOutcome>;
    verifySignature?: () => VerifyResponse;
    preflight?: boolean;
    capMotes?: bigint;
    /** The state-file save (deps.persist), with the ledger and the submissions made so far. */
    persist?: (at: { ledger: AuthorizationLedger; submits: number }) => Promise<void>;
  } = {},
): Harness {
  const clock = new FakeClock(T0);
  const ledger = new AuthorizationLedger({ now: clock.now });
  const gas = new DailyGasBudget({ capMotes: opts.capMotes ?? 12n * CSPR, now: clock.now });
  const state: Harness["state"] = {
    balance: 10n * CSPR,
    used: new Set<string>(),
    tokens: {
      [ASSET]: { style: "legacy-amount", name: "CasCet X402 Token", chainName: NETWORK },
      [WCSPR]: { style: "cep3009-value", name: "Wrapped CSPR", chainName: NETWORK },
    },
    fail: false,
    readDelayMs: 0,
    deadlines: [],
  };
  const token = (asset: string): TokenState => {
    const t = state.tokens[asset];
    if (!t) throw new TokenUnsupportedError("token package: value was not found");
    return t;
  };
  const signatureChecks = { count: 0 };
  const logs: string[] = [];
  let txCounter = 0;
  const chain = {
    feePayerAccountHash: "fe".repeat(32),
    feePayerPublicKey: `01${"fe".repeat(32)}`,
    txTtlMs: 600_000,
    submits: 0,
    builds: [] as SettlementSettings[],
    ttls: [] as number[],
    waits: [] as string[],
    build(_input: unknown, settings: SettlementSettings) {
      chain.builds.push(settings);
      chain.ttls.push(settings.ttlMs);
      txCounter++;
      return { hash: txCounter.toString(16).padStart(64, "0"), json: {} };
    },
    async submit(tx: { hash: string }) {
      chain.submits++;
      return opts.submit ? opts.submit() : ({ kind: "accepted", hash: tx.hash } as SubmitOutcome);
    },
    async waitForExecution(hash: string) {
      chain.waits.push(hash);
      return opts.outcome ? opts.outcome() : ({ kind: "success", costMotes: 3_010_000_000n } as ExecutionOutcome);
    },
  };
  const core = createFacilitatorCore(
    {
      network: NETWORK,
      allowedPayTo: [SELLER],
      assets: [LEGACY_POLICY, WCSPR_POLICY],
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
              authorizationStyle: async (asset: string, readOpts?: { deadlineMs?: number }) => {
                state.deadlines.push(readOpts?.deadlineMs);
                const t = token(asset);
                if (t.abiError) throw t.abiError;
                return t.style;
              },
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
              tokenName: async (asset: string, readOpts?: { deadlineMs?: number }) => {
                state.deadlines.push(readOpts?.deadlineMs);
                return token(asset).name;
              },
              chainName: async (asset: string, readOpts?: { deadlineMs?: number }) => {
                state.deadlines.push(readOpts?.deadlineMs);
                return token(asset).chainName;
              },
            },
          }),
      chain,
      ledger,
      gas,
      ...(opts.persist ? { persist: () => opts.persist!({ ledger, submits: chain.submits }) } : {}),
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
    assert.throws(() => normalizePayTo(`hash-${"aa".repeat(32)}`), /contract-package payees .* not supported/);
    assert.throws(() => normalizePayTo(`package-hash-${"aa".repeat(32)}`), /not supported/);
    assert.throws(() => normalizeAsset("hash-123"));
  });
});

describe("asset policies", () => {
  test("styles CasCet knows without the chain: its own token on both networks, Wrapped CSPR on testnet", () => {
    assert.equal(knownAuthorizationStyle(NETWORK, ASSET), "legacy-amount");
    assert.equal(knownAuthorizationStyle("casper:casper", "8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41"), "legacy-amount");
    assert.equal(knownAuthorizationStyle(NETWORK, WCSPR), "cep3009-value");
    assert.equal(knownAuthorizationStyle(NETWORK, "dd".repeat(32)), undefined);
  });

  test("an allowlist lists policies; without one (testnet), any asset gets the open policy", () => {
    const listed: FacilitatorCoreConfig = { network: NETWORK, assets: [LEGACY_POLICY], settleWaitMs: 1, maxValiditySeconds: 1 };
    assert.equal(assetPolicyFor(listed, ASSET), LEGACY_POLICY);
    assert.equal(assetPolicyFor(listed, WCSPR), undefined);
    const open: FacilitatorCoreConfig = { network: NETWORK, anyAsset: { name: "Pinned" }, settleWaitMs: 1, maxValiditySeconds: 1 };
    assert.deepEqual(assetPolicyFor(open, WCSPR), { asset: WCSPR, style: "cep3009-value", name: "Pinned", version: "1" });
    assert.deepEqual(assetPolicyFor(open, "dd".repeat(32)), { asset: "dd".repeat(32), name: "Pinned", version: "1" });
  });
});

describe("/verify", () => {
  test("a valid, funded, fresh authorization verifies once; a replay is a duplicate (HTTP 200)", async () => {
    const h = harness();
    const first = await h.core.verify(parsed());
    assert.deepEqual(first, { status: 200, body: { isValid: true, payer: PAYER } });
    const replay = await h.core.verify(parsed());
    assert.equal(replay.status, 200);
    assert.deepEqual([replay.body.isValid, replay.body.invalidReason], [false, Reason.duplicateNonce]);
  });

  test("both styles verify: Wrapped CSPR with its own domain name", async () => {
    const h = harness();
    assert.equal((await h.core.verify(parsed({ asset: WCSPR }))).body.isValid, true);
    assert.ok(h.logs.some(l => l.includes("style=cep3009-value")));
    const wrongName = await h.core.verify(parsed({ asset: WCSPR, nonce: "01".repeat(32), extra: { name: "CasCet X402 Token", version: "1" } }));
    assert.deepEqual([wrongName.status, wrongName.body.invalidReason], [200, Reason.tokenDomainMismatch]);
    assert.match(wrongName.body.invalidMessage ?? "", /Wrapped CSPR/);
  });

  test("policy and CEP-3009 format checks answer HTTP 200 (no gas, no RPC)", async () => {
    const h = harness();
    const now = Math.floor(T0 / 1000);
    const cases: Array<[BodyOverrides, string]> = [
      [{ payTo: `00${"99".repeat(32)}` }, Reason.payToNotAllowlisted],
      [{ asset: "dd".repeat(32) }, Reason.assetNotAllowlisted],
      [{ asset: "hash-xyz" }, Reason.invalidAsset],
      [{ payTo: `01${"88".repeat(32)}` }, Reason.invalidPayTo],
      [{ from: `01${"65".repeat(32)}` }, Reason.invalidPayer],
      [{ value: "0" }, Reason.invalidAmount],
      [{ value: "0500" }, Reason.invalidAmount],
      [{ validAfter: now + 30 }, Reason.notYetValid],
      [{ validBefore: now - 1 }, Reason.expired],
      [{ validBefore: now + 19 }, Reason.expiresTooSoon],
      [{ validBefore: now + 7_200 }, Reason.validityTooLong],
      [{ nonce: "abc" }, Reason.invalidNonce],
      [{ publicKey: `02${"cd".repeat(33)}` }, Reason.algorithmMismatch],
      [{ signature: "ab".repeat(64) }, Reason.invalidSignature],
      [{ extra: { name: "CasCet X402 Token", version: "2" } }, Reason.tokenDomainMismatch],
      [{ extra: { name: "Wrapped CSPR", version: "1" } }, Reason.tokenDomainMismatch],
    ];
    for (const [over, reason] of cases) {
      const r = await h.core.verify(parsed(over));
      assert.equal(r.status, 200, `status for ${reason}`);
      assert.deepEqual([r.body.isValid, r.body.invalidReason], [false, reason]);
    }
    assert.equal(h.signatureChecks.count, 0, "rejected before the signature check");
    assert.equal(h.state.deadlines.length, 0, "and before any chain read");
    const contractPayee = await h.core.verify(parsed({ payTo: `01${"88".repeat(32)}` }));
    assert.match(contractPayee.body.invalidMessage ?? "", /contract-package payees .* not supported/);
  });

  test("the minimum settle window is configurable", async () => {
    const now = Math.floor(T0 / 1000);
    const strict = harness({ config: { minSettleWindowSeconds: 60 } });
    assert.equal((await strict.core.verify(parsed({ validBefore: now + 59 }))).body.invalidReason, Reason.expiresTooSoon);
    const lax = harness({ config: { minSettleWindowSeconds: 6 } });
    assert.equal((await lax.core.verify(parsed({ validBefore: now + 10 }))).body.isValid, true);
  });

  test("passes through the signature verdict", async () => {
    const h = harness({ verifySignature: () => ({ isValid: false, invalidReason: "invalid_exact_casper_facilitator_invalid_signature" }) });
    const r = await h.core.verify(parsed());
    assert.deepEqual(r.body.invalidReason, "invalid_exact_casper_facilitator_invalid_signature");
    assert.equal(h.ledger.size, 0);
  });

  test("on-chain preflight: used nonce and low balance are verdicts (200); RPC down is 503", async () => {
    const h = harness();
    h.state.used.add("9c".repeat(32));
    const used = await h.core.verify(parsed());
    assert.deepEqual([used.status, used.body.invalidReason], [200, Reason.nonceAlreadyUsed]);

    h.state.balance = 499_999_999n;
    const poor = await h.core.verify(parsed({ nonce: "01".repeat(32) }));
    assert.deepEqual([poor.status, poor.body.invalidReason], [200, Reason.insufficientFunds]);

    h.state.balance = 10n * CSPR;
    h.state.fail = true;
    const down = await h.core.verify(parsed({ nonce: "03".repeat(32) }));
    assert.deepEqual([down.status, down.body.invalidReason], [503, Reason.preflightUnavailable]);
    assert.equal(h.ledger.size, 0, "nothing is marked when a check fails");
  });

  test("every preflight read shares one deadline (default 10 s, configurable)", async () => {
    const h = harness();
    await h.core.verify(parsed());
    assert.deepEqual(h.state.deadlines, Array(5).fill(T0 + 10_000), "ABI, nonce, balance, name and chain_name");
    const custom = harness({ config: { preflightDeadlineMs: 4_000 } });
    await custom.core.settle(parsed());
    assert.deepEqual(custom.state.deadlines, Array(5).fill(T0 + 4_000));
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

describe("authorization styles", () => {
  test("each asset settles in its own style, with its own gas limit", async () => {
    const h = harness();
    const legacy = await h.core.settle(parsed({ nonce: "01".repeat(32) }));
    const value = await h.core.settle(parsed({ asset: WCSPR, nonce: "02".repeat(32) }));
    assert.deepEqual([legacy.body.success, value.body.success], [true, true]);
    assert.deepEqual(
      h.chain.builds.map(b => [b.style, b.paymentMotes]),
      [
        ["legacy-amount", 4n * CSPR],
        ["cep3009-value", 3_500_000_000n],
      ],
    );
    assert.equal(legacy.body.extra?.["authorizationStyle"], "legacy-amount");
    assert.equal(value.body.extra?.["authorizationStyle"], "cep3009-value");
  });

  test("the daily cap counts every asset's own limit", async () => {
    // 7.5 CSPR fits one legacy (4) and one Wrapped CSPR (3.5) settle whose cost stays unknown.
    const h = harness({ capMotes: 7_500_000_000n, outcome: () => ({ kind: "success" }) });
    assert.equal((await h.core.settle(parsed({ nonce: "01".repeat(32) }))).body.success, true);
    assert.equal((await h.core.settle(parsed({ asset: WCSPR, nonce: "02".repeat(32) }))).body.success, true);
    const capped = await h.core.settle(parsed({ asset: WCSPR, nonce: "03".repeat(32) }));
    assert.deepEqual([capped.status, capped.body.errorReason], [503, Reason.gasCapReached]);
    assert.equal(h.gas.snapshot().spentMotes, 7_500_000_000n);
  });

  test("a pinned style the chain contradicts is refused (200) and nothing is built", async () => {
    const h = harness();
    // The token was upgraded to the CEP-3009 ABI after start-up.
    h.state.tokens[ASSET]!.style = "cep3009-value";
    const v = await h.core.verify(parsed());
    assert.deepEqual([v.status, v.body.invalidReason], [200, Reason.authorizationStyleMismatch]);
    assert.match(v.body.invalidMessage ?? "", /takes `value` \(cep3009-value\); this facilitator settles it as legacy-amount/);
    const s = await h.core.settle(parsed());
    assert.deepEqual([s.status, s.body.success, s.body.errorReason, s.body.transaction], [200, false, Reason.authorizationStyleMismatch, ""]);
    assert.deepEqual(s.body.extra, { settlementStatus: "not_submitted" });
    assert.deepEqual([h.chain.builds.length, h.chain.submits, h.ledger.size], [0, 0, 0]);
    assert.ok(h.logs.some(l => /pinned as legacy-amount/.test(l)), "the operator is told");
  });

  test("a token whose ABI matches neither style is unsupported (200), not unavailable", async () => {
    const h = harness();
    h.state.tokens[WCSPR]!.abiError = new TokenUnsupportedError("transfer_with_authorization is missing");
    const r = await h.core.settle(parsed({ asset: WCSPR }));
    assert.deepEqual([r.status, r.body.errorReason], [200, Reason.unsupportedAsset]);
    assert.equal(h.chain.builds.length, 0);
  });

  test("the token's EIP-712 chain_name must be this network", async () => {
    const h = harness();
    h.state.tokens[ASSET]!.chainName = "casper:casper";
    const r = await h.core.verify(parsed());
    assert.deepEqual([r.status, r.body.invalidReason], [200, Reason.tokenDomainMismatch]);
    assert.match(r.body.invalidMessage ?? "", /chain_name/);
  });

  test("an EIP-712 domain the facilitator cannot check is refused (fail closed), at /verify and /settle", async () => {
    // A token (upgraded after start-up) without a chain_name named key.
    const noChain = harness();
    delete noChain.state.tokens[ASSET]!.chainName;
    const v = await noChain.core.verify(parsed());
    assert.deepEqual([v.status, v.body.invalidReason], [200, Reason.tokenDomainMismatch]);
    assert.match(v.body.invalidMessage ?? "", /no on-chain chain_name/);
    const s = await noChain.core.settle(parsed());
    assert.deepEqual([s.status, s.body.errorReason, s.body.transaction], [200, Reason.tokenDomainMismatch, ""]);
    assert.deepEqual([noChain.chain.builds.length, noChain.ledger.size], [0, 0]);

    // Without an asset allowlist (testnet), a token without an on-chain name and no pinned name.
    const open = harness({ config: { assets: undefined, anyAsset: { version: "1" } } });
    const other = "dd".repeat(32);
    open.state.tokens[other] = { style: "cep3009-value", chainName: NETWORK };
    const unnamed = await open.core.settle(parsed({ asset: other, extra: { name: "Anything the buyer chose", version: "1" } }));
    assert.deepEqual([unnamed.status, unnamed.body.errorReason], [200, Reason.tokenDomainMismatch]);
    assert.match(unnamed.body.errorMessage ?? "", /no on-chain name and this facilitator pins none/);
    assert.equal(open.chain.builds.length, 0);

    // A pinned name binds the domain of a token without an on-chain name.
    const pinned = harness({ config: { assets: undefined, anyAsset: { name: "Pinned", version: "1" } } });
    pinned.state.tokens[other] = { style: "cep3009-value", chainName: NETWORK };
    assert.equal((await pinned.core.settle(parsed({ asset: other, extra: { name: "Pinned", version: "1" } }))).body.success, true);
    const wrong = await pinned.core.settle(parsed({ asset: other, nonce: "02".repeat(32), extra: { name: "Other", version: "1" } }));
    assert.equal(wrong.body.errorReason, Reason.tokenDomainMismatch);
  });

  test("the authorizationStyle the requirements advertise is informational: logged, never trusted", async () => {
    const h = harness();
    const extra = { name: "CasCet X402 Token", version: "1", authorizationStyle: "cep3009-value" };
    const r = await h.core.settle(parsed({ extra }));
    assert.equal(r.body.success, true);
    assert.equal(h.chain.builds[0]?.style, "legacy-amount", "the chain decides");
    assert.ok(h.logs.some(l => l.includes("advertise authorizationStyle=cep3009-value")));
  });

  test("without an asset allowlist (testnet), the chain's style is used; without the preflight only known tokens settle", async () => {
    const open = harness({ config: { assets: undefined, anyAsset: { version: "1" } } });
    const other = "dd".repeat(32);
    open.state.tokens[other] = { style: "cep3009-value", name: "Other", chainName: NETWORK };
    const r = await open.core.settle(parsed({ asset: other, extra: { name: "Other", version: "1" } }));
    assert.equal(r.body.success, true);
    assert.deepEqual(
      open.chain.builds.map(b => [b.style, b.paymentMotes]),
      [["cep3009-value", 2_500_000_000n]],
      "the style's default gas limit",
    );

    const offline = harness({ preflight: false, config: { assets: undefined, anyAsset: { name: "CasCet X402 Token", version: "1" } } });
    assert.equal((await offline.core.settle(parsed())).body.success, true, "CasCet's own token: legacy-amount");
    assert.equal(offline.chain.builds[0]?.style, "legacy-amount");
    const unknown = await offline.core.settle(parsed({ asset: other, nonce: "02".repeat(32), extra: { name: "CasCet X402 Token", version: "1" } }));
    assert.deepEqual([unknown.status, unknown.body.errorReason], [200, Reason.unsupportedAsset]);
    assert.equal(offline.chain.builds.length, 1);
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
    assert.deepEqual(r.body.extra, { settlementStatus: "success", authorizationStyle: "legacy-amount", gasCostMotes: "3010000000" });
    assert.equal(h.gas.snapshot().spentMotes, 3_010_000_000n);
    assert.equal(h.signatureChecks.count, 2, "full verification runs again at settle (M21)");

    const again = await h.core.settle(parsed());
    assert.deepEqual([again.status, again.body.errorReason], [200, Reason.duplicateNonce]);
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
    assert.deepEqual([second.status, second.body.errorReason], [200, Reason.duplicateNonce]);
    assert.deepEqual(second.body.extra, { settlementStatus: "duplicate" });
    assert.equal(h.chain.submits, 1);
  });

  test("a nonce already used on-chain is a duplicate, not a determinate non-payment", async () => {
    const h = harness();
    h.state.used.add("9c".repeat(32));
    const r = await h.core.settle(parsed());
    assert.deepEqual([r.status, r.body.errorReason, r.body.transaction], [200, Reason.nonceAlreadyUsed, ""]);
    assert.deepEqual(r.body.extra, { settlementStatus: "duplicate" });
    assert.deepEqual([h.chain.builds.length, h.chain.submits, h.ledger.size], [0, 0, 0]);
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
    assert.deepEqual([h.chain.builds.length, h.chain.submits], [0, 0]);
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
    assert.equal(h.chain.builds.length, 0);
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
    assert.deepEqual(r.body.extra, { settlementStatus: "failed", authorizationStyle: "legacy-amount" });
    assert.equal(h.gas.snapshot().spentMotes, 4n * CSPR);
    const again = await h.core.settle(parsed());
    assert.deepEqual([again.status, again.body.errorReason, again.body.transaction], [200, Reason.duplicateNonce, r.body.transaction]);
  });

  test("M22: an unobserved outcome is 'pending' with the hash, never a failure with an empty hash", async () => {
    const h = harness({ outcome: () => ({ kind: "pending", seen: true, lastError: "info_get_transaction: timeout" }) });
    const r = await h.core.settle(parsed());
    assert.equal(r.status, 200);
    assert.equal(r.body.success, false);
    assert.equal(r.body.errorReason, Reason.pending);
    assert.equal(r.body.transaction, "1".padStart(64, "0"));
    assert.deepEqual(r.body.extra, { settlementStatus: "pending", authorizationStyle: "legacy-amount" });
    assert.equal(h.gas.snapshot().spentMotes, 4n * CSPR, "full limit counted while unknown");
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
    assert.deepEqual(r.body.extra, { settlementStatus: "unknown", authorizationStyle: "legacy-amount" });
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
    const offline = harness({ preflight: false });
    const wrong = await offline.core.settle(parsed({ extra: { name: "Wrapped CSPR", version: "1" } }));
    assert.deepEqual([wrong.body.errorReason, offline.chain.builds.length], [Reason.tokenDomainMismatch, 0]);
    assert.equal(offline.signatureChecks.count, 0, "rejected before the signature check");

    // A pin that disagrees with the chain is caught by the preflight instead of reverting on-chain.
    const mispinned = harness({ config: { assets: [{ ...LEGACY_POLICY, name: "Wrapped CSPR" }] } });
    const r = await mispinned.core.verify(parsed({ extra: { name: "Wrapped CSPR", version: "1" } }));
    assert.equal(r.body.invalidReason, Reason.tokenDomainMismatch);
    assert.match(r.body.invalidMessage ?? "", /CasCet X402 Token/);
  });

  test("without preflight the in-flight ledger still blocks duplicates, and the pinned style is used", async () => {
    const h = harness({ preflight: false });
    assert.equal((await h.core.settle(parsed({ asset: WCSPR }))).body.success, true);
    assert.equal(h.chain.builds[0]?.style, "cep3009-value");
    const again = await h.core.settle(parsed({ asset: WCSPR }));
    assert.deepEqual([again.status, again.body.errorReason], [200, Reason.duplicateNonce]);
  });

  test("log lines carry no raw request text", async () => {
    const h = harness();
    await h.core.verify(parsed({ payTo: `00${"99".repeat(32)}` }));
    await h.core.settle(parsed({ extra: { name: "CasCet X402 Token", version: "1", authorizationStyle: "x\ny" } }));
    for (const line of h.logs) assert.doesNotMatch(line, /[\r\n]/);
  });
});

describe("pending settlements: a settle retry follows the earlier transaction (never broadcasts twice)", () => {
  /** A harness whose execution outcomes are taken from `outcomes` in order. */
  function scripted(outcomes: ExecutionOutcome[], submit?: () => SubmitOutcome) {
    let n = 0;
    return harness({ outcome: () => outcomes[Math.min(n++, outcomes.length - 1)]!, ...(submit ? { submit } : {}) });
  }

  test("the @x402/core 2.29 retry of settlement_pending gets the outcome of the same transaction", async () => {
    const h = scripted([
      { kind: "pending", seen: true },
      { kind: "success", costMotes: 3_010_000_000n },
    ]);
    const first = await h.core.settle(parsed());
    assert.deepEqual([first.body.errorReason, first.body.transaction], [Reason.pending, "1".padStart(64, "0")]);
    assert.equal(h.gas.snapshot().spentMotes, 4n * CSPR, "counted at the full limit while pending");

    const retry = await h.core.settle(parsed());
    assert.equal(retry.status, 200);
    assert.equal(retry.body.success, true);
    assert.equal(retry.body.transaction, first.body.transaction, "the same transaction");
    assert.deepEqual(retry.body.extra, {
      settlementStatus: "success",
      authorizationStyle: "legacy-amount",
      gasCostMotes: "3010000000",
      reconciled: true,
    });
    assert.deepEqual([h.chain.builds.length, h.chain.submits], [1, 1], "nothing was built or submitted again");
    assert.deepEqual(h.chain.waits, [first.body.transaction, first.body.transaction]);
    assert.equal(h.signatureChecks.count, 1, "the follow path needs no new verification: it submits nothing");
    assert.equal(h.gas.snapshot().spentMotes, 3_010_000_000n, "corrected to the real cost");
    assert.equal(h.ledger.peek({ network: NETWORK, asset: ASSET, from: PAYER, nonce: "9c".repeat(32) })?.state, "settled");

    // A third settle of the same payment is a duplicate: one success per authorization.
    const third = await h.core.settle(parsed());
    assert.deepEqual([third.body.success, third.body.errorReason, third.body.transaction], [false, Reason.duplicateNonce, first.body.transaction]);
    assert.equal(h.chain.waits.length, 2);
  });

  test("followed even when the authorization is now too close to expiry for a new settlement", async () => {
    const h = scripted([
      { kind: "pending", seen: true },
      { kind: "success", costMotes: 3n * CSPR },
    ]);
    const now = Math.floor(T0 / 1000);
    const first = await h.core.settle(parsed({ validBefore: now + 60 }));
    assert.equal(first.body.errorReason, Reason.pending);
    h.clock.advance(50_000); // 10 s left: a new settle would be refused
    const retry = await h.core.settle(parsed({ validBefore: now + 60 }));
    assert.deepEqual([retry.body.success, retry.body.transaction], [true, first.body.transaction]);
  });

  test("near expiry, a concurrent retry (the follow claim is taken) is a duplicate with the hash, never 'expires too soon'", async () => {
    let releaseWait!: () => void;
    const gate = new Promise<void>(r => (releaseWait = r));
    const outcomes: Array<() => Promise<ExecutionOutcome>> = [
      async () => ({ kind: "pending", seen: true }),
      async () => {
        await gate;
        return { kind: "success", costMotes: 3n * CSPR };
      },
    ];
    let n = 0;
    const h = harness({ outcome: () => outcomes[n++]!() });
    const now = Math.floor(T0 / 1000);
    const payment = () => parsed({ validBefore: now + 60 });
    const first = await h.core.settle(payment());
    assert.equal(first.body.errorReason, Reason.pending);
    h.clock.advance(50_000); // 10 s left: inside the 20 s settle window

    const follower = h.core.settle(payment());
    const concurrent = await h.core.settle(payment());
    assert.deepEqual(
      [concurrent.status, concurrent.body.success, concurrent.body.errorReason, concurrent.body.transaction, concurrent.body.payer],
      [200, false, Reason.duplicateNonce, first.body.transaction, PAYER],
    );
    assert.deepEqual(concurrent.body.extra, { settlementStatus: "duplicate" }, "not not_submitted: the transaction can still charge the payer");
    releaseWait();
    assert.deepEqual([(await follower).body.success, (await follower).body.transaction], [true, first.body.transaction]);

    // After the outcome, still near expiry: another payment for the nonce and the same payment again.
    const other = await h.core.settle(parsed({ validBefore: now + 60, signature: `01${"ac".repeat(64)}` }));
    const again = await h.core.settle(payment());
    for (const r of [other, again]) {
      assert.deepEqual([r.body.errorReason, r.body.transaction], [Reason.duplicateNonce, first.body.transaction]);
      assert.deepEqual(r.body.extra, { settlementStatus: "duplicate" });
    }
    assert.deepEqual([h.chain.builds.length, h.chain.submits], [1, 1]);
    assert.equal(h.signatureChecks.count, 1, "answered before any check of a new settlement");
  });

  test("knownTransaction: a lookup of the transaction submitted for an authorization, without claiming it", async () => {
    const h = scripted([
      { kind: "pending", seen: true },
      { kind: "success", costMotes: 3n * CSPR },
    ]);
    assert.equal(h.core.knownTransaction(parsed()), undefined, "nothing yet");
    assert.equal((await h.core.verify(parsed())).body.isValid, true);
    assert.equal(h.core.knownTransaction(parsed()), undefined, "verified: no transaction");
    const first = await h.core.settle(parsed());
    const hash = first.body.transaction;
    assert.deepEqual(h.core.knownTransaction(parsed()), { state: "submitted", txHash: hash });
    // Any payment for the same (asset, payer, nonce) sees it, however its fields are spelled.
    assert.deepEqual(h.core.knownTransaction(parsed({ asset: `hash-${ASSET.toUpperCase()}`, signature: `01${"ac".repeat(64)}` })), {
      state: "submitted",
      txHash: hash,
    });
    assert.equal(h.core.knownTransaction(parsed({ nonce: "01".repeat(32) })), undefined);
    assert.equal(h.core.knownTransaction(parsed({ asset: WCSPR })), undefined);
    // The lookup took no claim: the retry still follows the transaction.
    const retry = await h.core.settle(parsed());
    assert.deepEqual([retry.body.success, retry.body.extra?.["reconciled"]], [true, true]);
    assert.deepEqual(h.core.knownTransaction(parsed()), { state: "settled", txHash: hash });
  });

  test("only the identical payment may follow: another payment for the same nonce is a duplicate", async () => {
    const h = scripted([{ kind: "pending", seen: true }]);
    const first = await h.core.settle(parsed());
    const other = await h.core.settle(parsed({ signature: `01${"ac".repeat(64)}` }));
    assert.deepEqual([other.body.errorReason, other.body.transaction], [Reason.duplicateNonce, first.body.transaction]);
    assert.deepEqual(other.body.extra, { settlementStatus: "duplicate" });
    assert.equal(h.chain.waits.length, 1, "nothing followed the transaction for it");
    // The fingerprint covers the signature, the authorization and the terms it pays.
    assert.notEqual(paymentFingerprint(parsed(), NETWORK), paymentFingerprint(parsed({ signature: `01${"ac".repeat(64)}` }), NETWORK));
    assert.equal(paymentFingerprint(parsed({ asset: `hash-${ASSET.toUpperCase()}` }), NETWORK), paymentFingerprint(parsed(), NETWORK));
  });

  test("a transaction still unseen answers pending again and can be followed again; concurrent retries follow once", async () => {
    let releaseWait!: () => void;
    const gate = new Promise<void>(r => (releaseWait = r));
    const outcomes: Array<() => Promise<ExecutionOutcome>> = [
      async () => ({ kind: "pending", seen: true }),
      async () => {
        await gate;
        return { kind: "pending", seen: true, lastError: "timeout" };
      },
      async () => ({ kind: "failure", errorMessage: "User error: 4", costMotes: 4n * CSPR }),
    ];
    let n = 0;
    const h = harness({ outcome: () => outcomes[n++]!() });
    const first = await h.core.settle(parsed());
    assert.equal(first.body.errorReason, Reason.pending);

    const follower = h.core.settle(parsed());
    const concurrent = await h.core.settle(parsed());
    assert.deepEqual([concurrent.body.errorReason, concurrent.body.transaction], [Reason.duplicateNonce, first.body.transaction]);
    releaseWait();
    const stillPending = await follower;
    assert.deepEqual([stillPending.body.errorReason, stillPending.body.transaction], [Reason.pending, first.body.transaction]);
    assert.deepEqual(stillPending.body.extra, { settlementStatus: "pending", authorizationStyle: "legacy-amount" });

    const reverted = await h.core.settle(parsed());
    assert.deepEqual([reverted.body.errorReason, reverted.body.transaction], [Reason.failedOnChain, first.body.transaction]);
    assert.deepEqual(reverted.body.extra, { settlementStatus: "failed", authorizationStyle: "legacy-amount", reconciled: true });
    assert.equal(h.chain.submits, 1);
    assert.equal(h.gas.snapshot().spentMotes, 4n * CSPR);
  });

  test("an unknown submission stays unknown while the node never shows it", async () => {
    const h = scripted([{ kind: "pending", seen: false }], () => ({ kind: "unknown", hash: "77".repeat(32), error: "socket hang up" }));
    const first = await h.core.settle(parsed());
    assert.equal(first.body.errorReason, Reason.unknown);
    const retry = await h.core.settle(parsed());
    assert.deepEqual([retry.body.errorReason, retry.body.transaction], [Reason.unknown, "77".repeat(32)]);
    assert.equal(h.chain.submits, 1);
  });

  test("a follower polls the stored hash for the settle wait, from its own start", async () => {
    const h = scripted([
      { kind: "pending", seen: true },
      { kind: "pending", seen: true },
    ]);
    const deadlines: number[] = [];
    const wait = h.chain.waitForExecution.bind(h.chain);
    h.chain.waitForExecution = async (hash: string, deadlineMs: number) => {
      deadlines.push(deadlineMs);
      return wait(hash, deadlineMs);
    };
    await h.core.settle(parsed());
    h.clock.advance(1_000);
    await h.core.settle(parsed());
    assert.deepEqual(deadlines, [T0 + 12_000, T0 + 13_000]);
  });
});

describe("write-ahead: a settlement is saved before it is broadcast (F11)", () => {
  const ID = { network: NETWORK, asset: ASSET, from: PAYER, nonce: "9c".repeat(32) };

  test("the state file holds the transaction, with the payment it settles, before any node can have it", async () => {
    const seen: Array<{ submits: number; saved: unknown }> = [];
    const h = harness({
      outcome: () => ({ kind: "pending", seen: true }),
      persist: async ({ ledger, submits }) => {
        seen.push({ submits, saved: ledger.persistedAuthorizations() });
      },
    });
    const r = await h.core.settle(parsed());
    assert.equal(r.body.errorReason, Reason.pending);
    const hash = "1".padStart(64, "0");
    assert.deepEqual(seen, [
      {
        submits: 0,
        saved: [
          {
            id: ID,
            txHash: hash,
            state: "submitted",
            validBefore: Math.floor(T0 / 1000) + 300,
            value: 500_000_000n,
            status: "unknown",
            fingerprint: paymentFingerprint(parsed(), NETWORK),
            style: "legacy-amount",
          },
        ],
      },
    ]);
    assert.equal(h.chain.submits, 1);
    // What the settle answered is what a restart restores.
    assert.equal(h.ledger.persistedAuthorizations()[0]?.status, "pending");
  });

  test("a save that fails submits nothing: 503, not submitted, gas and claim released; the next settle goes through", async () => {
    let failures = 1;
    const h = harness({
      persist: async () => {
        if (failures-- > 0) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      },
    });
    assert.equal((await h.core.verify(parsed())).body.isValid, true);
    const r = await h.core.settle(parsed());
    assert.deepEqual([r.status, r.body.success, r.body.errorReason, r.body.transaction], [503, false, Reason.stateUnavailable, ""]);
    assert.deepEqual(r.body.extra, { settlementStatus: "not_submitted" });
    assert.equal(h.chain.submits, 0);
    const gas = h.gas.snapshot();
    assert.equal(gas.reservedMotes + gas.spentMotes, 0n);
    assert.equal(h.ledger.peek(ID)?.state, "verified", "back to the verified hold");
    assert.deepEqual(h.ledger.persistedAuthorizations(), [], "the record went with the claim");
    assert.ok(h.logs.some(l => /not submitted: the state file could not be saved \(ENOSPC/.test(l)));

    const retry = await h.core.settle(parsed());
    assert.equal(retry.body.success, true);
    assert.equal(h.chain.submits, 1);
  });

  test("a transaction the node rejected is dropped from the state", async () => {
    let saves = 0;
    const h = harness({
      submit: () => ({ kind: "rejected", error: "Invalid transaction (code -32016)" }),
      persist: async () => {
        saves++;
      },
    });
    const r = await h.core.settle(parsed());
    assert.equal(r.body.errorReason, Reason.rejectedByNode);
    assert.equal(saves, 1);
    assert.deepEqual(h.ledger.persistedAuthorizations(), []);
  });

  test("without a state file nothing is awaited and settles work as before", async () => {
    const h = harness();
    assert.equal((await h.core.settle(parsed())).body.success, true);
    assert.deepEqual(h.ledger.persistedAuthorizations().map(r => r.state), ["settled"]);
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
