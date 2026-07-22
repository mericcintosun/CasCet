import express from "express";
import type { Server } from "node:http";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, Network } from "@x402/core/types";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/facilitator";
import { createFacilitatorCasperSigner } from "@make-software/casper-x402";
import casperSdk from "casper-js-sdk";

/**
 * Self-hosted REAL x402 facilitator for Casper Testnet.
 *
 * Why this exists: the hosted CSPR.cloud facilitator
 * (`https://x402-facilitator.cspr.cloud`) runs an outdated build that sends the
 * CEP-18 settlement runtime arg as `value`, while the make-software reference
 * token's `transfer_with_authorization` entry point expects `amount`. The token
 * calls `get_named_arg("amount")`, finds nothing, and reverts with Odra
 * `ExecutionError::MissingArg` — surfaced on-chain as `User error: 64658`
 * (Odra encodes framework errors as `64536 + discriminant`; MissingArg = 122).
 * That bug breaks every settle the hosted facilitator attempts, for any token.
 *
 * This facilitator uses the `@make-software/casper-x402` package we already
 * depend on, whose `buildTransferWithAuthorizationArgs` correctly sends
 * `amount`. It fee-sponsors each settle deploy from a funded Casper key
 * (the CasCet deployer) and talks straight to the public node RPC, so real
 * settlement no longer depends on the broken hosted service.
 *
 * Wire-compatible with `startMockFacilitator`: same `/supported`, `/verify`,
 * `/settle` endpoints and the same response shapes the gateway's
 * `HTTPFacilitatorClient` expects.
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
}

export interface RealFacilitatorHandle {
  close: () => void;
  /** Base URL to point the gateway's `facilitator.url` at. */
  url: string;
  /** Account-hash hex of the fee-sponsor that submits settle deploys. */
  feePayer: string;
}

export async function startRealFacilitator(opts: RealFacilitatorOptions): Promise<RealFacilitatorHandle> {
  const network: Network = opts.network ?? ("casper:casper-test" as Network);
  const rpcUrl = opts.rpcUrl ?? "https://node.testnet.casper.network/rpc";
  const algorithm =
    opts.keyAlgo === "secp256k1" ? casperSdk.KeyAlgorithm.SECP256K1 : casperSdk.KeyAlgorithm.ED25519;

  const signer = await createFacilitatorCasperSigner(opts.keyPath, algorithm, rpcUrl);
  const facilitator = new x402Facilitator();
  facilitator.register(
    network,
    new ExactCasperScheme(signer, { limitedPaymentMotes: opts.paymentMotes ?? 7_000_000_000 }),
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/supported", (_req, res) => {
    res.json(facilitator.getSupported());
  });

  app.post("/verify", async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body as {
        paymentPayload: PaymentPayload;
        paymentRequirements: PaymentRequirements;
      };
      if (!paymentPayload || !paymentRequirements) {
        return res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
      }
      res.json(await facilitator.verify(paymentPayload, paymentRequirements));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[real-facilitator] verify error:", message);
      res.status(500).json({ error: message });
    }
  });

  app.post("/settle", async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body as {
        paymentPayload: PaymentPayload;
        paymentRequirements: PaymentRequirements;
      };
      if (!paymentPayload || !paymentRequirements) {
        return res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
      }
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
    const s = app.listen(opts.port, () => resolve(s));
  });

  const supported = facilitator.getSupported() as {
    kinds?: Array<{ network?: string; extra?: { feePayer?: string } }>;
  };
  const feePayer = supported.kinds?.find(k => k.network === network)?.extra?.feePayer ?? "unknown";

  console.log(`[real-facilitator] listening on http://localhost:${opts.port} (feePayer=${feePayer.slice(0, 12)}…, net=${network})`);

  return {
    close: () => server.close(),
    url: `http://localhost:${opts.port}`,
    feePayer,
  };
}
