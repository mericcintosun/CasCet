import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PaidMcpHttpClient } from "./mcp-http-client.js";
import { RequestTimeoutError, ResponseTooLargeError } from "./http.js";

describe("PaidMcpHttpClient", () => {
  let server: http.Server;
  let base: string;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", chunk => (body += chunk));
      req.on("end", () => {
        const id = (JSON.parse(body) as { id: number }).id;
        if (req.url === "/hang") return; // never answer
        if (req.url === "/big") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: { pad: "x".repeat(4096) } }));
          return;
        }
        if (req.url === "/unpaid") {
          const header = Buffer.from(JSON.stringify({ x402Version: 2, error: "insufficient_funds", accepts: [] })).toString("base64");
          res.writeHead(402, { "payment-required": header, "content-type": "application/json" }).end("{}");
          return;
        }
        res
          .writeHead(200, { "content-type": "application/json", "x-cascet-payment-id": "pay-1" })
          .end(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }] } }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("calls a tool and returns the payment id", async () => {
    const client = new PaidMcpHttpClient(`${base}/mcp`, fetch);
    const outcome = await client.callTool("get_data", {});
    assert.equal(outcome.paymentId, "pay-1");
    assert.deepEqual(outcome.result, { content: [{ type: "text", text: "ok" }] });
  });

  it("times out a hung gateway with the default-style deadline (M06)", async () => {
    const client = new PaidMcpHttpClient(`${base}/hang`, fetch, { timeoutMs: 150 });
    const started = Date.now();
    await assert.rejects(client.callTool("get_data", {}), (err: Error) => {
      assert.ok(err instanceof RequestTimeoutError, `expected RequestTimeoutError, got ${err.name}: ${err.message}`);
      assert.match(err.message, /MCP tools\/call timed out after 150 ms/);
      return true;
    });
    assert.ok(Date.now() - started < 5_000);
  });

  it("stops when the caller's signal aborts (cascade parent gave up)", async () => {
    const client = new PaidMcpHttpClient(`${base}/hang`, fetch, { timeoutMs: 10_000 });
    const controller = new AbortController();
    const pending = client.callTool("get_data", {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, (err: Error) => {
      assert.equal(err.name, "AbortError");
      return true;
    });
  });

  it("refuses oversized responses", async () => {
    const client = new PaidMcpHttpClient(`${base}/big`, fetch, { maxResponseBytes: 1024 });
    await assert.rejects(client.callTool("get_data", {}), ResponseTooLargeError);
  });

  it("reports the x402 reason of a 402", async () => {
    const client = new PaidMcpHttpClient(`${base}/unpaid`, fetch);
    await assert.rejects(client.callTool("get_data", {}), /HTTP 402 \(insufficient_funds\)/);
  });

  it("validates its options", () => {
    assert.throws(() => new PaidMcpHttpClient(`${base}/mcp`, fetch, { timeoutMs: -1 }), /timeoutMs/);
    assert.throws(() => new PaidMcpHttpClient(`${base}/mcp`, fetch, { maxResponseBytes: 0 }), /maxResponseBytes/);
  });
});
