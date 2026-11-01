import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FacilitatorConfigError, NETWORKS, ownerAccountsFor, readFacilitatorEnv, resolveNetwork } from "./facilitator-env.js";
import { checkRecorderSeparation, checkRoleSeparation, normalizeAccountHash } from "./facilitator-roles.js";

const ROOT = "/repo";
const TOKEN = "f".repeat(64);
const DEPLOYER = NETWORKS["casper:casper"].deployerAccount;
const FEE_PAYER = "ab".repeat(32);
const SELLER = `00${"5e".repeat(32)}`;
/** Official Wrapped CSPR on testnet (cep3009-value). */
const WCSPR = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";

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
    const base = { network: "casper:casper", ownerAccountHashes: [DEPLOYER], sellerAccountHashes: [SELLER] };
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
    const r = checkRoleSeparation({ network: "casper:casper", feePayerAccountHash: FEE_PAYER, ownerAccountHashes: [], sellerAccountHashes: [SELLER] });
    assert.match(r.errors.join(), /CASCET_OWNER_ACCOUNT_HASH/);
  });

  test("mainnet: naming a new owner never drops the deployer (it holds the token's upgrade access)", () => {
    const NEW_OWNER = `00${"0e".repeat(32)}`;
    const cfg = readFacilitatorEnv(
      {
        CASCET_NETWORK: "casper:casper",
        CASCET_FACILITATOR_KEY: "/secure/fee.pem",
        CASCET_FACILITATOR_TOKEN: TOKEN,
        CASCET_OWNER_ACCOUNT_HASH: NEW_OWNER,
        CASCET_SELLER_ACCOUNT_HASH: SELLER,
      },
      ROOT,
    );
    assert.deepEqual(cfg.ownerAccountHashes, ["0e".repeat(32), DEPLOYER.slice(2)]);
    // The review's bypass: the deployer as hot fee payer after ownership moved. Refused.
    const roles = checkRoleSeparation({
      network: "casper:casper",
      feePayerAccountHash: DEPLOYER,
      ownerAccountHashes: cfg.ownerAccountHashes,
      sellerAccountHashes: cfg.allowedPayTo,
    });
    assert.match(roles.errors.join(), /contract owner/);
    assert.deepEqual(ownerAccountsFor("casper:casper-test", []), [], "testnet has no implicit owner");
    assert.deepEqual(ownerAccountsFor("casper:casper", [DEPLOYER, `account-hash-${DEPLOYER.slice(2)}`]), [DEPLOYER.slice(2)]);
  });

  test("mainnet: the anchoring recorder is its own key (not the fee payer, owner or a seller)", () => {
    const RECORDER = "7e".repeat(32);
    const base = { network: "casper:casper", feePayerAccountHash: FEE_PAYER, ownerAccountHashes: [DEPLOYER], sellerAccountHashes: [SELLER] };
    assert.deepEqual(checkRecorderSeparation({ ...base, recorderAccountHash: RECORDER }), { errors: [], warnings: [] });
    assert.match(checkRecorderSeparation({ ...base, recorderAccountHash: `00${FEE_PAYER}` }).errors.join(), /fee-payer/);
    assert.match(checkRecorderSeparation({ ...base, recorderAccountHash: DEPLOYER }).errors.join(), /contract owner/);
    assert.match(checkRecorderSeparation({ ...base, recorderAccountHash: SELLER }).errors.join(), /seller/);
    const testnet = checkRecorderSeparation({ ...base, network: "casper:casper-test", recorderAccountHash: FEE_PAYER });
    assert.deepEqual([testnet.errors.length, testnet.warnings.length], [0, 1]);
  });

  test("testnet: overlaps are warnings, not errors", () => {
    const r = checkRoleSeparation({
      network: "casper:casper-test",
      feePayerAccountHash: FEE_PAYER,
      ownerAccountHashes: [FEE_PAYER],
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

  test("mainnet defaults: CasCet token with its known name, deployer as owner and seller, gas limit per style", () => {
    const cfg = readFacilitatorEnv(
      { CASCET_NETWORK: "casper:casper", CASCET_FACILITATOR_KEY: "/secure/fee.pem", CASCET_FACILITATOR_TOKEN: TOKEN },
      ROOT,
    );
    assert.equal(cfg.rpcUrl, "https://node.mainnet.casper.network/rpc");
    assert.deepEqual(cfg.allowedAssets, [NETWORKS["casper:casper"].token]);
    assert.deepEqual(cfg.allowedPayTo, [DEPLOYER]);
    assert.deepEqual(cfg.ownerAccountHashes, [DEPLOYER.slice(2)]);
    // No limit configured: the facilitator applies the style's default (4 CSPR for CasCet's token) at start-up.
    assert.equal(cfg.paymentMotes, undefined);
    assert.deepEqual(cfg.assets, [{ packageHash: NETWORKS["casper:casper"].token, name: "CasCet X402 Token", version: "1" }]);
    assert.equal(cfg.dailyGasCapMotes, 500_000_000_000n);
    assert.equal(cfg.settleWaitMs, 60_000);
    assert.equal(cfg.preflight, true);
    assert.equal(cfg.preflightDeadlineMs, 10_000);
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
        CASCET_OWNER_ACCOUNT_HASH: `00${"0e".repeat(32)}, account-hash-${"0f".repeat(32)}`,
        CASCET_ALLOWED_ASSETS: `hash-${"cb".repeat(32)}`,
        CASCET_SETTLE_PAYMENT_MOTES: "3_500_000_000",
        CASCET_DAILY_GAS_CAP_MOTES: "50_000_000_000",
        CASCET_SETTLE_WAIT_MS: "20000",
        CASCET_PREFLIGHT_DEADLINE_MS: "5000",
        PORT: "8080",
        CASCET_FACILITATOR_HOST: "0.0.0.0",
      },
      ROOT,
    );
    assert.deepEqual(cfg.allowedPayTo, [SELLER, SELLER]);
    assert.deepEqual(cfg.ownerAccountHashes, ["0e".repeat(32), "0f".repeat(32), DEPLOYER.slice(2)]);
    assert.deepEqual(cfg.allowedAssets, ["cb".repeat(32)]);
    assert.equal(cfg.paymentMotes, 3_500_000_000);
    assert.deepEqual(cfg.assets, [{ packageHash: "cb".repeat(32), version: "1", paymentMotes: 3_500_000_000 }]);
    assert.equal(cfg.dailyGasCapMotes, 50_000_000_000n);
    assert.equal(cfg.settleWaitMs, 20_000);
    assert.equal(cfg.preflight, true);
    assert.equal(cfg.preflightDeadlineMs, 5_000);
    assert.equal(cfg.port, 8080);
    assert.equal(cfg.host, "0.0.0.0");
    assert.equal(cfg.tokenName, undefined, "no default name for a token other than the CasCet one");
    // A generic HOST (set by some shells and containers) never changes the bind address.
    assert.equal(readFacilitatorEnv({ HOST: "0.0.0.0" }, ROOT).host, "127.0.0.1");
  });

  test("the EIP-712 domain name is pinned for the CasCet token; the preflight is required on mainnet", () => {
    const mainnet = { CASCET_NETWORK: "casper:casper", CASCET_FACILITATOR_KEY: "/k.pem", CASCET_FACILITATOR_TOKEN: TOKEN };
    assert.equal(readFacilitatorEnv(mainnet, ROOT).tokenName, "CasCet X402 Token");
    assert.equal(readFacilitatorEnv({}, ROOT).tokenName, "CasCet X402 Token");
    assert.equal(readFacilitatorEnv({ CASCET_TOKEN_NAME: "Other Token" }, ROOT).tokenName, "Other Token");
    assert.throws(() => readFacilitatorEnv({ ...mainnet, CASCET_PREFLIGHT: "off" }, ROOT), /refused on mainnet/);

    const off = readFacilitatorEnv({ CASCET_PREFLIGHT: "off" }, ROOT);
    assert.deepEqual([off.preflight, off.tokenName], [false, "CasCet X402 Token"]);
    assert.ok(off.warnings.some(w => w.includes("CASCET_PREFLIGHT=off")));
    // Another token: its name and its style must be given when nothing reads it on-chain.
    const other = { CASCET_PREFLIGHT: "off", CASCET_ALLOWED_ASSETS: "cb".repeat(32) };
    assert.throws(() => readFacilitatorEnv(other, ROOT), /CASCET_TOKEN_NAME/);
    assert.throws(() => readFacilitatorEnv({ ...other, CASCET_TOKEN_NAME: "Other Token" }, ROOT), /CASCET_ASSET_STYLES .*declare the authorization style/);
    const declared = readFacilitatorEnv({ ...other, CASCET_TOKEN_NAME: "Other Token", CASCET_ASSET_STYLES: `${"cb".repeat(32)}=cep3009-value` }, ROOT);
    assert.equal(declared.tokenName, "Other Token");
    assert.deepEqual(declared.assets, [{ packageHash: "cb".repeat(32), authorization: "cep3009-value", name: "Other Token", version: "1" }]);
  });

  test("gas limit guard rails: never below the style's measured consumption, warn above lane 5", () => {
    const env = { CASCET_FACILITATOR_KEY: "/k.pem" };
    assert.throws(() => readFacilitatorEnv({ ...env, CASCET_SETTLE_PAYMENT_MOTES: "2700000000" }, ROOT), /between 3000000000 .* legacy-amount/);
    assert.throws(() => readFacilitatorEnv({ ...env, CASCET_SETTLE_PAYMENT_MOTES: "4 CSPR" }, ROOT), /whole number/);
    const lane4 = readFacilitatorEnv({ ...env, CASCET_SETTLE_PAYMENT_MOTES: "7000000000" }, ROOT);
    assert.ok(lane4.warnings.some(w => w.includes("lane 4")));
    assert.throws(
      () => readFacilitatorEnv({ ...env, CASCET_DAILY_GAS_CAP_MOTES: "1000" }, ROOT),
      /at least one settle/,
    );
  });

  test("both styles side by side: per-asset styles, names and gas limits", () => {
    const LEGACY = NETWORKS["casper:casper-test"].token;
    const cfg = readFacilitatorEnv(
      {
        CASCET_FACILITATOR_KEY: "/k.pem",
        CASCET_ALLOWED_ASSETS: `hash-${LEGACY}, ${WCSPR}, hash-${LEGACY}`,
        CASCET_ASSET_STYLES: `${WCSPR}=cep3009-value`,
        CASCET_SETTLE_PAYMENT_MOTES_BY_ASSET: `hash-${WCSPR}=2_000_000_000`,
        CASCET_TOKEN_VERSION: "1",
      },
      ROOT,
    );
    assert.deepEqual(cfg.allowedAssets, [LEGACY, WCSPR], "normalized, duplicates dropped");
    assert.deepEqual(cfg.assets, [
      // Known names are pinned by default; the legacy token keeps its style's default limit (resolved at start-up).
      { packageHash: LEGACY, name: "CasCet X402 Token", version: "1" },
      { packageHash: WCSPR, authorization: "cep3009-value", name: "Wrapped CSPR", version: "1", paymentMotes: 2_000_000_000 },
    ]);
    assert.equal(cfg.tokenName, undefined, "no single-asset name with several assets");

    // The default limit applies to every asset without its own, and must suit each one's style.
    const shared = readFacilitatorEnv({ CASCET_ALLOWED_ASSETS: `${LEGACY},${WCSPR}`, CASCET_SETTLE_PAYMENT_MOTES: "5000000000" }, ROOT);
    assert.deepEqual(shared.assets.map(a => a.paymentMotes), [5_000_000_000, 5_000_000_000]);
    assert.throws(
      () => readFacilitatorEnv({ CASCET_ALLOWED_ASSETS: `${LEGACY},${WCSPR}`, CASCET_SETTLE_PAYMENT_MOTES: "2000000000" }, ROOT),
      /between 3000000000 .* legacy-amount/,
    );
    assert.throws(
      () => readFacilitatorEnv({ CASCET_ALLOWED_ASSETS: WCSPR, CASCET_SETTLE_PAYMENT_MOTES_BY_ASSET: `${WCSPR}=1000000000` }, ROOT),
      /CASCET_SETTLE_PAYMENT_MOTES_BY_ASSET .*between 1500000000 .* cep3009-value/,
    );
    // The cap must fit the largest settle.
    assert.throws(
      () =>
        readFacilitatorEnv(
          { CASCET_ALLOWED_ASSETS: WCSPR, CASCET_SETTLE_PAYMENT_MOTES_BY_ASSET: `${WCSPR}=6000000000`, CASCET_DAILY_GAS_CAP_MOTES: "5000000000" },
          ROOT,
        ),
      /at least one settle/,
    );
    // Without the preflight, the known testnet tokens need nothing more.
    const off = readFacilitatorEnv({ CASCET_PREFLIGHT: "off", CASCET_ALLOWED_ASSETS: `${LEGACY},${WCSPR}` }, ROOT);
    assert.deepEqual(off.assets.map(a => a.name), ["CasCet X402 Token", "Wrapped CSPR"]);
  });

  test("per-asset settings are validated against the allowlist", () => {
    const LEGACY = NETWORKS["casper:casper-test"].token;
    const two = { CASCET_ALLOWED_ASSETS: `${LEGACY},${WCSPR}` };
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ CASCET_ASSET_STYLES: `${"dd".repeat(32)}=cep3009-value` }, /CASCET_ASSET_STYLES: dddddddddd… is not in CASCET_ALLOWED_ASSETS/],
      [{ CASCET_ASSET_STYLES: `${WCSPR}=value` }, /neither legacy-amount nor cep3009-value/],
      [{ CASCET_ASSET_STYLES: `${WCSPR}` }, /expected <package hash>=<value>/],
      [{ CASCET_ASSET_STYLES: `${WCSPR}=cep3009-value,hash-${WCSPR}=cep3009-value` }, /listed twice/],
      [{ CASCET_ASSET_STYLES: `${LEGACY}=cep3009-value` }, /CasCet's x402 token, whose transfer_with_authorization takes `amount`/],
      [{ CASCET_ASSET_NAMES: `${WCSPR}=` }, /CASCET_ASSET_NAMES/],
      [{ CASCET_SETTLE_PAYMENT_MOTES_BY_ASSET: `${WCSPR}=lots` }, /whole number/],
      [{ CASCET_TOKEN_NAME: "Wrapped CSPR" }, /CASCET_TOKEN_NAME pins the name of a single allowlisted asset/],
    ];
    for (const [env, error] of cases) assert.throws(() => readFacilitatorEnv({ ...two, ...env }, ROOT), error);
    const named = readFacilitatorEnv({ ...two, CASCET_ASSET_NAMES: `${WCSPR}=Wrapped CSPR (testnet)` }, ROOT);
    assert.equal(named.assets[1]?.name, "Wrapped CSPR (testnet)");
  });

  test("rejects malformed values instead of crashing later (I08)", () => {
    assert.throws(() => readFacilitatorEnv({ PORT: "http" }, ROOT), /PORT/);
    assert.throws(() => readFacilitatorEnv({ PORT: "70000" }, ROOT), /PORT/);
    assert.throws(() => readFacilitatorEnv({ CASCET_SELLER_ACCOUNT_HASH: `01${"aa".repeat(32)}` }, ROOT), /CASCET_SELLER_ACCOUNT_HASH/);
    assert.throws(() => readFacilitatorEnv({ CASCET_PREFLIGHT: "maybe" }, ROOT), /CASCET_PREFLIGHT/);
    assert.throws(() => readFacilitatorEnv({ CASCET_PREFLIGHT_DEADLINE_MS: "100" }, ROOT), /CASCET_PREFLIGHT_DEADLINE_MS/);
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

    // The default mainnet endpoint is load-balanced: say so.
    const mainnet = { CASCET_NETWORK: "casper:casper", CASCET_FACILITATOR_KEY: "/k.pem", CASCET_FACILITATOR_TOKEN: TOKEN };
    const lb = readFacilitatorEnv(mainnet, ROOT);
    assert.equal(lb.rpcUrl, NETWORKS["casper:casper"].rpcUrl);
    assert.ok(lb.warnings.some(w => w.includes("load-balanced")));
    const single = readFacilitatorEnv({ ...mainnet, CASCET_RPC_URL: "https://10.0.0.5:7777/rpc" }, ROOT);
    assert.ok(!single.warnings.some(w => w.includes("load-balanced")));
  });

  test("testnet keeps the demo defaults but says so", () => {
    const cfg = readFacilitatorEnv({}, ROOT);
    assert.equal(cfg.network, "casper:casper-test");
    assert.equal(cfg.keyPath, "/repo/contracts/keys/deployer_secret_key.pem");
    assert.deepEqual(cfg.allowedPayTo, [NETWORKS["casper:casper-test"].defaultSeller]);
    assert.deepEqual(cfg.ownerAccountHashes, []);
    assert.equal(cfg.authToken, undefined);
    assert.ok(cfg.warnings.some(w => w.includes("deployer key")));
  });
});
