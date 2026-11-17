import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AnchorChain } from "./anchor.js";
import { LATEST_PROTOCOL_VERSION } from "./protocol.js";
import { startGateway } from "./server.js";
import { ENV_UPSTREAM_FIXTURE, osBaselineEnvironment } from "./testing/env.js";
import { startFakeFacilitator } from "./testing/fake-facilitator.js";
import {
  callPaid,
  eventually,
  payFor,
  receipts,
  rpcCall,
  startHarness,
  testConfig,
  type Harness,
} from "./testing/harness.js";

async function withHarness(opts: Parameters<typeof startHarness>[0], run: (h: Harness) => Promise<void>): Promise<void> {
  const h = await startHarness(opts);
  try {
    await run(h);
  } finally {
    await h.close();
  }
}

describe("network exposure (M36)", () => {
  it("listens on 127.0.0.1 by default", async () => {
    await withHarness({}, async h => {
      assert.equal(h.gateway.host, "127.0.0.1");
      assert.match(h.gateway.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    });
  });

  it("refuses requests from an origin that is not allowlisted with 403, before anything runs", async () => {
    await withHarness({}, async h => {
      const evil = { origin: "https://evil.example" };
      const call = await h.rpc("tools/call", { name: "free_tool", arguments: {} }, evil);
      assert.equal(call.status, 403);
      assert.equal(h.upstream.calls.length, 0);
      assert.equal((await fetch(`${h.base}/health`, { headers: evil })).status, 403);
      const preflight = await fetch(h.gateway.url, {
        method: "OPTIONS",
        headers: { ...evil, "access-control-request-method": "POST" },
      });
      assert.equal(preflight.status, 403);
      assert.equal(preflight.headers.get("access-control-allow-origin"), null);
      assert.equal((await fetch(`${h.base}/health`, { headers: { origin: "null" } })).status, 403);
    });
  });

  it("sends no CORS headers to clients without an Origin", async () => {
    await withHarness({}, async h => {
      const res = await h.rpc("tools/list");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    });
  });

  it("reflects only allowlisted origins, never *", async () => {
    await withHarness({ config: { cors: { allowedOrigins: ["https://app.example"] } } }, async h => {
      const ok = await h.rpc("tools/list", undefined, { origin: "https://app.example" });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.example");
      assert.match(ok.headers.get("vary") ?? "", /origin/i);
      assert.match(ok.headers.get("access-control-expose-headers") ?? "", /PAYMENT-REQUIRED/);
      const preflight = await fetch(h.gateway.url, {
        method: "OPTIONS",
        headers: { origin: "https://app.example", "access-control-request-method": "POST" },
      });
      assert.equal(preflight.status, 204);
      assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /PAYMENT-SIGNATURE/i);
      const other = await h.rpc("tools/list", undefined, { origin: "https://app.example.evil" });
      assert.equal(other.status, 403);
    });
  });
});

describe("start-up log", () => {
  it("begins every line it prints on stdout with plain ASCII", async () => {
    // The Node 22 test runner reads bytes 2-5 of output that directly follows one of its own messages as the next
    // message's length; a byte above 0x7f there makes it negative and fails the whole test file ("Unable to
    // deserialize cloned data"). Gateways start inside test files, here and in tools/e2e.
    const lines: string[] = [];
    const spy = mock.method(console, "log", (format: unknown, ...rest: unknown[]) => {
      lines.push(format === "%s" ? String(rest[0]) : [format, ...rest].map(String).join(" "));
    });
    const chain: AnchorChain = { submit: async () => "ab".repeat(32), status: async () => ({ state: "executed" }) };
    const anchoring = { contractPackageHash: `hash-${"99".repeat(32)}`, keyPath: "/nonexistent/recorder.pem", nodeUrl: "http://127.0.0.1:9/rpc" };
    let h: Harness | undefined;
    try {
      h = await startHarness({ config: { anchoring }, gateway: { anchorChain: chain } });
    } finally {
      spy.mock.restore();
    }
    try {
      assert.ok(lines.some(line => line.includes("listening on")), "the start-up lines were captured");
      for (const line of lines) assert.match(line, /^[\x20-\x7e]{6}/, `a line that starts with plain ASCII: ${line}`);
    } finally {
      await h.close();
    }
  });
});

