import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Upstream } from "@cascet/core";
import { errorMessage, log, logSafe } from "./log.js";
import { GATEWAY_VERSION } from "./version.js";

export const GATEWAY_CLIENT_INFO = { name: "cascet-gateway", version: GATEWAY_VERSION } as const;

/**
 * Environment of a stdio upstream: the MCP SDK's minimal default set (HOME,
 * LOGNAME, PATH, SHELL, TERM, USER on POSIX) plus `upstream.env`, and nothing
 * else. The gateway's own environment (facilitator tokens, ingest tokens,
 * cloud credentials) never reaches third-party upstream code.
 */
export function upstreamEnvironment(upstreamEnv: Record<string, string> | undefined): Record<string, string> {
  return { ...getDefaultEnvironment(), ...(upstreamEnv ?? {}) };
}

/** Create the client transport for the configured upstream. */
export function createUpstreamTransport(upstream: Upstream): Transport {
  if (upstream.type === "stdio") {
    return new StdioClientTransport({
      command: upstream.command,
      args: upstream.args,
      env: upstreamEnvironment(upstream.env),
      cwd: upstream.cwd,
      stderr: "inherit",
    });
  }
  return new StreamableHTTPClientTransport(new URL(upstream.url));
}

/** Upper bound on tools/list pages, so a misbehaving upstream cannot keep the gateway paging forever. */
export const MAX_TOOL_PAGES = 100;

/** List every upstream tool, following `nextCursor` across pages. */
export async function listAllTools(client: Client, timeoutMs: number): Promise<Tool[]> {
  const tools: Tool[] = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const result = await client.listTools(cursor === undefined ? undefined : { cursor }, { timeout: timeoutMs });
    for (const tool of result.tools) {
      if (names.has(tool.name)) {
        log.warn(`[upstream] tools/list returned "${logSafe(tool.name, 80)}" twice; keeping the first definition`);
        continue;
      }
      names.add(tool.name);
      tools.push(tool);
    }
    const next = result.nextCursor;
    if (next === undefined || next === "") return tools;
    if (cursors.has(next)) throw new Error("upstream tools/list repeated a pagination cursor");
    cursors.add(next);
    cursor = next;
  }
  throw new Error(`upstream tools/list did not finish within ${MAX_TOOL_PAGES} pages`);
}

export type UpstreamState = "connecting" | "connected" | "reconnecting" | "failed" | "closed";

export interface ReconnectPolicy {
  /** Reconnect attempts after the upstream is lost; 0 disables reconnecting. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RECONNECT: ReconnectPolicy = { maxAttempts: 8, baseDelayMs: 1_000, maxDelayMs: 30_000 };

export interface UpstreamCallbacks {
  /** The complete upstream tool list, after every (re)connect and every tools/list_changed. */
  onTools(tools: Tool[]): Promise<void> | void;
  onState(state: UpstreamState, error?: Error): void;
  /** Reconnecting gave up: the upstream is gone for good. */
  onFatal(error: Error): void;
}

export interface UpstreamSupervisorOptions {
  createTransport: () => Transport | Promise<Transport>;
  timeoutMs: number;
  reconnect?: Partial<ReconnectPolicy>;
}

/**
 * Owns the MCP client connection to the upstream server.
 *
 * Detects when the upstream goes away (process exit, closed transport),
 * reports it, and reconnects with exponential backoff; after the last attempt
 * it reports a fatal error so the process can exit non-zero and be restarted
 * by its supervisor. Re-lists all tools (every page) after each connect and on
 * `notifications/tools/list_changed`.
 */
export class UpstreamSupervisor {
  private client?: Client;
  private currentState: UpstreamState = "connecting";
  private closing = false;
  private lastError?: Error;
  private reconnectTimer?: NodeJS.Timeout;
  private refreshRunning = false;
  private refreshQueued = false;
  private readonly reconnect: ReconnectPolicy;

  constructor(
    private readonly opts: UpstreamSupervisorOptions,
    private readonly callbacks: UpstreamCallbacks,
  ) {
    this.reconnect = { ...DEFAULT_RECONNECT, ...opts.reconnect };
  }

  get state(): UpstreamState {
    return this.currentState;
  }

  get error(): Error | undefined {
    return this.lastError;
  }

  /** First connection. Throws when the upstream cannot be started at all. */
  async start(): Promise<void> {
    const { client, tools } = await this.connectOnce();
    this.client = client;
    await this.callbacks.onTools(tools);
    this.setState("connected");
  }

