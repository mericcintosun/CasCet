import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

/** What the fake facilitator answers to one call. */
export interface Reply {
  status?: number;
  /** JSON body. */
  json?: unknown;
  /** Raw body (sent instead of `json`). */
  raw?: string;
  /** Answer after this delay. */
  delayMs?: number;
  /** Never answer (until the server closes). */
  hang?: boolean;
}

export interface FacilitatorCall {
  op: "supported" | "verify" | "settle";
  at: number;
  body?: {
    paymentPayload?: { payload?: { authorization?: Record<string, string> } };
    paymentRequirements?: Record<string, unknown>;
  };
  authorization?: string;
}

export interface FakeFacilitator {
  url: string;
  calls: FacilitatorCall[];
  /** Override to change what /verify answers. */
  onVerify: (call: FacilitatorCall) => Reply | Promise<Reply>;
  /** Override to change what /settle answers. */
  onSettle: (call: FacilitatorCall) => Reply | Promise<Reply>;
  count(op: FacilitatorCall["op"]): number;
  close(): Promise<void>;
}

export const SETTLE_TX = "ab".repeat(32);

/**
 * A local x402 facilitator stand-in: GET /supported, POST /verify, POST /settle.
 * Records every call (and appends "verify"/"settle" to `events` for ordering checks).
 */
export async function startFakeFacilitator(opts: { network?: string; events?: string[] } = {}): Promise<FakeFacilitator> {
  const network = opts.network ?? "casper:casper-test";
  const calls: FacilitatorCall[] = [];
  const sockets = new Set<Socket>();

  const fake: FakeFacilitator = {
    url: "",
    calls,
    onVerify: call => ({ json: { isValid: true, payer: call.body?.paymentPayload?.payload?.authorization?.from } }),
    onSettle: call => ({
      json: {
        success: true,
        transaction: SETTLE_TX,
        network,
        payer: call.body?.paymentPayload?.payload?.authorization?.from,
      },
    }),
    count: op => calls.filter(c => c.op === op).length,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk as Buffer));
    req.on("end", () => {
      void (async () => {
        const path = (req.url ?? "").replace(/\?.*$/, "");
        const op = path === "/supported" ? "supported" : path === "/verify" ? "verify" : path === "/settle" ? "settle" : undefined;
        if (!op) {
          res.writeHead(404).end();
          return;
        }
        let body: FacilitatorCall["body"];
        try {
          body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as FacilitatorCall["body"]) : undefined;
        } catch {
          body = undefined;
        }
        const call: FacilitatorCall = { op, at: Date.now(), body, authorization: req.headers.authorization };
        calls.push(call);
        if (op !== "supported") opts.events?.push(op);
        const reply: Reply =
          op === "supported"
            ? { json: { kinds: [{ x402Version: 2, scheme: "exact", network }], extensions: [], signers: {} } }
            : op === "verify"
              ? await fake.onVerify(call)
              : await fake.onSettle(call);
        if (reply.hang) return;
        if (reply.delayMs) await new Promise(resolve => setTimeout(resolve, reply.delayMs));
        if (res.destroyed) return;
        const text = reply.raw ?? JSON.stringify(reply.json ?? {});
        res.writeHead(reply.status ?? 200, { "content-type": reply.raw === undefined ? "application/json" : "text/html" });
        res.end(text);
      })();
    });
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