describe("upstream environment (M34)", () => {
  it("starts the configured stdio upstream without the gateway's environment", async () => {
    process.env.CASCET_TEST_SECRET = "s3cret";
    process.env.CASCET_INGEST_TOKEN = "ingest-secret";
    const facilitator = await startFakeFacilitator();
    const dir = mkdtempSync(join(tmpdir(), "cascet-env-test-"));
    try {
      const cfg = testConfig({
        facilitator: { url: facilitator.url },
        upstream: { type: "stdio", command: process.execPath, args: [ENV_UPSTREAM_FIXTURE], env: { ALLOWED_VAR: "yes" } },
        pricing: { tools: {}, freeTools: ["env"] },
      });
      const gateway = await startGateway(cfg, { receiptsPath: join(dir, "receipts.jsonl"), preemptionChecker: null });
      try {
        const res = await rpcCall(gateway.url, "tools/call", { name: "env", arguments: {} });
        const env = JSON.parse(res.body.result?.content?.[0]?.text ?? "{}") as { names: string[]; allowed: string | null };
        assert.equal(env.allowed, "yes");
        assert.ok(!env.names.includes("CASCET_TEST_SECRET"), "gateway secrets must not reach the upstream");
        assert.ok(!env.names.includes("CASCET_INGEST_TOKEN"), "gateway secrets must not reach the upstream");
        const permitted = new Set([...Object.keys(getDefaultEnvironment()), ...osBaselineEnvironment(), "ALLOWED_VAR"]);
        for (const name of env.names) assert.ok(permitted.has(name), `unexpected variable ${name} in the upstream environment`);
      } finally {
        await gateway.close();
      }
    } finally {
      delete process.env.CASCET_TEST_SECRET;
      delete process.env.CASCET_INGEST_TOKEN;
      await facilitator.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hidden and unknown tools (M11)", () => {
  it("lists only priced tools and tools in pricing.freeTools", async () => {
    await withHarness({}, async h => {
      const res = await h.rpc("tools/list");
      const tools = res.body.result?.tools ?? [];
      assert.deepEqual(tools.map(t => t.name).sort(), ["free_tool", "paid_tool"]);
      const paid = tools.find(t => t.name === "paid_tool") as { description?: string; _meta?: { cascet?: { priceUsd?: string } } };
      assert.match(paid.description ?? "", /\[PAID: \$0\.01 per call/);
      assert.equal(paid._meta?.cascet?.priceUsd, "$0.01");
    });
  });

  it("refuses unpriced, unlisted and non-existent tools without touching the upstream", async () => {
    await withHarness({}, async h => {
      for (const name of ["secret_tool", "no_such_tool", "constructor", "__proto__"]) {
        const res = await h.rpc("tools/call", { name, arguments: {} });
        assert.equal(res.status, 200);
        assert.equal(res.body.error?.code, -32602);
        assert.match(res.body.error?.message ?? "", /^Unknown tool: /);
      }
      assert.equal(h.upstream.calls.length, 0);
      assert.equal(h.facilitator.count("verify"), 0);
    });
  });

  it("serves free tools without payment", async () => {
    await withHarness({}, async h => {
      const res = await h.rpc("tools/call", { name: "free_tool", arguments: { x: 1 } });
      assert.equal(res.status, 200);
      assert.equal(res.body.result?.content?.[0]?.text, "ok:free_tool");
      assert.deepEqual(h.upstream.calls[0], { name: "free_tool", args: { x: 1 }, meta: undefined });
    });
  });

  it("prices every other tool with pricing.default", async () => {
    await withHarness({ config: { pricing: { default: { price: "$0.02" }, freeTools: ["free_tool"] } } }, async h => {
      const res = await h.rpc("tools/list");
      assert.deepEqual((res.body.result?.tools ?? []).map(t => t.name).sort(), ["free_tool", "paid_tool", "secret_tool"]);
      assert.equal((await h.rpc("tools/call", { name: "secret_tool", arguments: {} })).status, 402);
      assert.equal((await h.rpc("tools/call", { name: "free_tool", arguments: {} })).status, 200);
    });
  });

  it("maps upstream errors on free tools to JSON-RPC errors with HTTP 200", async () => {
    await withHarness(
      {
        tools: [
          {
            name: "free_tool",
            handler: () => {
              throw new Error("kaput");
            },
          },
          { name: "paid_tool" },
        ],
      },
      async h => {
        const res = await h.rpc("tools/call", { name: "free_tool", arguments: {} });
        assert.equal(res.status, 200);
        assert.equal(res.body.error?.code, -32603);
        assert.match(res.body.error?.message ?? "", /kaput/);
      },
    );
  });
});

describe("protocol version negotiation", () => {
  it("reports the package version and no listChanged promise it cannot keep", async () => {
    await withHarness({}, async h => {
      const result = (await h.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }))
        .body.result as { serverInfo: { version: string }; capabilities: { tools: { listChanged: boolean } } };
      assert.match(result.serverInfo.version, /^\d+\.\d+\.\d+/);
      assert.notEqual(result.serverInfo.version, "0.0.0");
      assert.equal(result.capabilities.tools.listChanged, false);
    });
  });

  it("answers with the client's version when supported, else the latest supported one", async () => {
    await withHarness({}, async h => {
      const negotiate = async (protocolVersion?: string) =>
        (await h.rpc("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "t", version: "1" } })).body.result
          ?.protocolVersion;
      assert.equal(await negotiate("2025-06-18"), "2025-06-18");
      assert.equal(await negotiate("2025-03-26"), "2025-03-26");
      assert.equal(await negotiate(LATEST_PROTOCOL_VERSION), LATEST_PROTOCOL_VERSION);
      assert.equal(await negotiate("1999-01-01"), LATEST_PROTOCOL_VERSION);
      assert.equal(await negotiate("2025-06-18\n<script>"), LATEST_PROTOCOL_VERSION);
      assert.equal(await negotiate(undefined), LATEST_PROTOCOL_VERSION);
    });
  });

  it("rejects an unsupported MCP-Protocol-Version header with 400", async () => {
    await withHarness({}, async h => {
      const bad = await h.rpc("tools/list", undefined, { "mcp-protocol-version": "1999-01-01" });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error?.code, -32600);
      const good = await h.rpc("tools/list", undefined, { "mcp-protocol-version": "2025-06-18" });
      assert.equal(good.status, 200);
    });
  });
});

describe("upstream tool list (M37)", () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ name: `tool_${i}` }));
  const allPriced = { pricing: { default: { price: "$0.01" } } };

  it("follows nextCursor across every tools/list page", async () => {
    await withHarness({ tools: many, pageSize: 2, config: allPriced }, async h => {
      const res = await h.rpc("tools/list");
      assert.deepEqual((res.body.result?.tools ?? []).map(t => t.name), many.map(t => t.name));
      assert.equal(h.upstream.listRequests, 4);
      const last = await h.rpc("tools/call", { name: "tool_6", arguments: {} });
      assert.equal(last.status, 402, "a tool on the last page is priced, not free");
    });
  });

  it("rebuilds the tool table when the upstream sends tools/list_changed", async () => {
    await withHarness({ tools: many, pageSize: 3, config: allPriced }, async h => {
      h.upstream.addTool({ name: "tool_new" });
      await h.upstream.notifyToolsChanged();
      await eventually(async () => {
        const res = await h.rpc("tools/list");
        return (res.body.result?.tools ?? []).some(t => t.name === "tool_new");
      }, 3_000, "the new tool to be listed");
      const { header } = await payFor(h, "tool_new");
      const paid = await callPaid(h, "tool_new", header);
      assert.equal(paid.status, 200);
      assert.equal(paid.body.result?.content?.[0]?.text, "ok:tool_new");
    });
  });

  it("does not lose a tools/list_changed that arrives while the first listing is still running", async () => {
    await withHarness(
      {
        config: allPriced,
        onUpstream: upstream => {
          upstream.afterListPage = n => {
            if (n !== 1) return;
            // The page being returned is already stale when this notification goes out.
            upstream.addTool({ name: "late_tool" });
            return upstream.notifyToolsChanged();
          };
        },
      },
      async h => {
        await eventually(
          async () => ((await h.rpc("tools/list")).body.result?.tools ?? []).some(t => t.name === "late_tool"),
          3_000,
          "late_tool to be listed",
        );
      },
    );
  });

  it("rejects a cursor it never issued", async () => {
    await withHarness({}, async h => {
      const res = await h.rpc("tools/list", { cursor: "abc" });
      assert.equal(res.body.error?.code, -32602);
    });
  });
});

