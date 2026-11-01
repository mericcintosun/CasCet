import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCasperRpc, TokenProbe } from "@cascet/gateway";
import {
  describeAssetPolicy,
  MIN_SETTLE_PAYMENT_MOTES_BY_STYLE,
  planAssets,
  resolveAssetPolicies,
  type AssetPlan,
} from "./facilitator-assets.js";
import * as fx from "./rpc-fixtures.js";
import { replayFetch } from "./test-helpers.js";

const NETWORK = "casper:casper-test";
const LEGACY = "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3";
const LEGACY_CONTRACT = "36e657e60199d91d9ace288e573ada1d4c1ab58b1ec6bcd31ae2c0dc62531bd8";
const WCSPR = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";
const WCSPR_CONTRACT = "032706aeae170fafb6403ce3bec58062f1c4288710838fe1df98ce4ff6c35f4a";
const OTHER = "dd".repeat(32);

const legacyKey = (name: string) => fx.testnetContractResponse.result.stored_value.Contract.named_keys.find(k => k.name === name)!.key;
const wcsprKey = (name: string) => fx.wcsprTestnetContractResponse.result.stored_value.Contract.named_keys.find(k => k.name === name)!.key;

/** A token probe over the recorded testnet answers for CasCet's token and Wrapped CSPR (`overrides` on top). */
function recordedProbe(overrides: Record<string, unknown> = {}, calls: string[] = []) {
  const routes: Record<string, unknown> = {
    [`query_global_state hash-${LEGACY}`]: fx.testnetPackageResponse,
    [`query_global_state hash-${LEGACY_CONTRACT}`]: fx.testnetContractResponse,
    [`query_global_state ${legacyKey("name")}`]: fx.testnetNameResponse,
    [`query_global_state ${legacyKey("chain_name")}`]: fx.testnetChainNameResponse,
    [`query_global_state hash-${WCSPR}`]: fx.wcsprTestnetPackageResponse,
    [`query_global_state hash-${WCSPR_CONTRACT}`]: fx.wcsprTestnetContractResponse,
    [`query_global_state ${wcsprKey("name")}`]: fx.wcsprTestnetNameResponse,
    [`query_global_state ${wcsprKey("chain_name")}`]: fx.wcsprTestnetChainNameResponse,
    ...overrides,
  };
  return new TokenProbe(createCasperRpc("http://rpc.invalid", { fetchImpl: replayFetch(routes, calls) }));
}

describe("planning assets (start-up, before any RPC)", () => {
  test("normalizes hashes, applies defaults and the styles CasCet knows", () => {
    const plans = planAssets(
      [{ packageHash: `hash-${LEGACY.toUpperCase()}` }, { packageHash: WCSPR, name: " Wrapped CSPR ", paymentMotes: 2_000_000_000 }, { packageHash: OTHER }],
      { network: NETWORK, preflight: true, defaultVersion: "1" },
    );
    assert.deepEqual(plans, [
      { asset: LEGACY, expectedStyle: "legacy-amount", version: "1" },
      { asset: WCSPR, expectedStyle: "cep3009-value", name: "Wrapped CSPR", version: "1", paymentMotes: 2_000_000_000 },
      { asset: OTHER, version: "1" },
    ]);
  });

  test("refuses what is wrong on its face", () => {
    const plan = (assets: Parameters<typeof planAssets>[0], preflight = true) => () => planAssets(assets, { network: NETWORK, preflight });
    assert.throws(plan([{ packageHash: "hash-123" }]), /assets\[0\]\.packageHash: asset must be a contract package hash/);
    assert.throws(plan([{ packageHash: WCSPR }, { packageHash: `contract-package-${WCSPR}` }]), /assets\[1\]\.packageHash: asset 3d80df21… is listed twice/);
    assert.throws(plan([{ packageHash: OTHER, authorization: "value" as never }]), /must be legacy-amount or cep3009-value/);
    assert.throws(plan([{ packageHash: LEGACY, authorization: "cep3009-value" }]), /takes `amount` \(legacy-amount\)/);
    assert.throws(plan([{ packageHash: OTHER, name: "\u0007bell" }]), /assets\[0\]\.name must be 1 to 100 printable characters/);
    assert.throws(plan([{ packageHash: OTHER, version: "" }]), /assets\[0\]\.version/);
    // Gas floors: the measured consumption of the style (any style's floor while it is unknown).
    assert.throws(plan([{ packageHash: LEGACY, paymentMotes: 2_900_000_000 }]), /between 3000000000 .* legacy-amount/);
    assert.throws(plan([{ packageHash: WCSPR, paymentMotes: 1_400_000_000 }]), /between 1500000000 .* cep3009-value/);
    assert.throws(plan([{ packageHash: OTHER, paymentMotes: 1_400_000_000 }]), /between 1500000000 and 100000000000:/);
    assert.throws(plan([{ packageHash: OTHER, paymentMotes: 100_000_000_001 }]), /between/);
    assert.deepEqual(MIN_SETTLE_PAYMENT_MOTES_BY_STYLE, { "legacy-amount": 3_000_000_000, "cep3009-value": 1_500_000_000 });
  });

  test("without the preflight, every asset's style and name must be pinned", () => {
    const off = (assets: Parameters<typeof planAssets>[0]) => () => planAssets(assets, { network: NETWORK, preflight: false });
    assert.throws(off([{ packageHash: WCSPR }]), /pin the EIP-712 domain name/);
    assert.throws(off([{ packageHash: OTHER, name: "Other" }]), /declare the authorization style/);
    assert.deepEqual(off([{ packageHash: OTHER, name: "Other", authorization: "cep3009-value" }])(), [
      { asset: OTHER, expectedStyle: "cep3009-value", name: "Other", version: "1" },
    ]);
  });
});

