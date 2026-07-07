import { HEADER_CASCET_PAYMENT_ID } from "@cascet/core";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolCallOutcome {
  result: Record<string, unknown>;
  /** CasCet payment id of this call, when the tool was paid. */
  paymentId?: string;
}

/** A tool as advertised by an MCP server (with CasCet's price annotation). */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  _meta?: { cascet?: { priceUsd?: string; network?: string } };
}

/**
 * Minimal MCP-over-HTTP client used for programmatic (agent-to-agent) tool
 * calls. Pair it with a paying fetch from `createPayingFetch` and every 402 is
 * handled automatically — this is the client a paid tool uses to buy from
 * downstream paid tools (cascading payments).
 */
export class PaidMcpHttpClient {
  private nextId = 1;

  constructor(
    private readonly mcpUrl: string,
    private readonly fetchImpl: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>,
  ) {}

  private async request(method: string, params?: Record<string, unknown>): Promise<{ result: unknown; headers: Headers }> {
    const response = await this.fetchImpl(this.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
    });
    if (!response.ok) {
      throw new Error(`MCP request ${method} failed: HTTP ${response.status} ${await safeText(response)}`);
    }
    const body = (await response.json()) as JsonRpcResponse;
    if (body.error) {
      throw new Error(`MCP ${method} error ${body.error.code}: ${body.error.message}`);
    }
    return { result: body.result, headers: response.headers };
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "cascet-client", version: "0.1.0" },
    });
  }

  async listTools(): Promise<McpToolInfo[]> {
    const { result } = await this.request("tools/list");
    return (result as { tools: McpToolInfo[] }).tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome> {
    const { result, headers } = await this.request("tools/call", { name, arguments: args });
    return {
      result: result as Record<string, unknown>,
      paymentId: headers.get(HEADER_CASCET_PAYMENT_ID) ?? undefined,
    };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "";
  }
}
