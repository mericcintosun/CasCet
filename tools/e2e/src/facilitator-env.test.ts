import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FacilitatorConfigError, NETWORKS, readFacilitatorEnv, resolveNetwork } from "./facilitator-env.js";
import { checkRoleSeparation, normalizeAccountHash } from "./facilitator-roles.js";

const ROOT = "/repo";
const TOKEN = "f".repeat(64);
const DEPLOYER = NETWORKS["casper:casper"].deployerAccount;
const FEE_PAYER = "ab".repeat(32);
const SELLER = `00${"5e".repeat(32)}`;

describe("key-role separation rules (M07)", () => {
  test("account hashes are normalized from every accepted form", () => {
    const bare = "Cd".repeat(32);
    for (const form of [bare, `00${bare}`, `account-hash-${bare}`, `0x${bare}`]) {
      assert.equal(normalizeAccountHash(form), bare.toLowerCase());
    }
    assert.throws(() => normalizeAccountHash(`01${bare}`));
    assert.throws(() => normalizeAccountHash("hash-abc"));
  });

  test("mainnet: refuses a fee payer that is the owner or a seller", () => {
    const base = { network: "casper:casper", ownerAccountHash: DEPLOYER, sellerAccountHashes: [SELLER] };
    assert.deepEqual(checkRoleSeparation({ ...base, feePayerAccountHash: FEE_PAYER }), { errors: [], warnings: [] });
    assert.match(checkRoleSeparation({ ...base, feePayerAccountHash: DEPLOYER }).errors.join(), /contract owner/);
    assert.match(
      checkRoleSeparation({ ...base, feePayerAccountHash: SELLER.slice(2) }).errors.join(),
      /also a seller/,
    );
    // The old single-key setup trips both rules.
    const old = checkRoleSeparation({ ...base, sellerAccountHashes: [DEPLOYER], feePayerAccountHash: `account-hash-${DEPLOYER.slice(2)}` });
    assert.equal(old.errors.length, 2);
  });

  test("mainnet: the owner account must be known", () => {
    const r = checkRoleSeparation({ network: "casper:casper", feePayerAccountHash: FEE_PAYER, sellerAccountHashes: [SELLER] });
    assert.match(r.errors.join(), /CASCET_OWNER_ACCOUNT_HASH/);
  });

  test("testnet: overlaps are warnings, not errors", () => {
    const r = checkRoleSeparation({
      network: "casper:casper-test",
      feePayerAccountHash: FEE_PAYER,
      ownerAccountHash: FEE_PAYER,
      sellerAccountHashes: [`00${FEE_PAYER}`],
    });
    assert.equal(r.errors.length, 0);
    assert.equal(r.warnings.length, 2);
  });
});

