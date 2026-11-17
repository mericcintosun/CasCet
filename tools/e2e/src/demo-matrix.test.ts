import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cascetConfigSchema, facilitatorAuthorization, facilitatorFor, usdPriceToTokenUnits } from "@cascet/core";
import { createCasperRpc } from "@cascet/gateway";
import {
  assertAssetAllowed,
  demoConfiguredLimit,
  DemoConfigError,
  demoSeller,
  fetchHostedSupported,
  fundingHint,
  HOSTED_FACILITATOR_URL,
  HOSTED_MIN_FEE_PAYER_MOTES,
  hostedFeePayer,
  hostedFeePayerProblem,
  hostedPreflight,
  HostedPreflightError,
  resolveDemoMode,
  SELF_HOSTED_SETTLE_STYLES,
  selfHostedEnv,
  TESTNET_DEMO_ASSETS,
  type SupportedFetch,
} from "./demo-matrix.js";
import { NETWORKS, readFacilitatorEnv } from "./facilitator-env.js";
import { SETTLEABLE_STYLES } from "./settlement.js";
import { replayFetch, rpcError, rpcResult, type Replay } from "./test-helpers.js";

/** GET https://x402-facilitator.cspr.cloud/supported, recorded 2026-11-01 (no authentication needed). */
const hostedSupported = {
  kinds: [
    { x402Version: 2, scheme: "exact", network: "casper:casper", extra: { feePayer: "d8af1dc245e14a56157c171c614eb099d8aa7ea69f485fe6d48719123c90b033" } },
    { x402Version: 2, scheme: "exact", network: "casper:casper-test", extra: { feePayer: "81d557c9dcaadea97c34d79bf7b6af07aa9d760e5dd1aabf78a45fb39e072c3a" } },
  ],
  extensions: [],
  signers: {
    "casper:*": [
      "d8af1dc245e14a56157c171c614eb099d8aa7ea69f485fe6d48719123c90b033",
      "81d557c9dcaadea97c34d79bf7b6af07aa9d760e5dd1aabf78a45fb39e072c3a",
    ],
  },
};

const KEY = "00000000-0000-4000-8000-000000000000"; // shaped like a CSPR.cloud access key; not a real one

describe("demo-real mode: token and facilitator", () => {
  test("defaults to the original demo: CasCet X402 Token through the self-hosted facilitator", () => {
    const mode = resolveDemoMode({}, []);
    assert.equal(mode.asset.key, "legacy");
    assert.equal(mode.asset.config.authorization, "legacy-amount");
    assert.equal(mode.facilitator, "self");
    assert.equal(mode.hostedApiKey, undefined);
  });

  test("Wrapped CSPR through the hosted facilitator takes the raw CSPR.cloud key", () => {
    const mode = resolveDemoMode({ CASCET_ASSET: "WCSPR", CASCET_FACILITATOR: "hosted", CSPR_CLOUD_TOKEN: ` ${KEY} ` }, []);
    assert.equal(mode.asset.key, "wcspr");
    assert.equal(mode.asset.config.authorization, "cep3009-value");
    assert.equal(mode.facilitator, "hosted");
    assert.equal(mode.hostedApiKey, KEY);
  });

  test("flags win over the environment", () => {
    const mode = resolveDemoMode({ CASCET_ASSET: "legacy", CASCET_FACILITATOR: "self", CSPR_CLOUD_TOKEN: KEY }, ["--asset", "wcspr", "--facilitator=hosted"]);
    assert.equal(mode.asset.key, "wcspr");
    assert.equal(mode.facilitator, "hosted");
    // `pnpm demo-real-wcspr -- --facilitator hosted` runs `run-real.ts --asset wcspr -- --facilitator hosted`
    const viaPnpm = resolveDemoMode({ CSPR_CLOUD_TOKEN: KEY }, ["--asset", "wcspr", "--", "--facilitator", "hosted"]);
    assert.equal(viaPnpm.facilitator, "hosted");
  });

  test("refuses the legacy token on the hosted facilitator (it sends `value`)", () => {
    assert.throws(() => resolveDemoMode({ CASCET_FACILITATOR: "hosted", CSPR_CLOUD_TOKEN: KEY }, []), /User error 64658\. Use CASCET_FACILITATOR=self/);
  });

  test("the hosted facilitator needs a one-line CSPR_CLOUD_TOKEN", () => {
    assert.throws(() => resolveDemoMode({}, ["--asset", "wcspr", "--facilitator", "hosted"]), /needs CSPR_CLOUD_TOKEN/);
    assert.throws(() => resolveDemoMode({ CSPR_CLOUD_TOKEN: "  " }, ["--asset", "wcspr", "--facilitator", "hosted"]), /needs CSPR_CLOUD_TOKEN/);
    assert.throws(() => resolveDemoMode({ CSPR_CLOUD_TOKEN: "Bearer abc" }, ["--asset", "wcspr", "--facilitator", "hosted"]), /one line without spaces/);
  });

  test("settles Wrapped CSPR on the self-hosted facilitator, which sends `value` to cep3009-value tokens", () => {
    assert.equal(SELF_HOSTED_SETTLE_STYLES, SETTLEABLE_STYLES, "the settlement builder's own list, not a copy");
    assert.deepEqual([...SELF_HOSTED_SETTLE_STYLES], ["legacy-amount", "cep3009-value"]);
    const mode = resolveDemoMode({ CASCET_ASSET: "wcspr" }, []);
    assert.equal(mode.facilitator, "self");
    assert.equal(mode.asset.key, "wcspr");
    // A builder without the style's amount argument is still refused before anyone signs.
    assert.throws(
      () => resolveDemoMode({ CASCET_ASSET: "wcspr" }, [], ["legacy-amount"]),
      /does not settle cep3009-value tokens: its settlement builder has no amount argument/,
    );
  });

  test("refuses unknown values and arguments", () => {
    for (const [env, argv] of [
      [{ CASCET_ASSET: "usdc" }, []],
      [{ CASCET_FACILITATOR: "cloud" }, []],
      [{}, ["--asset"]],
      [{}, ["--token", "x"]],
      [{}, ["wcspr"]],
    ] as const) {
      assert.throws(() => resolveDemoMode(env, argv), DemoConfigError, JSON.stringify([env, argv]));
    }
  });
});

