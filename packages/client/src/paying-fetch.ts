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

  let sessionSpent = 0n;

  const client = new x402Client()
    .register("casper:*", new ExactCasperScheme(signer))
    .onBeforePaymentCreation(async ctx => {
      const amount = BigInt(ctx.selectedRequirements.amount);
      const maxPerCall = opts.budget?.maxPerCallRaw ? BigInt(opts.budget.maxPerCallRaw) : undefined;
      const maxSession = opts.budget?.maxSessionRaw ? BigInt(opts.budget.maxSessionRaw) : undefined;
      if (maxPerCall !== undefined && amount > maxPerCall) {
        return { abort: true as const, reason: `price ${amount} exceeds per-call budget ${maxPerCall}` };
      }
      if (maxSession !== undefined && sessionSpent + amount > maxSession) {
        return { abort: true as const, reason: `price ${amount} would exceed session budget ${maxSession}` };
      }
      sessionSpent += amount;
      opts.onPayment?.({
        amountRaw: amount.toString(),
        payTo: ctx.selectedRequirements.payTo,
        network: ctx.selectedRequirements.network,
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
    spentRaw: () => sessionSpent.toString(),
  };
}
