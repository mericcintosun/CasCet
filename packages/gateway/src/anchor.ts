import { readFileSync } from "node:fs";
import casperSdk from "casper-js-sdk";
import type { CascetConfig, PaymentReceipt } from "@cascet/core";

const { HttpHandler, RpcClient, PrivateKey, KeyAlgorithm, ContractCallBuilder, Args, CLValue } = casperSdk;

type AnchoringConfig = NonNullable<CascetConfig["anchoring"]>;

/**
 * Anchors settled receipts into a deployed ReceiptRegistry on Casper.
 *
 * Submission is fire-and-forget from the caller's perspective (the gateway must
 * never make an agent wait on block finality). Each anchor is one `record`
 * entrypoint call, signed by an authorized recorder key. Verified working
 * against the live testnet contract.
 */
export class Anchorer {
  private readonly rpc: InstanceType<typeof RpcClient>;
  private readonly key: InstanceType<typeof PrivateKey>;
  private readonly packageHash: string;

  constructor(private readonly cfg: AnchoringConfig) {
    this.rpc = new RpcClient(new HttpHandler(cfg.nodeUrl, "fetch"));
    const algo = cfg.keyAlgo === "secp256k1" ? KeyAlgorithm.SECP256K1 : KeyAlgorithm.ED25519;
    this.key = PrivateKey.fromPem(readFileSync(cfg.keyPath, "utf8"), algo);
    this.packageHash = cfg.contractPackageHash.replace(/^hash-/, "");
  }

  /** Submit an on-chain anchor for a settled receipt; resolves with the anchor tx hash. */
  async anchor(receipt: PaymentReceipt): Promise<string> {
    const args = Args.fromMap({
      payment_id: CLValue.newCLString(receipt.id),
      parent_id: CLValue.newCLString(receipt.parentId ?? ""),
      payer: CLValue.newCLString(receipt.payer),
      payee: CLValue.newCLString(receipt.payTo),
      amount: CLValue.newCLUInt256(receipt.amountRaw),
      server: CLValue.newCLString(receipt.server),
      tool: CLValue.newCLString(receipt.tool),
      tx_hash: CLValue.newCLString(receipt.txHash ?? ""),
    });

    const tx = new ContractCallBuilder()
      .byPackageHash(this.packageHash)
      .entryPoint("record")
      .runtimeArgs(args)
      .from(this.key.publicKey)
      .chainName(this.cfg.chainName)
      .payment(this.cfg.gasMotes)
      .build();

    tx.sign(this.key);
    const result = await this.rpc.putTransaction(tx);
    return typeof result.transactionHash === "string"
      ? result.transactionHash
      : JSON.stringify(result.transactionHash);
  }
}
