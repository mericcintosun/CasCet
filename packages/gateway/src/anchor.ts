import { readFileSync } from "node:fs";
import casperSdk from "casper-js-sdk";
import type { AnchoringConfig, PaymentReceipt } from "@cascet/core";
import { errorMessage, log, logSafe } from "./log.js";

const { HttpHandler, RpcClient, PrivateKey, KeyAlgorithm, ContractCallBuilder, Args, CLValue } = casperSdk;

/** Execution state of a submitted anchor transaction. */
export type AnchorTxStatus = { state: "pending" } | { state: "executed" } | { state: "failed"; error: string };

/** The chain operations anchoring needs; injectable for tests. */
export interface AnchorChain {
  /** Sign and submit a ReceiptRegistry `record` call; resolves with the transaction hash (hex). */
  submit(receipt: PaymentReceipt): Promise<string>;
  /** Execution status of a submitted transaction. May throw on transient RPC errors. */
  status(txHash: string): Promise<AnchorTxStatus>;
}

/** Casper chain name of a CAIP-2 network: "casper:casper" → "casper", "casper:casper-test" → "casper-test". */
export function chainNameForNetwork(network: string): string {
  const separator = network.indexOf(":");
  return separator >= 0 ? network.slice(separator + 1) : network;
}

/** AnchorChain backed by a Casper node, signing with the configured recorder key. */
export function createCasperAnchorChain(cfg: AnchoringConfig, chainName: string): AnchorChain {
  const rpc = new RpcClient(new HttpHandler(cfg.nodeUrl, "fetch"));
  const algo = cfg.keyAlgo === "secp256k1" ? KeyAlgorithm.SECP256K1 : KeyAlgorithm.ED25519;
  const key = PrivateKey.fromPem(readFileSync(cfg.keyPath, "utf8"), algo);
  const packageHash = cfg.contractPackageHash.replace(/^hash-/, "");

  return {
    async submit(receipt: PaymentReceipt): Promise<string> {
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
        .byPackageHash(packageHash)
        .entryPoint("record")
        .runtimeArgs(args)
        .from(key.publicKey)
        .chainName(chainName)
        .payment(cfg.gasMotes)
        .build();
      tx.sign(key);
      const result = await rpc.putTransaction(tx);
      // TransactionHash is an object (deploy or v1 hash); JSON-stringifying it is not a hash.
      const hex = result.transactionHash.toHex();
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("node accepted the anchor but returned no transaction hash");
      return hex.toLowerCase();
    },

    async status(txHash: string): Promise<AnchorTxStatus> {
      const info = await rpc.getTransactionByTransactionHash(txHash);
      const execution = info.executionInfo;
      if (!execution?.executionResult || !execution.blockHeight) return { state: "pending" };
      const error = execution.executionResult.errorMessage;
      return error ? { state: "failed", error } : { state: "executed" };
    },
  };
}

export interface AnchorerOptions {
  /** Consecutive failures that open the circuit breaker. */
  maxConsecutiveFailures: number;
  /** How long the breaker stays open before one trial anchor is allowed. */
  cooldownMs: number;
  /** How long to wait for a submitted anchor to execute. */
  confirmTimeoutMs: number;
  pollIntervalMs?: number;
  /** Bound for one submit/status RPC call. */
  rpcTimeoutMs?: number;
  maxConcurrent?: number;
  maxQueue?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AnchoringHealth {
  /** closed: anchoring normally. open: paused after repeated failures. half-open: one trial anchor in progress. */
  state: "closed" | "open" | "half-open";
  consecutiveFailures: number;
  queued: number;
  inFlight: number;
  anchored: number;
  failed: number;
  skipped: number;
  lastError?: string;
  openedAt?: string;
}

interface Job {
  receipt: PaymentReceipt;
  onAnchored: (txHash: string) => void;
}

export type EnqueueResult = "queued" | "circuit-open" | "queue-full" | "stopped";

/**
 * Anchors settled receipts in the on-chain ReceiptRegistry.
 *
 * The tool response never waits for this. Each anchor is submitted, then
 * polled until it executes (bounded by `confirmTimeoutMs`); only an executed
 * anchor yields an anchoredTxHash. Every failed attempt still costs gas (Casper
 * charges the whole limit), so after `maxConsecutiveFailures` failures in a row
 * the breaker opens and anchoring pauses; after `cooldownMs` a single trial
 * anchor decides whether it closes again.
 */
export class Anchorer {
  private readonly queue: Job[] = [];
  private inFlight = 0;
  private breaker: AnchoringHealth["state"] = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private anchored = 0;
  private failed = 0;
  private skipped = 0;
  private lastError?: string;
  private stopped = false;
  private idleWaiters: Array<() => void> = [];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;