describe("demo-real: the gateway config of each mode", () => {
  const seller = `00${"88".repeat(32)}`;
  const base = { name: "casper-defi-data", upstream: { type: "http", url: "http://127.0.0.1:1/mcp" }, network: "casper:casper-test", payTo: seller, pricing: { tools: { t: { price: "$0.01" } } } };

  test("legacy through the self-hosted facilitator resolves as before", () => {
    const cfg = cascetConfigSchema.parse({ ...base, asset: TESTNET_DEMO_ASSETS.legacy.config, facilitator: { url: "http://127.0.0.1:4501" } });
    assert.equal(cfg.asset.authorization, "legacy-amount");
    assert.equal(cfg.asset.packageHash, "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3");
    assert.equal(cfg.asset.name, "CasCet X402 Token");
  });

  test("Wrapped CSPR through the hosted facilitator sends the key raw", () => {
    const cfg = cascetConfigSchema.parse({
      ...base,
      asset: TESTNET_DEMO_ASSETS.wcspr.config,
      facilitator: { url: HOSTED_FACILITATOR_URL, apiKey: KEY, authScheme: "raw" },
    });
    assert.equal(cfg.asset.authorization, "cep3009-value");
    assert.equal(facilitatorAuthorization(facilitatorFor(cfg, cfg.asset)), KEY, "no Bearer prefix");
    assert.equal(usdPriceToTokenUnits("$0.01", cfg.asset), 500_000_000n, "0.5 WCSPR per call, like the legacy token");
  });

  test("the schema itself refuses the legacy token on the hosted facilitator", () => {
    const parsed = cascetConfigSchema.safeParse({ ...base, asset: TESTNET_DEMO_ASSETS.legacy.config, facilitator: { url: HOSTED_FACILITATOR_URL, apiKey: KEY } });
    assert.equal(parsed.success, false);
  });
});