/** A dashboard stand-in that records the events a gateway pushes. */
async function startEventSink(): Promise<{ url: string; types: string[]; close: () => Promise<void> }> {
  const types: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk as Buffer));
    req.on("end", () => {
      types.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { type: string }).type);
      res.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ingest`,
    types,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

describe("anchoring (M38)", () => {
  const anchoring = {
    contractPackageHash: `hash-${"99".repeat(32)}`,
    keyPath: "/nonexistent/recorder.pem",
    nodeUrl: "http://127.0.0.1:9/rpc",
  };

  it("stores the anchor's hex hash once it executed", async () => {
    const chain: AnchorChain = {
      submit: async () => "ab".repeat(32),
      status: async () => ({ state: "executed" }),
    };
    await withHarness({ config: { anchoring }, gateway: { anchorChain: chain, anchorPollIntervalMs: 1 } }, async h => {
      const { header } = await payFor(h, "paid_tool");
      assert.equal((await callPaid(h, "paid_tool", header)).status, 200);
      await eventually(async () => (await receipts(h))[0]?.anchoredTxHash === "ab".repeat(32), 3_000, "the anchor hash");
      const health = (await (await fetch(`${h.base}/health`)).json()) as { status: string; anchoring: { state: string; anchored: number } };
      assert.equal(health.status, "ok");
      assert.deepEqual([health.anchoring.state, health.anchoring.anchored], ["closed", 1]);
    });
  });

  it("reports a paused (open) anchoring circuit as degraded in /health", async () => {
    const chain: AnchorChain = {
      submit: async () => "cd".repeat(32),
      status: async () => ({ state: "failed", error: "User error: 1 (Unauthorized)" }),
    };
    await withHarness(
      { config: { anchoring: { ...anchoring, maxConsecutiveFailures: 2 } }, gateway: { anchorChain: chain, anchorPollIntervalMs: 1 } },
      async h => {
        for (let i = 0; i < 2; i++) {
          const { header } = await payFor(h, "paid_tool");
          assert.equal((await callPaid(h, "paid_tool", header)).status, 200, "anchoring never blocks a paid call");
        }
        await eventually(
          async () => ((await (await fetch(`${h.base}/health`)).json()) as { anchoring: { state: string } }).anchoring.state === "open",
          3_000,
          "the anchoring circuit to open",
        );
        const health = (await (await fetch(`${h.base}/health`)).json()) as { status: string; anchoring: { lastError: string } };
        assert.equal(health.status, "degraded");
        assert.match(health.anchoring.lastError, /Unauthorized/);
        assert.equal((await receipts(h)).some(r => r.anchoredTxHash !== undefined), false, "failed anchors are never recorded");
      },
    );
  });
});

describe("upstream loss (M39)", () => {
  it("pushes server-offline when the upstream is lost and server-online when it is back", async () => {
    const sink = await startEventSink();
    try {
      await withHarness(
        { config: { eventsUrl: sink.url }, gateway: { reconnect: { maxAttempts: 50, baseDelayMs: 20, maxDelayMs: 40 } } },
        async h => {
          await eventually(() => sink.types.includes("server-online"), 3_000, "server-online at start");
          h.upstream.failConnections = true;
          await h.upstream.crash();
          await eventually(() => sink.types.includes("server-offline"), 3_000, "server-offline");
          h.upstream.failConnections = false;
          await eventually(() => sink.types.lastIndexOf("server-online") > sink.types.indexOf("server-offline"), 3_000, "server-online again");
        },
      );
    } finally {
      await sink.close();
    }
  });

  it("answers 503 on /health and refuses calls while the upstream is down, then recovers", async () => {
    await withHarness({ gateway: { reconnect: { maxAttempts: 50, baseDelayMs: 20, maxDelayMs: 40 } } }, async h => {
      h.upstream.failConnections = true;
      await h.upstream.crash();
      await eventually(async () => (await fetch(`${h.base}/health`)).status === 503, 3_000, "/health to report 503");
      const health = (await (await fetch(`${h.base}/health`)).json()) as { status: string; upstream: { state: string } };
      assert.equal(health.status, "unavailable");
      assert.equal(health.upstream.state, "reconnecting");
      const call = await h.rpc("tools/call", { name: "paid_tool", arguments: {} });
      assert.equal(call.status, 503, "no 402 challenge for a call that cannot run");
      h.upstream.failConnections = false;
      await eventually(async () => (await fetch(`${h.base}/health`)).status === 200, 3_000, "/health to recover");
      const free = await h.rpc("tools/call", { name: "free_tool", arguments: {} });
      assert.equal(free.body.result?.content?.[0]?.text, "ok:free_tool");
    });
  });

  it("reports a remote upstream that stops answering (no connection to lose) after failed pings, and recovers", async () => {
    const sink = await startEventSink();
    try {
      await withHarness(
        {
          config: { eventsUrl: sink.url },
          gateway: {
            reconnect: { maxAttempts: 100, baseDelayMs: 20, maxDelayMs: 40 },
            upstreamHealthCheck: { intervalMs: 20, timeoutMs: 200, maxFailures: 2 },
          },
        },
        async h => {
          await eventually(() => sink.types.includes("server-online"), 3_000, "server-online at start");
          h.upstream.unreachable = true;
          await eventually(async () => (await fetch(`${h.base}/health`)).status === 503, 3_000, "/health to report 503");
          await eventually(() => sink.types.includes("server-offline"), 3_000, "server-offline");
          const health = (await (await fetch(`${h.base}/health`)).json()) as { upstream: { error?: string } };
          assert.match(health.upstream.error ?? "", /unreachable|fetch failed/);
          const call = await h.rpc("tools/call", { name: "paid_tool", arguments: {} });
          assert.equal(call.status, 503, "no 402 challenge for a call that cannot run");
          h.upstream.unreachable = false;
          await eventually(async () => (await fetch(`${h.base}/health`)).status === 200, 3_000, "/health to recover");
          const free = await h.rpc("tools/call", { name: "free_tool", arguments: {} });
          assert.equal(free.body.result?.content?.[0]?.text, "ok:free_tool");
        },
      );
    } finally {
      await sink.close();
    }
  });

  it("counts connection-level failures of tool calls as well", async () => {
    await withHarness(
      {
        gateway: {
          reconnect: { maxAttempts: 100, baseDelayMs: 20, maxDelayMs: 40 },
          upstreamHealthCheck: { intervalMs: 0, maxFailures: 2 },
        },
      },
      async h => {
        h.upstream.unreachable = true;
        for (let i = 0; i < 2; i++) {
          const res = await h.rpc("tools/call", { name: "free_tool", arguments: {} });
          assert.equal(res.body.error?.code, -32603);
        }
        assert.equal((await fetch(`${h.base}/health`)).status, 503, "two failed calls in a row mark the upstream as lost");
        h.upstream.unreachable = false;
        await eventually(async () => (await fetch(`${h.base}/health`)).status === 200, 3_000, "/health to recover");
      },
    );
  });

  it("does not count tool errors the upstream answered with", async () => {
    await withHarness(
      {
        tools: [
          {
            name: "free_tool",
            handler: () => {
              throw new Error("kaput");
            },
          },
          { name: "paid_tool" },
        ],
        gateway: { upstreamHealthCheck: { intervalMs: 0, maxFailures: 2 } },
      },
      async h => {
        for (let i = 0; i < 3; i++) await h.rpc("tools/call", { name: "free_tool", arguments: {} });
        assert.equal((await fetch(`${h.base}/health`)).status, 200);
      },
    );
  });

  it("reports a fatal error when reconnecting gives up", async () => {
    let fatal: Error | undefined;
    await withHarness(
      { gateway: { reconnect: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10 }, onFatal: err => (fatal = err) } },
      async h => {
        h.upstream.failConnections = true;
        await h.upstream.crash();
        await eventually(() => fatal !== undefined, 3_000, "onFatal");
        assert.match(fatal?.message ?? "", /after 2 reconnect attempts/);
        const health = (await (await fetch(`${h.base}/health`)).json()) as { upstream: { state: string } };
        assert.equal(health.upstream.state, "failed");
      },
    );
  });
});

describe("HTTP transport details", () => {
  it("answers malformed JSON with a JSON-RPC parse error, not an HTML page", async () => {
    await withHarness({}, async h => {
      const res = await fetch(h.gateway.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: { code: number; message: string } };
      assert.equal(body.error.code, -32700);
      assert.doesNotMatch(body.error.message, /at |node_modules/);
    });
  });

  it("answers GET and DELETE on /mcp with 405", async () => {
    await withHarness({}, async h => {
      for (const method of ["GET", "DELETE"]) {
        const res = await fetch(h.gateway.url, { method });
        assert.equal(res.status, 405);
        assert.match(res.headers.get("allow") ?? "", /POST/);
      }
    });
  });

  it("acknowledges notifications with 202 and rejects batches", async () => {
    await withHarness({}, async h => {
      const note = await fetch(h.gateway.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      assert.equal(note.status, 202);
      const batch = await fetch(h.gateway.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]),
      });
      assert.equal(batch.status, 400);
    });
  });

  it("exposes the pricing and discovery documents for visible priced tools only", async () => {
    await withHarness({}, async h => {
      const pricing = (await (await fetch(`${h.base}/pricing`)).json()) as { tools: Array<{ name: string; amountRaw?: string }> };
      assert.deepEqual(pricing.tools.map(t => t.name).sort(), ["free_tool", "paid_tool"]);
      const discovery = (await (await fetch(`${h.base}/.well-known/x402.json`)).json()) as { items: Array<{ metadata: { tool: string } }> };
      assert.deepEqual(discovery.items.map(i => i.metadata.tool), ["paid_tool"]);
    });
  });
});
