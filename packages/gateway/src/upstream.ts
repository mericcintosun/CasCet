import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Upstream } from "@cascet/core";

export interface UpstreamConnection {
  client: Client;
  close: () => Promise<void>;
}

/** Connect an MCP client to the wrapped upstream server (local stdio process or remote HTTP). */
export async function connectUpstream(upstream: Upstream): Promise<UpstreamConnection> {
  const client = new Client({ name: "cascet-gateway", version: "0.1.0" });

  if (upstream.type === "stdio") {
    const transport = new StdioClientTransport({
      command: upstream.command,
      args: upstream.args,
      env: { ...(process.env as Record<string, string>), ...upstream.env },
      stderr: "inherit",
    });
    await client.connect(transport);
    return { client, close: () => client.close() };
  }

  const transport = new StreamableHTTPClientTransport(new URL(upstream.url));
  await client.connect(transport);
  return { client, close: () => client.close() };
}