  constructor(
    private readonly chain: AnchorChain,
    private readonly opts: AnchorerOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms).unref()));
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 15_000;
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 2);
    this.maxQueue = Math.max(1, opts.maxQueue ?? 1_000);
  }

  /** Queue a settled receipt for anchoring; `onAnchored` runs only once the anchor executed. */
  enqueue(receipt: PaymentReceipt, onAnchored: (txHash: string) => void): EnqueueResult {
    if (this.stopped) return "stopped";
    if (this.breaker === "open" && this.now() - this.openedAt < this.opts.cooldownMs) {
      this.skipped++;
      return "circuit-open";
    }
    if (this.queue.length >= this.maxQueue) {
      this.skipped++;
      log.warn(`    anchor queue full (${this.maxQueue}); receipt ${logSafe(receipt.id)} is not anchored`);
      return "queue-full";
    }
    this.queue.push({ receipt, onAnchored });
    this.pump();
    return "queued";
  }

  health(): AnchoringHealth {
    return {
      state: this.breaker,
      consecutiveFailures: this.consecutiveFailures,
      queued: this.queue.length,
      inFlight: this.inFlight,
      anchored: this.anchored,
      failed: this.failed,
      skipped: this.skipped,
      lastError: this.lastError,
      openedAt: this.breaker === "closed" ? undefined : new Date(this.openedAt).toISOString(),
    };
  }

  /** Resolves when nothing is queued or in flight. */
  whenIdle(): Promise<void> {
    if (this.inFlight === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  /** Stop accepting work and drop what is still queued (in-flight anchors finish on their own). */
  stop(): void {
    this.stopped = true;
    this.skipped += this.queue.length;
    this.queue.length = 0;
    this.notifyIdle();
  }

  private gate(): "run" | "trial" | "skip" | "wait" {
    if (this.breaker === "closed") return "run";
    if (this.trialInFlight) return "wait";
    if (this.breaker === "open" && this.now() - this.openedAt < this.opts.cooldownMs) return "skip";
    return "trial";
  }

  private pump(): void {
    while (this.inFlight < this.maxConcurrent && this.queue.length > 0) {
      const gate = this.gate();
      if (gate === "wait") break;
      const job = this.queue.shift()!;
      if (gate === "skip") {
        this.skipped++;
        continue;
      }
      if (gate === "trial") {
        this.breaker = "half-open";
        this.trialInFlight = true;
      }
      this.inFlight++;
      void this.run(job, gate === "trial");
    }
    this.notifyIdle();
  }

  private notifyIdle(): void {
    if (this.inFlight !== 0 || this.queue.length !== 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private async run(job: Job, trial: boolean): Promise<void> {
    let txHash: string | undefined;
    try {
      txHash = await withTimeout(this.chain.submit(job.receipt), this.rpcTimeoutMs, "anchor submit");
      const outcome = await this.waitForExecution(txHash);
      if (outcome.state === "executed") {
        this.onSuccess();
        log.info(`    ⚓ anchored ${logSafe(job.receipt.id)} → ${txHash.slice(0, 12)}…`);
        job.onAnchored(txHash);
      } else if (outcome.state === "failed") {
        this.onFailure(`anchor ${txHash} failed on-chain: ${outcome.error}`, job.receipt.id);
      } else {
        this.onFailure(`anchor ${txHash} not executed within ${this.opts.confirmTimeoutMs} ms`, job.receipt.id);
      }
    } catch (err) {
      this.onFailure(`anchor submit failed: ${errorMessage(err)}`, job.receipt.id);
    } finally {
      this.inFlight--;
      if (trial) this.trialInFlight = false;
      this.pump();
    }
  }

  private async waitForExecution(txHash: string): Promise<AnchorTxStatus | { state: "timeout" }> {
    const deadline = this.now() + this.opts.confirmTimeoutMs;
    for (;;) {
      await this.sleep(this.pollIntervalMs);
      try {
        const status = await withTimeout(this.chain.status(txHash), this.rpcTimeoutMs, "anchor status");
        if (status.state !== "pending") return status;
      } catch {
        // Transient (not yet known to this node, RPC hiccup): keep polling until the deadline.
      }
      if (this.stopped || this.now() >= deadline) return { state: "timeout" };
    }
  }

  private onSuccess(): void {
    this.anchored++;
    this.consecutiveFailures = 0;
    if (this.breaker !== "closed") {
      this.breaker = "closed";
      log.info("    anchoring circuit closed: anchors execute again");
    }
  }

  private onFailure(reason: string, receiptId: string): void {
    this.failed++;
    this.consecutiveFailures++;
    this.lastError = logSafe(reason);
    log.warn(`    anchor for ${logSafe(receiptId)} failed: ${this.lastError}`);
    if (this.breaker === "half-open" || this.consecutiveFailures >= this.opts.maxConsecutiveFailures) {
      if (this.breaker !== "open") {
        log.error(
          `    anchoring paused after ${this.consecutiveFailures} consecutive failures (each one burns gas); ` +
            `next trial in ${Math.round(this.opts.cooldownMs / 1000)} s. Check the recorder key, gas and chain name.`,
        );
      }
      this.breaker = "open";
      this.openedAt = this.now();
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
