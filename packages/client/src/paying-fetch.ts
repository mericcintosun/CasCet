import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { createClientCasperSigner } from "@make-software/casper-x402";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/client";
import casperSdk from "casper-js-sdk";
import { HEADER_CASCET_PARENT_ID } from "@cascet/core";

const { KeyAlgorithm } = casperSdk;

export interface PayingFetchOptions {
  /** Path to a PEM-encoded Casper private key. */
  privateKeyPath: string;
  keyAlgorithm?: "ed25519" | "secp256k1";
  /**
   * Spending limits in raw CEP-18 token units. Payments exceeding them are
   * aborted before signing — the agent cannot be drained past its budget.
   */
  budget?: {
    maxPerCallRaw?: string;
    maxSessionRaw?: string;
  };
  /**
   * If set, refuse to pay any server whose 402 `payTo` is not on this list.
   * Without it the client signs whatever recipient the (possibly hostile or
   * MITM'd) server dictates — so pin the sellers you actually intend to pay.
   */
  allowedPayTo?: string[];
  /**
   * If set, refuse to pay in any asset (CEP-18 package hash) not on this list.
   * Prevents a malicious 402 from swapping in a more valuable token that also
   * supports transfer_with_authorization and draining it under the raw cap.
   */
  allowedAssets?: string[];
  /**
   * Cascade parent: payment id of the inbound call this agent is serving.
   * Forwarded as X-CASCET-PARENT-ID so downstream receipts join the chain.
   */
  parentId?: string;
  /** Called after each authorized payment (amount in raw token units). */
  onPayment?: (info: { amountRaw: string; payTo: string; network: string }) => void;
}

export interface PayingFetch {
  fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;
  /** Total raw token units authorized this session. */
  spentRaw: () => string;
}

/** Build a fetch that transparently answers x402 challenges with Casper payments. */
export async function createPayingFetch(opts: PayingFetchOptions): Promise<PayingFetch> {
  const algorithm =
    opts.keyAlgorithm === "secp256k1" ? KeyAlgorithm.SECP256K1 : KeyAlgorithm.ED25519;
  const signer = await createClientCasperSigner(opts.privateKeyPath, algorithm);

  const norm = (s: string | undefined): string =>
    (s ?? "").toLowerCase().replace(/^hash-/, "").replace(/^0x/, "");
  const allowPayTo = opts.allowedPayTo?.map(norm);
  const allowAssets = opts.allowedAssets?.map(norm);

  // Track spend PER ASSET so a swapped-in asset can't ride under one raw cap.
  const sessionSpent = new Map<string, bigint>();

  const client = new x402Client()
    .register("casper:*", new ExactCasperScheme(signer))
    .onBeforePaymentCreation(async ctx => {
      const req = ctx.selectedRequirements;
      // Refuse to sign a payment to an unexpected recipient or in an unexpected asset.
      if (allowPayTo && !allowPayTo.includes(norm(req.payTo))) {
        return { abort: true as const, reason: `payTo ${req.payTo} is not allowlisted` };
      }
      if (allowAssets && !allowAssets.includes(norm(req.asset))) {
        return { abort: true as const, reason: `asset ${req.asset} is not allowlisted` };
      }
      const asset = norm(req.asset);
      const amount = BigInt(req.amount);
      const maxPerCall = opts.budget?.maxPerCallRaw ? BigInt(opts.budget.maxPerCallRaw) : undefined;
      const maxSession = opts.budget?.maxSessionRaw ? BigInt(opts.budget.maxSessionRaw) : undefined;
      const spentForAsset = sessionSpent.get(asset) ?? 0n;
      if (maxPerCall !== undefined && amount > maxPerCall) {
        return { abort: true as const, reason: `price ${amount} exceeds per-call budget ${maxPerCall}` };
      }
      if (maxSession !== undefined && spentForAsset + amount > maxSession) {
        return { abort: true as const, reason: `price ${amount} would exceed session budget ${maxSession} for asset ${asset}` };
      }
      sessionSpent.set(asset, spentForAsset + amount);
      opts.onPayment?.({
        amountRaw: amount.toString(),
        payTo: req.payTo,
        network: req.network,
      });
    });

  // NOTE: wrapFetchWithPayment invokes this with a Request object. Passing a
  // fresh `headers` init alongside a Request REPLACES all its headers (dropping
  // content-type), so the parent id is injected by mutating a rebuilt Request.
  const baseFetch: typeof fetch = (input, init) => {
    if (!opts.parentId) return fetch(input, init);
    const request = new Request(input, init);
    request.headers.set(HEADER_CASCET_PARENT_ID, opts.parentId);
    return fetch(request);
  };

  return {
    fetch: wrapFetchWithPayment(baseFetch, client),
    spentRaw: () => {
      let total = 0n;
      for (const v of sessionSpent.values()) total += v;
      return total.toString();
    },
  };
}