describe("demo-real: seller and self-hosted facilitator environment", () => {
  test("the seller is the first CASCET_SELLER_ACCOUNT_HASH entry or the testnet demo seller", () => {
    assert.equal(demoSeller({}), "00881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36");
    assert.equal(demoSeller({ CASCET_SELLER_ACCOUNT_HASH: ` account-hash-${"ab".repeat(32)} , 00${"cd".repeat(32)}` }), `00${"ab".repeat(32)}`);
    assert.throws(() => demoSeller({ CASCET_SELLER_ACCOUNT_HASH: `hash-${"ab".repeat(32)}` }), DemoConfigError);
  });

  test("the facilitator allowlists the demo token and pins its name unless the operator says otherwise", () => {
    const wcspr = TESTNET_DEMO_ASSETS.wcspr;
    assert.deepEqual(selfHostedEnv({ PORT: "4501" }, wcspr), {
      CASCET_ALLOWED_ASSETS: wcspr.config.packageHash,
      CASCET_TOKEN_NAME: "Wrapped CSPR",
      PORT: "4501",
    });
    assert.equal(selfHostedEnv({ CASCET_ALLOWED_ASSETS: "x", CASCET_TOKEN_NAME: "y" }, wcspr)["CASCET_ALLOWED_ASSETS"], "x");
    assert.doesNotThrow(() => assertAssetAllowed(["3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e"], wcspr));
    assert.throws(() => assertAssetAllowed(["cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3"], wcspr), /does not list Wrapped CSPR/);
  });

  test("an operator's own allowlist is taken as given, without a name pin that several assets refuse", () => {
    const legacyHash = NETWORKS["casper:casper-test"].token;
    const wcsprHash = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";
    const facilitatorEnv = (env: Record<string, string>, asset = TESTNET_DEMO_ASSETS.wcspr) =>
      readFacilitatorEnv(selfHostedEnv(env, asset), "/repo", "casper:casper-test");

    // Both testnet tokens, as run-facilitator recommends: either demo runs, each name pinned by default.
    for (const asset of [TESTNET_DEMO_ASSETS.legacy, TESTNET_DEMO_ASSETS.wcspr]) {
      const both = { CASCET_ALLOWED_ASSETS: `hash-${legacyHash},hash-${wcsprHash}` };
      assert.equal(selfHostedEnv(both, asset)["CASCET_TOKEN_NAME"], undefined);
      const cfg = facilitatorEnv(both, asset);
      assert.doesNotThrow(() => assertAssetAllowed(cfg.allowedAssets, asset));
      assert.deepEqual(
        cfg.assets.map(a => [a.packageHash, a.name]),
        [
          [legacyHash, "CasCet X402 Token"],
          [wcsprHash, "Wrapped CSPR"],
        ],
      );
    }
    // A list without the demo token is refused with "add it"; adding it works.
    const legacyOnly = facilitatorEnv({ CASCET_ALLOWED_ASSETS: legacyHash });
    assert.throws(() => assertAssetAllowed(legacyOnly.allowedAssets, TESTNET_DEMO_ASSETS.wcspr), /add it or unset the variable/);
    assert.doesNotThrow(() => facilitatorEnv({ CASCET_ALLOWED_ASSETS: `${legacyHash},${wcsprHash}` }));
    // The operator's own pins stand; a blank allowlist counts as unset, as the facilitator reads it.
    assert.equal(facilitatorEnv({ CASCET_ALLOWED_ASSETS: wcsprHash, CASCET_TOKEN_NAME: "Wrapped CSPR" }).tokenName, "Wrapped CSPR");
    assert.equal(facilitatorEnv({ CASCET_TOKEN_NAME: "Wrapped CSPR" }).tokenName, "Wrapped CSPR");
    assert.deepEqual(facilitatorEnv({ CASCET_ALLOWED_ASSETS: " " }).allowedAssets, [wcsprHash]);
  });

  test("funding hints name the scripts that fund the buyer", () => {
    const buyer = "65190126b1ca282f041fad6b74b845a3c48e0c8411392b13c640a16a1438faf9";
    assert.equal(
      fundingHint(TESTNET_DEMO_ASSETS.legacy, buyer),
      `pnpm --filter @cascet/e2e fund-token cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3 ${buyer} 5 --send`,
    );
    assert.match(fundingHint(TESTNET_DEMO_ASSETS.wcspr, buyer), /^wrap testnet CSPR first \(pnpm --filter @cascet\/e2e wrap-wcspr 10 --send\), then: pnpm --filter @cascet\/e2e fund-token 3d80df21/);
  });
});

