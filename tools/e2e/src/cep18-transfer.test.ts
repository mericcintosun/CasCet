import assert from "node:assert/strict";
import { describe, test } from "node:test";
import casperSdk from "casper-js-sdk";
import {
  buildCep18Transfer,
  cep18TransferArgs,
  CEP18_TRANSFER_ARGS,
  DEFAULT_TRANSFER_GAS_MOTES,
  expectedTransferGasMotes,
  RECORDED_TRANSFER_CONSUMED_MOTES,
} from "./cep18-transfer.js";
import { cep18TransferResult } from "./gas-fixtures.js";
import { expectedNetMotes } from "./gas-report.js";

const { TransactionWrapper } = casperSdk;

const recorded = cep18TransferResult.transaction.Version1;
const named = Object.fromEntries(recorded.payload.fields.args.Named);

describe("fund-token: CEP-18 transfer", () => {
  test("rebuilds recorded testnet transfer d299b19b… byte for byte (same hash)", () => {
    const recipient = (named["recipient"]!.parsed as string).replace(/^account-hash-/, "");
    const tx = buildCep18Transfer(recorded.payload.fields.target.Stored.id.ByPackageHash.addr, recipient, BigInt(named["amount"]!.parsed as string), {
      initiatorPublicKey: recorded.payload.initiator_addr.PublicKey,
      chainName: recorded.payload.chain_name,
      paymentMotes: BigInt(recorded.payload.pricing_mode.PaymentLimited.payment_amount),
      ttlMs: 30 * 60_000,
      timestamp: new Date(recorded.payload.timestamp),
    });
    assert.equal(tx.hash.toHex(), recorded.hash);
    const json = TransactionWrapper.toJSON(tx.getTransactionWrapper()) as {
      Version1: { payload: { fields: { args: { Named: Array<[string, { bytes: string; cl_type: unknown }]> } } } };
    };
    const rebuilt = Object.fromEntries(json.Version1.payload.fields.args.Named);
    for (const name of ["recipient", "amount"]) {
      assert.equal(rebuilt[name]?.bytes, named[name]!.bytes, name);
      assert.deepEqual(rebuilt[name]?.cl_type, named[name]!.cl_type, `${name} type`);
    }
    assert.deepEqual(CEP18_TRANSFER_ARGS, [
      ["recipient", "Key"],
      ["amount", "U256"],
    ]);
  });

  test("refuses anything but an account recipient and a positive U256", () => {
    const hash = "14bfcdac542657e71a39a77b72500700021100e280facf627c7d0049cb23ab47";
    assert.throws(() => cep18TransferArgs(`00${hash}`, 1n), /bare 64-hex account hash/);
    assert.throws(() => cep18TransferArgs(`hash-${hash}`, 1n), /bare 64-hex account hash/);
    assert.throws(() => cep18TransferArgs(hash, 0n), /positive U256/);
    assert.throws(() => cep18TransferArgs(hash, 2n ** 256n), /positive U256/);
    assert.throws(
      () => buildCep18Transfer("hash-abc", hash, 1n, { initiatorPublicKey: recorded.payload.initiator_addr.PublicKey, chainName: "casper-test", paymentMotes: 1n }),
      /64-hex contract package hash/,
    );
  });

  test("estimates the gas cost from the recorded consumption", () => {
    assert.equal(RECORDED_TRANSFER_CONSUMED_MOTES >= BigInt(cep18TransferResult.execution_info.execution_result.Version2.consumed), true);
    assert.equal(expectedTransferGasMotes(DEFAULT_TRANSFER_GAS_MOTES), expectedNetMotes(DEFAULT_TRANSFER_GAS_MOTES, RECORDED_TRANSFER_CONSUMED_MOTES));
    assert.equal(expectedTransferGasMotes(DEFAULT_TRANSFER_GAS_MOTES), 1_591_868_350n);
  });
});
