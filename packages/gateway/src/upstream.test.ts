import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ENV_UPSTREAM_FIXTURE, osBaselineEnvironment } from "./testing/env.js";
import { connectUpstream, listAllTools, MAX_TOOL_PAGES, upstreamEnvironment } from "./upstream.js";

describe("stdio upstream environment (M34)", () => {
  it("only passes the SDK's default variables plus upstream.env, never the gateway's own secrets", () => {
    process.env.CASCET_TEST_SECRET = "s3cret";
    try {
      const env = upstreamEnvironment({ ALLOWED_VAR: "yes" });
      assert.equal(env.ALLOWED_VAR, "yes");
      assert.equal(env.CASCET_TEST_SECRET, undefined);
      assert.deepEqual(Object.keys(env).sort(), [...Object.keys(getDefaultEnvironment()), "ALLOWED_VAR"].sort());
    } finally {
      delete process.env.CASCET_TEST_SECRET;
    }
  });

  it("starts a real stdio upstream without the gateway's environment", async () => {
    process.env.CASCET_TEST_SECRET = "s3cret";
    const upstream = await connectUpstream({
      type: "stdio",
      command: process.execPath,
      args: [ENV_UPSTREAM_FIXTURE],
      env: { ALLOWED_VAR: "yes" },
    });
    try {
      const result = (await upstream.client.callTool({ name: "env", arguments: {} })) as { content: Array<{ text: string }> };
      const env = JSON.parse(result.content[0]?.text ?? "{}") as { names: string[]; allowed: string | null };
      assert.equal(env.allowed, "yes");
      assert.ok(!env.names.includes("CASCET_TEST_SECRET"), "gateway secrets must not reach the upstream");
      const permitted = new Set([...Object.keys(getDefaultEnvironment()), ...osBaselineEnvironment(), "ALLOWED_VAR"]);
      for (const name of env.names) assert.ok(permitted.has(name), `unexpected variable ${name} in the upstream environment`);
    } finally {
      delete process.env.CASCET_TEST_SECRET;
      await upstream.close();
    }
  });
});

describe("listAllTools (M37)", () => {
  const page = (names: string[], nextCursor?: string) => ({
    tools: names.map(name => ({ name, inputSchema: { type: "object" as const } })),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });

  it("collects every page and drops duplicate names", async () => {
    const pages: Record<string, ReturnType<typeof page>> = {
      start: page(["a", "b"], "p2"),
      p2: page(["c", "a"], "p3"),
      p3: page(["d"]),
    };
    const client = { listTools: async (params?: { cursor?: string }) => pages[params?.cursor ?? "start"] } as unknown as Client;
    assert.deepEqual((await listAllTools(client, 1_000)).map(t => t.name), ["a", "b", "c", "d"]);
  });

  it("stops on a repeated cursor and on an endless list", async () => {
    const looping = { listTools: async () => page(["a"], "same") } as unknown as Client;
    await assert.rejects(listAllTools(looping, 1_000), /repeated a pagination cursor/);
    let n = 0;
    const endless = { listTools: async () => page([`t${n}`], String(++n)) } as unknown as Client;
    await assert.rejects(listAllTools(endless, 1_000), new RegExp(`within ${MAX_TOOL_PAGES} pages`));
  });
});
