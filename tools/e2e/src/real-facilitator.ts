import express from "express";
import type { Server } from "node:http";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, Network } from "@x402/core/types";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/facilitator";
import { createFacilitatorCasperSigner } from "@make-software/casper-x402";
import casperSdk from "casper-js-sdk";

/**
 * Self-hosted REAL x402 facilitator for Casper.
 *
 * Why this exists: the hosted CSPR.cloud facilitator
 * (`https://x402-facilitator.cspr.cloud`) runs an outdated build that sends the
 * CEP-18 settlement runtime arg as `value`, while the make-software reference
 * token's `transfer_with_authorization` entry point expects `amount`, so every
 * settle there reverts `User error: 64658` (Odra `ExecutionError::MissingArg`).
 * This facilitator uses `@make-software/casper-x402`, which sends `amount`, and
 * fee-sponsors each settle deploy from a funded Casper key.
 *
 * SECURITY: the fee-sponsor pays real CSPR gas for every settle it submits —
 * even reverted deploys burn gas. An open `/settle` is therefore a direct
 * drain vector (anyone can sign a valid authorization from their own account
 * and flood it). This server defends in depth:
 *   - binds to 127.0.0.1 by default (co-located with the gateway; not remotely
 *     reachable). Set `host: "0.0.0.0"` only with auth + allowlists below.
 *   - optional bearer-token auth on /verify and /settle (the gateway already
 *     sends `facilitator.apiKey` as the Authorization header).
 *   - payTo + asset allowlists: a settle whose payTo/asset is not on the list
 *     is rejected BEFORE any deploy is submitted, so no gas is spent.
 *   - a per-minute rate limit and a daily sponsored-gas cap that trips closed.
 */
export interface RealFacilitatorOptions {
  /** Port to listen on. */
  port: number;
  /** CAIP-2 network id. Defaults to `casper:casper-test`. */
  network?: Network;
  /** Path to the fee-sponsor PEM (submits + pays for each settle deploy). */
  keyPath: string;
  /** Fee-sponsor key algorithm. Defaults to `ed25519`. */
  keyAlgo?: "ed25519" | "secp256k1";
  /** Casper node JSON-RPC URL. Defaults to the public testnet node. */
  rpcUrl?: string;
  /** Gas budget (motes) per settle deploy. Defaults to 7 CSPR. */
  paymentMotes?: number;
  /** Interface to bind. Defaults to 127.0.0.1 (not remotely reachable). */
  host?: string;
  /** If set, require this exact value in the `Authorization` header on /verify + /settle. */
  authToken?: string;
  /** If set, only settle payments whose `payTo` (serialized account-hash Key) is on this list. */
  allowedPayTo?: string[];
  /** If set, only settle payments whose asset (CEP-18 package hash) is on this list. */
  allowedAssets?: string[];
  /** Max settle requests accepted per rolling minute. Default 60. */
  maxSettlesPerMinute?: number;
  /** Daily cap on sponsored gas (motes); the endpoint trips closed past it. Default 500 CSPR. */
  dailyGasCapMotes?: bigint;
}

export interface RealFacilitatorHandle {
  close: () => void;
  /** Base URL to point the gateway's `facilitator.url` at. */
  url: string;
  /** Account-hash hex of the fee-sponsor that submits settle deploys. */
  feePayer: string;
}

const norm = (s: string | undefined): string =>
  (s ?? "").toLowerCase().replace(/^hash-/, "").replace(/^0x/, "");