  /** Call an upstream tool; throws when the upstream is not connected. */
  async callTool(params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }): Promise<CallToolResult> {
    const client = this.client;
    if (!client || this.currentState !== "connected") throw new UpstreamUnavailableError();
    return (await client.callTool(params, undefined, { timeout: this.opts.timeoutMs })) as CallToolResult;
  }

  /** Round-trip liveness probe (MCP ping); throws when the upstream does not answer in time. */
  async ping(timeoutMs: number): Promise<void> {
    const client = this.client;
    if (!client || this.currentState !== "connected") throw new UpstreamUnavailableError();
    await client.ping({ timeout: timeoutMs });
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const client = this.client;
    this.client = undefined;
    this.setState("closed");
    await client?.close().catch(() => {});
  }

  private async connectOnce(): Promise<{ client: Client; tools: Tool[] }> {
    const client = new Client({ ...GATEWAY_CLIENT_INFO });
    const transport = await this.opts.createTransport();
    client.onclose = () => this.handleClose(client);
    client.onerror = err => log.warn(`[upstream] ${logSafe(err)}`);
    try {
      await client.connect(transport, { timeout: this.opts.timeoutMs });
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.requestRefresh(client));
      const tools = await listAllTools(client, this.opts.timeoutMs);
      return { client, tools };
    } catch (err) {
      client.onclose = undefined;
      await client.close().catch(() => {});
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private handleClose(client: Client): void {
    if (this.closing || client !== this.client) return;
    this.client = undefined;
    const error = new Error("upstream MCP connection closed");
    this.lastError = error;
    this.setState("reconnecting", error);
    this.scheduleReconnect(1);
  }

  private scheduleReconnect(attempt: number): void {
    if (this.closing) return;
    if (attempt > this.reconnect.maxAttempts) {
      const error = new Error(
        `upstream MCP server unavailable after ${this.reconnect.maxAttempts} reconnect attempts: ${this.lastError?.message ?? "connection closed"}`,
      );
      this.lastError = error;
      this.setState("failed", error);
      this.callbacks.onFatal(error);
      return;
    }
    const delay = Math.min(this.reconnect.maxDelayMs, this.reconnect.baseDelayMs * 2 ** (attempt - 1));
    this.reconnectTimer = setTimeout(() => void this.tryReconnect(attempt), delay);
  }

  private async tryReconnect(attempt: number): Promise<void> {
    if (this.closing) return;
    try {
      const { client, tools } = await this.connectOnce();
      if (this.closing) {
        await client.close().catch(() => {});
        return;
      }
      this.client = client;
      await this.callbacks.onTools(tools);
      this.lastError = undefined;
      this.setState("connected");
      log.info(`[upstream] reconnected (attempt ${attempt})`);
    } catch (err) {
      this.lastError = err instanceof Error ? err : new Error(String(err));
      log.warn(`[upstream] reconnect attempt ${attempt}/${this.reconnect.maxAttempts} failed: ${logSafe(errorMessage(err))}`);
      this.scheduleReconnect(attempt + 1);
    }
  }

  /** Coalesce list_changed bursts into sequential full refreshes. */
  private requestRefresh(client: Client): void {
    if (client !== this.client) return;
    if (this.refreshRunning) {
      this.refreshQueued = true;
      return;
    }
    this.refreshRunning = true;
    void (async () => {
      try {
        do {
          this.refreshQueued = false;
          const current = this.client;
          if (!current || current !== client) return;
          try {
            const tools = await listAllTools(current, this.opts.timeoutMs);
            if (current === this.client) await this.callbacks.onTools(tools);
          } catch (err) {
            log.warn(`[upstream] tools/list refresh failed, keeping the previous tool table: ${logSafe(errorMessage(err))}`);
          }
        } while (this.refreshQueued);
      } finally {
        this.refreshRunning = false;
      }
    })();
  }

  private setState(state: UpstreamState, error?: Error): void {
    this.currentState = state;
    this.callbacks.onState(state, error);
  }
}

export class UpstreamUnavailableError extends Error {
  constructor() {
    super("upstream MCP server is not connected");
    this.name = "UpstreamUnavailableError";
  }
}

export interface UpstreamConnection {
  client: Client;
  close: () => Promise<void>;
}

/** Connect a plain MCP client to the configured upstream (no supervision). */
export async function connectUpstream(upstream: Upstream): Promise<UpstreamConnection> {
  const client = new Client({ ...GATEWAY_CLIENT_INFO });
  await client.connect(createUpstreamTransport(upstream));
  return { client, close: () => client.close() };
}
