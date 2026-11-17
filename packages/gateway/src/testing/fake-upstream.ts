import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

export interface FakeTool {
  name: string;
  description?: string;
  handler?: (args: Record<string, unknown>, meta: Record<string, unknown> | undefined) => CallToolResult | Promise<CallToolResult>;
}

export interface UpstreamCall {
  name: string;
  args: Record<string, unknown>;
  meta: Record<string, unknown> | undefined;
}

export interface FakeUpstream {
  /** Pass as GatewayOptions.createUpstreamTransport. */
  createTransport(): Promise<Transport>;
  tools: FakeTool[];
  calls: UpstreamCall[];
  /** tools/list requests served (one per page). */
  listRequests: number;
  connections: number;
  /** Make the next createTransport() calls fail. */
  failConnections: boolean;
  /**
   * Like a remote upstream that stopped answering: every message the gateway sends
   * fails with a network error, but no connection is closed.
   */
  unreachable: boolean;
  /** Called after a tools/list page was computed and before it is returned (n counts list requests). */
  afterListPage?: (n: number) => void | Promise<void>;
  addTool(tool: FakeTool): void;
  /** Send notifications/tools/list_changed on the live connection. */
  notifyToolsChanged(): Promise<void>;
  /** Drop the live connection, like a crashed upstream process. */
  crash(): Promise<void>;
}

/**
 * In-memory MCP server for gateway tests. tools/list is paginated with
 * `pageSize` tools per page; every tools/call is recorded and appended as
 * "exec:<name>" to `events`.
 */
export function createFakeUpstream(opts: { tools: FakeTool[]; pageSize?: number; events?: string[] }): FakeUpstream {
  const pageSize = opts.pageSize ?? 100;
  let live: { server: Server; transport: InMemoryTransport } | undefined;

  const fake: FakeUpstream = {
    tools: [...opts.tools],
    calls: [],
    listRequests: 0,
    connections: 0,
    failConnections: false,
    unreachable: false,
    async createTransport() {
      if (fake.failConnections) throw new Error("fake upstream refuses to start");
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "fake-upstream", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
      server.setRequestHandler(ListToolsRequestSchema, async request => {
        fake.listRequests++;
        const start = request.params?.cursor ? Number(request.params.cursor) : 0;
        const page = fake.tools.slice(start, start + pageSize);
        const next = start + pageSize < fake.tools.length ? String(start + pageSize) : undefined;
        await fake.afterListPage?.(fake.listRequests);
        return {
          tools: page.map(t => ({ name: t.name, description: t.description ?? `${t.name} tool`, inputSchema: { type: "object" as const } })),
          ...(next === undefined ? {} : { nextCursor: next }),
        };
      });
      server.setRequestHandler(CallToolRequestSchema, async request => {
        const tool = fake.tools.find(t => t.name === request.params.name);
        if (!tool) throw new McpError(ErrorCode.InvalidParams, `no such tool: ${request.params.name}`);
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        const meta = request.params._meta as Record<string, unknown> | undefined;
        fake.calls.push({ name: tool.name, args, meta });
        opts.events?.push(`exec:${tool.name}`);
        if (tool.handler) return tool.handler(args, meta);
        return { content: [{ type: "text", text: `ok:${tool.name}` }] };
      });
      await server.connect(serverSide);
      live = { server, transport: serverSide };
      fake.connections++;
      const send = clientSide.send.bind(clientSide);
      clientSide.send = async (message, options) => {
        if (fake.unreachable) throw new TypeError("fetch failed");
        return send(message, options);
      };
      return clientSide;
    },
    addTool(tool) {
      fake.tools.push(tool);
    },
    async notifyToolsChanged() {
      await live?.server.sendToolListChanged();
    },
    async crash() {
      const current = live;
      live = undefined;
      await current?.transport.close();
    },
  };
  return fake;
}