describe("demo-real: hosted facilitator preflight", () => {
  test("finds the testnet fee payer in /supported", () => {
    assert.equal(hostedFeePayer(hostedSupported, "casper:casper-test"), "81d557c9dcaadea97c34d79bf7b6af07aa9d760e5dd1aabf78a45fb39e072c3a");
    assert.equal(hostedFeePayer(hostedSupported, "casper:casper"), "d8af1dc245e14a56157c171c614eb099d8aa7ea69f485fe6d48719123c90b033");
    assert.equal(hostedFeePayer({ kinds: [{ scheme: "upto", network: "casper:casper-test", extra: { feePayer: "aa".repeat(32) } }] }, "casper:casper-test"), undefined);
    assert.equal(hostedFeePayer({ kinds: [{ scheme: "exact", network: "casper:casper-test", extra: { feePayer: "short" } }] }, "casper:casper-test"), undefined);
    assert.equal(hostedFeePayer(null, "casper:casper-test"), undefined);
  });

  test("an underfunded fee payer (2.145 CSPR on 2026-11-01) means hosted testnet settles fail", () => {
    const problem = hostedFeePayerProblem("81d557c9dcaadea97c34d79bf7b6af07aa9d760e5dd1aabf78a45fb39e072c3a", 2_145_235_542n);
    assert.match(problem!, /holds 2\.145 CSPR, less than the 2\.500 CSPR a settle needs, so hosted testnet settles fail until MAKE refills it/);
    assert.equal(hostedFeePayerProblem("81d5", HOSTED_MIN_FEE_PAYER_MOTES), undefined);
    assert.equal(hostedFeePayerProblem("81d5", 100_000_000_000n), undefined);
  });

  test("reads /supported without credentials, with a timeout", async () => {
    const seen: string[] = [];
    const supported = await fetchHostedSupported(`${HOSTED_FACILITATOR_URL}/`, {
      fetchImpl: async (url, init) => {
        seen.push(url);
        assert.ok(init.signal instanceof AbortSignal);
        assert.deepEqual(Object.keys(init), ["signal"], "no Authorization header");
        return { ok: true, status: 200, json: async () => hostedSupported };
      },
    });
    assert.deepEqual(seen, ["https://x402-facilitator.cspr.cloud/supported"]);
    assert.equal(hostedFeePayer(supported, "casper:casper-test")?.slice(0, 8), "81d557c9");
    await assert.rejects(
      fetchHostedSupported(HOSTED_FACILITATOR_URL, { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) }),
      /HTTP 503/,
    );
  });

  describe("hostedPreflight: fails closed before anyone signs", () => {
    const feePayer = "81d557c9dcaadea97c34d79bf7b6af07aa9d760e5dd1aabf78a45fb39e072c3a";
    const supportedOk: SupportedFetch = async () => ({ ok: true, status: 200, json: async () => hostedSupported });
    const node = (balance: Replay, calls: string[] = []) =>
      createCasperRpc("http://node.test/rpc", { fetchImpl: replayFetch({ query_balance: balance }, calls) });

    test("a funded fee payer passes, read from /supported and query_balance", async () => {
      const calls: string[] = [];
      const seen: string[] = [];
      const check = await hostedPreflight({
        rpc: node(rpcResult({ api_version: "2.0.0", balance: "9976860000000" }), calls),
        fetchImpl: async url => {
          seen.push(url);
          return { ok: true, status: 200, json: async () => hostedSupported };
        },
      });
      assert.deepEqual(check, { feePayer, balanceMotes: 9_976_860_000_000n });
      assert.deepEqual(seen, ["https://x402-facilitator.cspr.cloud/supported"]);
      assert.deepEqual(calls, ["query_balance"]);
      const exactly = await hostedPreflight({ rpc: node(rpcResult({ balance: String(HOSTED_MIN_FEE_PAYER_MOTES) })), fetchImpl: supportedOk });
      assert.equal(exactly.balanceMotes, HOSTED_MIN_FEE_PAYER_MOTES);
    });

    test("an underfunded fee payer (2.145 CSPR on 2026-11-01) stops the run", async () => {
      await assert.rejects(
        hostedPreflight({ rpc: node(rpcResult({ balance: "2145235542" })), fetchImpl: supportedOk }),
        (err: unknown) =>
          err instanceof HostedPreflightError &&
          /holds 2\.145 CSPR, less than the 2\.500 CSPR a settle needs, so hosted testnet settles fail until MAKE refills it/.test(err.message),
      );
    });

    test("an unreadable /supported stops the run (no fee-payer check is skipped)", async () => {
      const calls: string[] = [];
      for (const fetchImpl of [
        (async () => ({ ok: false, status: 503, json: async () => ({}) })) as SupportedFetch,
        (async () => Promise.reject(new Error("getaddrinfo ENOTFOUND x402-facilitator.cspr.cloud"))) as SupportedFetch,
        (async () => ({ ok: true, status: 200, json: async () => Promise.reject(new SyntaxError("Unexpected token <")) })) as SupportedFetch,
      ]) {
        await assert.rejects(
          hostedPreflight({ rpc: node(rpcResult({ balance: "9976860000000" }), calls), fetchImpl }),
          (err: unknown) => err instanceof HostedPreflightError && /^cannot read the hosted facilitator's \/supported \(.+\), so its testnet fee payer is unchecked; not paying$/.test(err.message),
        );
      }
      assert.deepEqual(calls, [], "no balance read without a fee payer");
    });

    test("a /supported without a testnet fee payer stops the run", async () => {
      const mainnetOnly = { kinds: hostedSupported.kinds.filter(k => k.network === "casper:casper") };
      await assert.rejects(
        hostedPreflight({ rpc: node(rpcResult({ balance: "1" })), fetchImpl: async () => ({ ok: true, status: 200, json: async () => mainnetOnly }) }),
        (err: unknown) => err instanceof HostedPreflightError && /lists no fee payer for casper:casper-test/.test(err.message),
      );
    });

    test("an unreadable balance stops the run (RPC error, transport failure, malformed answer)", async () => {
      for (const balance of [rpcError(-32003, "Query failed", "purse not found"), new Error("socket hang up"), rpcResult({})] as Replay[]) {
        await assert.rejects(
          hostedPreflight({ rpc: node(balance), fetchImpl: supportedOk }),
          (err: unknown) =>
            err instanceof HostedPreflightError &&
            /^cannot read the CSPR balance of the hosted facilitator's testnet fee payer \(account-hash-81d557c9…\): .+; not paying$/.test(err.message),
        );
      }
    });
  });
});

