import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { accountsSignableBy, AccountKeysError, readAccountKeys } from "./account-keys.js";
import { createCasperRpc } from "./casper-rpc.js";
import * as fx from "./rpc-fixtures.js";
import { replayFetch, rpcError } from "./test-helpers.js";

const DEPLOYER = "b9a38c827771d6bc510dd5f1e24fee61acdd4f97f758f4d68fe1dea13a7a140d";
const FEE_PAYER = "fe".repeat(32);
const SELLER = "5e".repeat(32);

/** An account whose associated keys are `keys` (built from the recorded deployer account). */
function accountWith(hash: string, keys: Array<[string, number]>, thresholds = { deployment: 1, key_management: 1 }) {
  const response = structuredClone(fx.mainnetDeployerAccountResponse) as unknown as {
    result: { stored_value: { Account: { account_hash: string; associated_keys: unknown; action_thresholds: unknown } } };
  };
  const account = response.result.stored_value.Account;
  account.account_hash = `account-hash-${hash}`;
  account.associated_keys = keys.map(([h, weight]) => ({ account_hash: `account-hash-${h}`, weight }));
  account.action_thresholds = thresholds;
  return response;
}

const rpcWith = (routes: Record<string, unknown>, calls: string[] = []) =>
  createCasperRpc("http://rpc.invalid", { fetchImpl: replayFetch(routes, calls) });

describe("associated keys (M07)", () => {
  test("reads the recorded mainnet deployer account: one key, thresholds 1/1", async () => {
    const rpc = rpcWith({ [`query_global_state account-hash-${DEPLOYER}`]: fx.mainnetDeployerAccountResponse });
    assert.deepEqual(await readAccountKeys(rpc, `00${DEPLOYER}`), {
      associatedKeys: [{ accountHash: DEPLOYER, weight: 1 }],
      deploymentThreshold: 1,
      keyManagementThreshold: 1,
    });
  });

  test("an account that does not exist has no keys (nothing can sign for it yet)", async () => {
    const rpc = rpcWith({ [`query_global_state account-hash-${SELLER}`]: fx.accountNotFoundResponse });
    assert.equal(await readAccountKeys(rpc, SELLER), undefined);
  });

  test("finds the accounts a hot key can sign for, ignoring the key's own account", async () => {
    const rpc = rpcWith({
      [`query_global_state account-hash-${DEPLOYER}`]: accountWith(DEPLOYER, [[DEPLOYER, 1], [FEE_PAYER, 1]], { deployment: 2, key_management: 2 }),
      [`query_global_state account-hash-${SELLER}`]: accountWith(SELLER, [[SELLER, 1]]),
    });
    assert.deepEqual(await accountsSignableBy(rpc, [`00${DEPLOYER}`, SELLER, FEE_PAYER], `00${FEE_PAYER}`), [DEPLOYER]);
    assert.deepEqual(await accountsSignableBy(rpc, [SELLER], FEE_PAYER), []);
  });

  test("an unreadable answer is an error, never 'no keys'", async () => {
    for (const failure of [rpcError(-32003, "Query failed", "state root hash not available"), new Error("ECONNREFUSED")]) {
      const rpc = rpcWith({ [`query_global_state account-hash-${DEPLOYER}`]: failure });
      await assert.rejects(readAccountKeys(rpc, DEPLOYER), AccountKeysError);
    }
    const entity = rpcWith({
      [`query_global_state account-hash-${DEPLOYER}`]: { jsonrpc: "2.0", id: 1, result: { stored_value: { CLValue: { cl_type: "Key" } } } },
    });
    await assert.rejects(readAccountKeys(entity, DEPLOYER), /not an Account/);
  });

  test("a transport failure is retried once", async () => {
    const calls: string[] = [];
    let n = 0;
    const rpc = rpcWith(
      { [`query_global_state account-hash-${DEPLOYER}`]: () => (++n === 1 ? new Error("socket hang up") : fx.mainnetDeployerAccountResponse) },
      calls,
    );
    assert.equal((await readAccountKeys(rpc, DEPLOYER))?.associatedKeys.length, 1);
    assert.equal(calls.length, 2);
  });
});