describe("resolving assets against the chain (recorded testnet answers)", () => {
  const plansOf = (...assets: Parameters<typeof planAssets>[0]) => planAssets(assets, { network: NETWORK, preflight: true });

  test("reads each token's ABI, chain_name and name; pins style, name and the style's gas limit", async () => {
    const calls: string[] = [];
    const policies = await resolveAssetPolicies(plansOf({ packageHash: LEGACY }, { packageHash: WCSPR, paymentMotes: 2_000_000_000 }), {
      network: NETWORK,
      probe: recordedProbe({}, calls),
    });
    assert.deepEqual(policies, [
      { asset: LEGACY, style: "legacy-amount", name: "CasCet X402 Token", version: "1", paymentMotes: 4_000_000_000n },
      { asset: WCSPR, style: "cep3009-value", name: "Wrapped CSPR", version: "1", paymentMotes: 2_000_000_000n },
    ]);
    // Package → newest enabled contract (Wrapped CSPR: version 8 of 8, seven disabled) → named keys.
    assert.ok(calls.includes(`query_global_state hash-${WCSPR_CONTRACT}`));
    assert.equal(describeAssetPolicy(policies[1]!), 'asset 3d80df21…: cep3009-value (`value`), name "Wrapped CSPR", version "1", gas limit 2000000000 motes');
  });

  test("a token CasCet does not know is settled in the style its ABI shows", async () => {
    // A hypothetical CEP-3009 token: Wrapped CSPR's recorded contract under another package hash.
    const pkg = structuredClone(fx.wcsprTestnetPackageResponse);
    const [policy] = await resolveAssetPolicies(plansOf({ packageHash: OTHER }), {
      network: NETWORK,
      probe: recordedProbe({ [`query_global_state hash-${OTHER}`]: pkg }),
    });
    assert.deepEqual(policy, { asset: OTHER, style: "cep3009-value", name: "Wrapped CSPR", version: "1", paymentMotes: 3_500_000_000n });
  });

  test("refuses a configured style, name or chain the token contradicts", async () => {
    await assert.rejects(
      resolveAssetPolicies(plansOf({ packageHash: WCSPR, authorization: "legacy-amount" }), { network: NETWORK, probe: recordedProbe() }),
      /configured as legacy-amount \(`amount`\), but its transfer_with_authorization takes `value` \(cep3009-value\)/,
    );
    await assert.rejects(
      resolveAssetPolicies(plansOf({ packageHash: LEGACY, name: "CasCet Token" }), { network: NETWORK, probe: recordedProbe() }),
      /pinned EIP-712 name "CasCet Token" is not the token's on-chain name "CasCet X402 Token"/,
    );
    await assert.rejects(
      resolveAssetPolicies(plansOf({ packageHash: LEGACY }), { network: "casper:casper", probe: recordedProbe() }),
      /signs for chain_name "casper:casper-test", not casper:casper/,
    );
  });

  test("refuses a token it cannot settle, and a chain it cannot read", async () => {
    const noEntryPoint = structuredClone(fx.testnetContractResponse) as unknown as { result: { stored_value: { Contract: { entry_points: unknown[] } } } };
    noEntryPoint.result.stored_value.Contract.entry_points = [];
    await assert.rejects(
      resolveAssetPolicies(plansOf({ packageHash: LEGACY }), {
        network: NETWORK,
        probe: recordedProbe({ [`query_global_state hash-${LEGACY_CONTRACT}`]: noEntryPoint }),
      }),
      /asset cb65a928… cannot be settled: .*neither `amount` nor `value`/,
    );
    await assert.rejects(
      resolveAssetPolicies(plansOf({ packageHash: OTHER }), { network: NETWORK, probe: recordedProbe({ [`query_global_state hash-${OTHER}`]: fx.testnetUnusedNonceResponse }) }),
      /asset dddddddd… cannot be settled/,
    );
    await assert.rejects(
      resolveAssetPolicies(plansOf({ packageHash: LEGACY }), {
        network: NETWORK,
        probe: recordedProbe({ [`query_global_state hash-${LEGACY}`]: new Error("ECONNREFUSED") }),
      }),
      /could not read asset cb65a928… on-chain .*check CASCET_RPC_URL/,
    );
  });

  test("a token without a name named key keeps no name pin, and the operator is told", async () => {
    const contract = structuredClone(fx.wcsprTestnetContractResponse) as unknown as {
      result: { stored_value: { Contract: { named_keys: Array<{ name: string; key: string }> } } };
    };
    contract.result.stored_value.Contract.named_keys = contract.result.stored_value.Contract.named_keys.filter(k => k.name !== "name");
    const warnings: string[] = [];
    const [policy] = await resolveAssetPolicies(plansOf({ packageHash: WCSPR }), {
      network: NETWORK,
      probe: recordedProbe({ [`query_global_state hash-${WCSPR_CONTRACT}`]: contract }),
      warn: m => warnings.push(m),
    });
    assert.equal(policy?.name, undefined);
    assert.ok(warnings.some(w => w.includes("no on-chain name")));
  });

  test("without the preflight, the pinned style and name are used as they are", async () => {
    const plans: AssetPlan[] = planAssets([{ packageHash: WCSPR, name: "Wrapped CSPR" }], { network: NETWORK, preflight: false });
    assert.deepEqual(await resolveAssetPolicies(plans, { network: NETWORK }), [
      { asset: WCSPR, style: "cep3009-value", name: "Wrapped CSPR", version: "1", paymentMotes: 3_500_000_000n },
    ]);
  });
});