describe("demo-real: configured gas limits next to the measured suggestions", () => {
  const legacySelf = { facilitator: "self" as const, asset: TESTNET_DEMO_ASSETS.legacy };
  const wcsprSelf = { facilitator: "self" as const, asset: TESTNET_DEMO_ASSETS.wcspr };
  const wcsprHosted = { facilitator: "hosted" as const, asset: TESTNET_DEMO_ASSETS.wcspr };
  const limits = { anchorGasMotes: 2_500_000_000, settlePaymentMotes: 4_200_000_000 };

  test("anchors: anchoring.gasMotes in every mode", () => {
    for (const mode of [legacySelf, wcsprSelf, wcsprHosted]) {
      assert.equal(demoConfiguredLimit({ kind: "anchor" }, mode, limits), 2_500_000_000n);
    }
  });

  test("self-hosted settles: CASCET_SETTLE_PAYMENT_MOTES, else the default of the asset's style", () => {
    assert.equal(demoConfiguredLimit({ kind: "settle", style: "legacy-amount" }, legacySelf, limits), 4_200_000_000n);
    const unset = { anchorGasMotes: 2_500_000_000, settlePaymentMotes: undefined };
    assert.equal(demoConfiguredLimit({ kind: "settle", style: "legacy-amount" }, legacySelf, unset), 4_000_000_000n);
    assert.equal(demoConfiguredLimit({ kind: "settle" }, wcsprSelf, { anchorGasMotes: 1 }), 2_500_000_000n);
  });

  test("hosted settles: none (the hosted facilitator picks its own limit); other kinds: none", () => {
    assert.equal(demoConfiguredLimit({ kind: "settle", style: "cep3009-value" }, wcsprHosted, limits), undefined);
    assert.equal(demoConfiguredLimit({ kind: "wrap" }, legacySelf, limits), undefined);
    assert.equal(demoConfiguredLimit({ kind: "transfer" }, legacySelf, limits), undefined);
    assert.equal(demoConfiguredLimit({ kind: "other", entryPoint: "x" }, legacySelf, limits), undefined);
  });
});