describe("facilitator environment", () => {
  test("network: CASCET_NETWORK or the legacy CASCET_NET, testnet by default", () => {
    assert.equal(resolveNetwork({}), "casper:casper-test");
    assert.equal(resolveNetwork({ CASCET_NET: "mainnet" }), "casper:casper");
    assert.equal(resolveNetwork({ CASCET_NETWORK: "casper:casper" }), "casper:casper");
    assert.equal(resolveNetwork({ CASCET_NETWORK: "casper:casper", CASCET_NET: "mainnet" }), "casper:casper");
    assert.throws(() => resolveNetwork({ CASCET_NETWORK: "casper:casper", CASCET_NET: "testnet" }), /disagree/);
    assert.throws(() => resolveNetwork({ CASCET_NETWORK: "casper:casper-test,casper:casper" }), /exactly one/);
    assert.throws(() => resolveNetwork({ CASCET_NET: "prod" }), FacilitatorConfigError);
  });

  test("mainnet requires a dedicated fee-payer key and a token", () => {
    assert.throws(() => readFacilitatorEnv({ CASCET_NETWORK: "casper:casper", CASCET_FACILITATOR_TOKEN: TOKEN }, ROOT), /CASCET_FACILITATOR_KEY/);
    assert.throws(() => readFacilitatorEnv({ CASCET_NETWORK: "casper:casper", CASCET_FACILITATOR_KEY: "/k.pem" }, ROOT), /CASCET_FACILITATOR_TOKEN/);
  });

  test("mainnet defaults: CasCet token, deployer as owner and seller, 4 CSPR gas limit", () => {
    const cfg = readFacilitatorEnv(
      { CASCET_NETWORK: "casper:casper", CASCET_FACILITATOR_KEY: "/secure/fee.pem", CASCET_FACILITATOR_TOKEN: TOKEN },
      ROOT,
    );
    assert.equal(cfg.rpcUrl, "https://node.mainnet.casper.network/rpc");
    assert.deepEqual(cfg.allowedAssets, [NETWORKS["casper:casper"].token]);
    assert.deepEqual(cfg.allowedPayTo, [DEPLOYER]);
    assert.equal(cfg.ownerAccountHash, DEPLOYER.slice(2));
    assert.equal(cfg.paymentMotes, 4_000_000_000);
    assert.equal(cfg.dailyGasCapMotes, 500_000_000_000n);
    assert.equal(cfg.settleWaitMs, 60_000);
    assert.equal(cfg.preflight, true);
    assert.equal(cfg.tokenVersion, "1");
    assert.equal(cfg.host, "127.0.0.1");
    assert.equal(cfg.port, 4501);
    assert.ok(cfg.warnings.some(w => w.includes("CASCET_SELLER_ACCOUNT_HASH")));
  });

  test("explicit roles, assets and limits are parsed and normalized", () => {
    const cfg = readFacilitatorEnv(
      {
        CASCET_NETWORK: "casper:casper",
        CASCET_FACILITATOR_KEY: "/secure/fee.pem",
        CASCET_FACILITATOR_TOKEN: TOKEN,
        CASCET_SELLER_ACCOUNT_HASH: ` account-hash-${"5E".repeat(32)} , ${SELLER}`,
        CASCET_OWNER_ACCOUNT_HASH: `00${"0e".repeat(32)}`,
        CASCET_ALLOWED_ASSETS: `hash-${"cb".repeat(32)}`,
        CASCET_SETTLE_PAYMENT_MOTES: "3_500_000_000",
        CASCET_DAILY_GAS_CAP_MOTES: "50_000_000_000",
        CASCET_SETTLE_WAIT_MS: "20000",
        CASCET_PREFLIGHT: "off",
        PORT: "8080",
        CASCET_FACILITATOR_HOST: "0.0.0.0",
      },
      ROOT,
    );
    assert.deepEqual(cfg.allowedPayTo, [SELLER, SELLER]);
    assert.equal(cfg.ownerAccountHash, "0e".repeat(32));
    assert.deepEqual(cfg.allowedAssets, ["cb".repeat(32)]);
    assert.equal(cfg.paymentMotes, 3_500_000_000);
    assert.equal(cfg.dailyGasCapMotes, 50_000_000_000n);
    assert.equal(cfg.settleWaitMs, 20_000);
    assert.equal(cfg.preflight, false);
    assert.equal(cfg.port, 8080);
    assert.equal(cfg.host, "0.0.0.0");
    assert.ok(cfg.warnings.some(w => w.includes("CASCET_PREFLIGHT=off")));
    // A generic HOST (set by some shells and containers) never changes the bind address.
    assert.equal(readFacilitatorEnv({ HOST: "0.0.0.0" }, ROOT).host, "127.0.0.1");
  });

  test("gas limit guard rails: never below measured consumption, warn above lane 5", () => {
    const env = { CASCET_FACILITATOR_KEY: "/k.pem" };
    assert.throws(() => readFacilitatorEnv({ ...env, CASCET_SETTLE_PAYMENT_MOTES: "2700000000" }, ROOT), /between 3000000000/);
    assert.throws(() => readFacilitatorEnv({ ...env, CASCET_SETTLE_PAYMENT_MOTES: "4 CSPR" }, ROOT), /whole number/);
    const lane4 = readFacilitatorEnv({ ...env, CASCET_SETTLE_PAYMENT_MOTES: "7000000000" }, ROOT);
    assert.ok(lane4.warnings.some(w => w.includes("lane 4")));
    assert.throws(
      () => readFacilitatorEnv({ ...env, CASCET_DAILY_GAS_CAP_MOTES: "1000" }, ROOT),
      /at least one settle/,
    );
  });

  test("rejects malformed values instead of crashing later (I08)", () => {
    assert.throws(() => readFacilitatorEnv({ PORT: "http" }, ROOT), /PORT/);
    assert.throws(() => readFacilitatorEnv({ PORT: "70000" }, ROOT), /PORT/);
    assert.throws(() => readFacilitatorEnv({ CASCET_SELLER_ACCOUNT_HASH: `01${"aa".repeat(32)}` }, ROOT), /CASCET_SELLER_ACCOUNT_HASH/);
    assert.throws(() => readFacilitatorEnv({ CASCET_PREFLIGHT: "maybe" }, ROOT), /CASCET_PREFLIGHT/);
    assert.throws(() => readFacilitatorEnv({ CASCET_FACILITATOR_KEY_ALGO: "rsa" }, ROOT), /ed25519 or secp256k1/);
    assert.throws(() => readFacilitatorEnv({ CASCET_RPC_URL: "node.testnet.casper.network/rpc" }, ROOT), /CASCET_RPC_URL/);
    assert.throws(() => readFacilitatorEnv({ CASCET_RPC_URL: "ftp://node.example/rpc" }, ROOT), /CASCET_RPC_URL/);
  });

  test("CASCET_RPC_URL: one node of your choice; plain http only to a local node without a warning", () => {
    const local = readFacilitatorEnv({ CASCET_RPC_URL: "http://127.0.0.1:7777/rpc" }, ROOT);
    assert.equal(local.rpcUrl, "http://127.0.0.1:7777/rpc");
    assert.ok(!local.warnings.some(w => w.includes("CASCET_RPC_URL")));
    const remote = readFacilitatorEnv({ CASCET_RPC_URL: "http://203.0.113.7:7777/rpc" }, ROOT);
    assert.ok(remote.warnings.some(w => w.includes("plain http")));
    assert.equal(readFacilitatorEnv({}, ROOT).rpcUrl, NETWORKS["casper:casper-test"].rpcUrl);
  });

  test("testnet keeps the demo defaults but says so", () => {
    const cfg = readFacilitatorEnv({}, ROOT);
    assert.equal(cfg.network, "casper:casper-test");
    assert.equal(cfg.keyPath, "/repo/contracts/keys/deployer_secret_key.pem");
    assert.deepEqual(cfg.allowedPayTo, [NETWORKS["casper:casper-test"].defaultSeller]);
    assert.equal(cfg.ownerAccountHash, undefined);
    assert.equal(cfg.authToken, undefined);
    assert.ok(cfg.warnings.some(w => w.includes("deployer key")));
  });
});
