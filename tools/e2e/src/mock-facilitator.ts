import express from "express";
import { randomBytes } from "node:crypto";

/**
 * Mock x402 facilitator for offline development.
 *
 * Implements /supported, /verify and /settle with the same response shapes as
 * the hosted CSPR.cloud facilitator, but never touches a chain: every payload
 * is approved and settlement returns a fake deploy hash. Signature-level
 * correctness is exercised end-to-end on the client side (payloads are still
 * real EIP-712 signatures); on-chain truth arrives when the config switches to
 * the real facilitator.
 */
export function startMockFacilitator(port: number, network = "casper:casper-test") {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const kinds = [1, 2].map(x402Version => ({ x402Version, scheme: "exact", network }));

  app.get("/supported", (_req, res) => {
    res.json({ kinds, extensions: [], signers: {} });
  });

  app.post("/verify", (req, res) => {
    const payer = extractPayer(req.body);
    console.log(`[mock-facilitator] ✔ verify (payer=${payer.slice(0, 12)}…)`);
    res.json({ isValid: true, payer });
  });

  app.post("/settle", (req, res) => {
    const payer = extractPayer(req.body);
    const transaction = randomBytes(32).toString("hex");
    console.log(`[mock-facilitator] ⛓ settle (payer=${payer.slice(0, 12)}…) tx=${transaction.slice(0, 12)}…`);
    res.json({ success: true, transaction, network, payer });
  });

  const server = app.listen(port, () => {
    console.log(`[mock-facilitator] listening on http://localhost:${port}`);
  });
  return { close: () => server.close() };
}

function extractPayer(body: unknown): string {
  const payload = (body as { paymentPayload?: { payload?: Record<string, unknown> } })?.paymentPayload?.payload;
  const auth = payload?.authorization as { from?: string } | undefined;
  return auth?.from ?? (payload?.from as string | undefined) ?? "unknown-payer";
}
