import { createInterface } from "node:readline";
import type { PayingFetch } from "./paying-fetch.js";

/**
 * stdio ⇄ paid-HTTP bridge.
 *
 * Runs as a local stdio MCP server for any MCP host (Claude Code, Claude
 * Desktop, Cursor…) and forwards every JSON-RPC message to a CasCet gateway
 * over HTTP. 402 challenges are paid transparently by the wrapped fetch, so
 * the host experiences a normal MCP server while micropayments settle on
 * Casper underneath.
 *
 * stdout carries JSON-RPC only; all logging goes to stderr.
 */
export async function runBridge(gatewayMcpUrl: string, paying: PayingFetch): Promise<void> {
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void forward(trimmed);
  });

  async function forward(raw: string): Promise<void> {
    let id: unknown = null;
    try {
      const parsed = JSON.parse(raw) as { id?: unknown };
      id = parsed.id ?? null;
      const response = await paying.fetch(gatewayMcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: raw,
      });
      if (response.status === 202) return; // notification acknowledged
      const text = await response.text();
      if (!text) return;
      process.stdout.write(`${text}\n`);
    } catch (err) {
      if (id === null || id === undefined) {
        console.error(`[cascet] notification forward failed: ${message(err)}`);
        return;
      }
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32002, message: `CasCet bridge: ${message(err)}` },
        })}\n`,
      );
    }
  }

  // Keep the process alive until the host closes stdin.
  await new Promise<void>(resolvePromise => rl.on("close", resolvePromise));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