export async function startRealFacilitator(opts: RealFacilitatorOptions): Promise<RealFacilitatorHandle> {
  const network: Network = opts.network ?? ("casper:casper-test" as Network);
  const rpcUrl = opts.rpcUrl ?? "https://node.testnet.casper.network/rpc";
  const host = opts.host ?? "127.0.0.1";
  const paymentMotes = opts.paymentMotes ?? 7_000_000_000;
  const maxPerMin = opts.maxSettlesPerMinute ?? 60;
  const gasCap = opts.dailyGasCapMotes ?? 500_000_000_000n; // 500 CSPR
  const allowPayTo = opts.allowedPayTo?.map(norm);
  const allowAssets = opts.allowedAssets?.map(norm);

  const algorithm =
    opts.keyAlgo === "secp256k1" ? casperSdk.KeyAlgorithm.SECP256K1 : casperSdk.KeyAlgorithm.ED25519;

  const signer = await createFacilitatorCasperSigner(opts.keyPath, algorithm, rpcUrl);
  const facilitator = new x402Facilitator();
  facilitator.register(network, new ExactCasperScheme(signer, { limitedPaymentMotes: paymentMotes }));

  // --- rate limit + sponsored-gas cap state ---
  let windowStart = 0;
  let windowCount = 0;
  let sponsoredMotes = 0n;
  const rateOk = (nowMs: number): boolean => {
    if (nowMs - windowStart >= 60_000) {
      windowStart = nowMs;
      windowCount = 0;
    }
    windowCount += 1;
    return windowCount <= maxPerMin;
  };

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // Bearer-token auth for the settlement endpoints (skipped if no token configured).
  const requireAuth = (req: express.Request, res: express.Response): boolean => {
    if (!opts.authToken) return true;
    const got = req.header("authorization") ?? "";
    if (got !== opts.authToken) {
      res.status(401).json({ error: "unauthorized" });
      return false;
    }
    return true;
  };

  // Reject settlements to unknown sellers / tokens BEFORE a deploy is submitted.
  const allowlistOk = (reqs: PaymentRequirements | undefined, res: express.Response): boolean => {
    if (allowPayTo && !allowPayTo.includes(norm(reqs?.payTo))) {
      res.status(403).json({ error: "payTo not allowlisted" });
      return false;
    }
    if (allowAssets && !allowAssets.includes(norm(reqs?.asset))) {
      res.status(403).json({ error: "asset not allowlisted" });
      return false;
    }
    return true;
  };

  app.get("/supported", (_req, res) => {
    res.json(facilitator.getSupported());
  });

  app.post("/verify", async (req, res) => {
    if (!requireAuth(req, res)) return;
    try {
      const { paymentPayload, paymentRequirements } = req.body as {
        paymentPayload: PaymentPayload;
        paymentRequirements: PaymentRequirements;
      };
      if (!paymentPayload || !paymentRequirements) {
        return res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
      }
      if (!allowlistOk(paymentRequirements, res)) return;
      res.json(await facilitator.verify(paymentPayload, paymentRequirements));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[real-facilitator] verify error:", message);
      res.status(500).json({ error: message });
    }
  });

  app.post("/settle", async (req, res) => {
    if (!requireAuth(req, res)) return;
    try {
      const { paymentPayload, paymentRequirements } = req.body as {
        paymentPayload: PaymentPayload;
        paymentRequirements: PaymentRequirements;
      };
      if (!paymentPayload || !paymentRequirements) {
        return res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
      }
      // Defence-in-depth, cheapest checks first (no gas spent on rejection):
      if (!allowlistOk(paymentRequirements, res)) return;
      if (!rateOk(Date.now())) return res.status(429).json({ error: "rate limit" });
      if (sponsoredMotes + BigInt(paymentMotes) > gasCap) {
        return res.status(503).json({ error: "daily sponsored-gas cap reached" });
      }
      sponsoredMotes += BigInt(paymentMotes); // reserve the gas we may burn

      const response = await facilitator.settle(paymentPayload, paymentRequirements);
      if (response.success) {
        console.log(`[real-facilitator] ⛓ settled tx=${response.transaction?.slice(0, 12)}…`);
      } else {
        console.error(`[real-facilitator] ✖ settle failed: ${response.errorReason} — ${response.errorMessage ?? ""}`);
      }
      res.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[real-facilitator] settle error:", message);
      res.status(500).json({ error: message });
    }
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  const server = await new Promise<Server>(resolve => {
    const s = app.listen(opts.port, host, () => resolve(s));
  });

  const supported = facilitator.getSupported() as {
    kinds?: Array<{ network?: string; extra?: { feePayer?: string } }>;
  };
  const feePayer = supported.kinds?.find(k => k.network === network)?.extra?.feePayer ?? "unknown";

  console.log(
    `[real-facilitator] listening on http://${host}:${opts.port} (feePayer=${feePayer.slice(0, 12)}…, net=${network}` +
      `, auth=${opts.authToken ? "on" : "off"}, allowlist=${allowPayTo || allowAssets ? "on" : "off"})`,
  );

  return {
    close: () => server.close(),
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${opts.port}`,
    feePayer,
  };
}
