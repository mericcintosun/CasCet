import { HEADER_CASCET_PAYMENT_ID } from "@cascet/core";
import {
  anySignal,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  paymentFailureReason,
  readTextCapped,
  RequestTimeoutError,
  validateByteLimit,
  validateTimeoutMs,
  type FetchLike,
} from "./http.js";

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

export interface PaidMcpHttpClientOptions {
  /**
   * Deadline for each JSON-RPC request in ms (default 30000), including a paid
   * retry when the fetch is a paying fetch. A timed-out paid call may still settle.
   */
  timeoutMs?: number;
  /** Largest response body accepted, in bytes (default 16 MiB). */
  maxResponseBytes?: number;
}

/** Per-call options. */
export interface McpCallOptions {
  /** Abort the request when this signal aborts (e.g. the inbound request's signal in a cascade). */
  signal?: AbortSignal;
}

/**
 * Minimal MCP-over-HTTP client used for programmatic (agent-to-agent) tool
 * calls. Pair it with a paying fetch from `createPayingFetch` and every 402 is
 * handled automatically — this is the client a paid tool uses to buy from
 * downstream paid tools (cascading payments).
 */
export class PaidMcpHttpClient {
  private nextId = 1;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    private readonly mcpUrl: string,
    private readonly fetchImpl: FetchLike,
    options: PaidMcpHttpClientOptions = {},
  ) {
    this.timeoutMs = validateTimeoutMs(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "PaidMcpHttpClient timeoutMs");
    this.maxResponseBytes = validateByteLimit(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "PaidMcpHttpClient maxResponseBytes",
    );
  }

  private async request(
    method: string,
    params: Record<string, unknown> | undefined,
    call: McpCallOptions | undefined,
  ): Promise<{ result: unknown; headers: Headers }> {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = call?.signal ? anySignal([call.signal, deadline]) : deadline;
    try {
      const response = await this.fetchImpl(this.mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
        signal,
      });
      const text = await readTextCapped(response, this.maxResponseBytes);
      if (!response.ok) {
        const reason = response.status === 402 ? paymentFailureReason(response.headers) : undefined;
        throw new Error(
          `MCP request ${method} failed: HTTP ${response.status}${reason ? ` (${reason})` : ""} ${text.slice(0, 300)}`.trim(),
        );
      }
      let body: JsonRpcResponse;
      try {
        body = JSON.parse(text) as JsonRpcResponse;
      } catch {
        throw new Error(`MCP ${method}: the server returned invalid JSON`);
      }
      if (body.error) {
        throw new Error(`MCP ${method} error ${body.error.code}: ${body.error.message}`);
      }
      return { result: body.result, headers: response.headers };
    } catch (err) {
      if (deadline.aborted && !call?.signal?.aborted && !(err instanceof RequestTimeoutError)) {
        throw new RequestTimeoutError(`MCP ${method} timed out after ${this.timeoutMs} ms`, { cause: err });
      }
      throw err;
    }
  }

  async initialize(call?: McpCallOptions): Promise<void> {
    await this.request(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cascet-client", version: "0.1.0" },
      },
      call,
    );
  }

  async listTools(call?: McpCallOptions): Promise<McpToolInfo[]> {
    const { result } = await this.request("tools/list", undefined, call);
    return (result as { tools: McpToolInfo[] }).tools;
  }

  async callTool(name: string, args: Record<string, unknown>, call?: McpCallOptions): Promise<ToolCallOutcome> {
    const { result, headers } = await this.request("tools/call", { name, arguments: args }, call);
    return {
      result: result as Record<string, unknown>,
      paymentId: headers.get(HEADER_CASCET_PAYMENT_ID) ?? undefined,
    };
  }
}
