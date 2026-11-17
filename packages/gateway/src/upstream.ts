import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  McpError,
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

/**
 * Liveness of a connected upstream. A remote (http) upstream has no connection
 * whose loss the gateway would notice, and a stdio child can hang without
 * exiting, so the gateway pings it and counts connection-level failures of
 * pings and tool calls.
 */
export interface HealthCheckPolicy {
  /** Ping interval while connected; 0 disables periodic pings (failed calls still count). */
  intervalMs: number;
  /** Timeout of one ping. */
  timeoutMs: number;
  /** Consecutive connection-level failures after which the upstream counts as lost (and is reconnected). */
  maxFailures: number;
}

export const DEFAULT_HEALTH_CHECK: HealthCheckPolicy = { intervalMs: 30_000, timeoutMs: 5_000, maxFailures: 3 };

/**
 * What an error from an upstream request says about the connection:
 * - "failure": the connection is broken (network error, HTTP-level error of the
 *   transport, closed connection; a timeout only where `timeoutIsFailure`, i.e. pings);
 * - "answered": the upstream answered (a JSON-RPC error, a malformed result);
 * - "neutral": nothing either way (a slow tool).
 */
export function classifyUpstreamError(err: unknown, timeoutIsFailure: boolean): "failure" | "answered" | "neutral" {
  if (err instanceof McpError) {
    if (err.code === ErrorCode.ConnectionClosed) return "failure";
    if (err.code === ErrorCode.RequestTimeout) return timeoutIsFailure ? "failure" : "neutral";
    return "answered";
  }
  if (err instanceof StreamableHTTPError || err instanceof TypeError) return "failure";
  if (err instanceof Error && err.message === "Not connected") return "failure";
  if (err instanceof Error && err.name === "ZodError") return "answered";
  return "neutral";
}

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
  healthCheck?: Partial<HealthCheckPolicy>;
}

/**
 * Owns the MCP client connection to the upstream server.
 *
 * Detects when the upstream goes away (process exit, closed transport, or
 * `healthCheck.maxFailures` connection-level failures of pings and calls in a
 * row), reports it, and reconnects with exponential backoff; after the last
 * attempt it reports a fatal error so the process can exit non-zero and be
 * restarted by its supervisor. Re-lists all tools (every page) after each
 * connect and on `notifications/tools/list_changed`, including one that
 * arrives while a connection's first listing is still running.
 */
export class UpstreamSupervisor {
  private client?: Client;
  /** Client being connected and listed, not installed yet. */
  private connecting?: Client;
  private currentState: UpstreamState = "connecting";
  private closing = false;
  private lastError?: Error;
  private reconnectTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private connectionFailures = 0;
  private refreshRunning = false;
  private refreshQueued = false;
  /** A tools/list_changed arrived for the client being connected. */
  private pendingRefresh = false;
  private readonly reconnect: ReconnectPolicy;
  private readonly healthCheck: HealthCheckPolicy;

  constructor(
    private readonly opts: UpstreamSupervisorOptions,
    private readonly callbacks: UpstreamCallbacks,
  ) {
    this.reconnect = { ...DEFAULT_RECONNECT, ...opts.reconnect };
    this.healthCheck = { ...DEFAULT_HEALTH_CHECK, ...opts.healthCheck };
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
    await this.install(client, tools);
  }

  /** Call an upstream tool; throws when the upstream is not connected. */
  async callTool(params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }): Promise<CallToolResult> {
    const client = this.client;
    if (!client || this.currentState !== "connected") throw new UpstreamUnavailableError();
    try {
      const result = (await client.callTool(params, undefined, { timeout: this.opts.timeoutMs })) as CallToolResult;
      this.noteOutcome(client, "answered");
      return result;
    } catch (err) {
      this.noteOutcome(client, classifyUpstreamError(err, false), err);
      throw err;
    }
  }

  /** Round-trip liveness probe (MCP ping); throws when the upstream does not answer in time. */
  async ping(timeoutMs: number): Promise<void> {
    const client = this.client;
    if (!client || this.currentState !== "connected") throw new UpstreamUnavailableError();
    try {
      await client.ping({ timeout: timeoutMs });
      this.noteOutcome(client, "answered");
    } catch (err) {
      const outcome = classifyUpstreamError(err, true);
      this.noteOutcome(client, outcome, err);
      // An error answer (say, an upstream without ping support) still proves it is there.
      if (outcome !== "answered") throw err;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.healthTimer) clearTimeout(this.healthTimer);
    const client = this.client;
    this.client = undefined;
    this.setState("closed");
    await client?.close().catch(() => {});
  }

  private async connectOnce(): Promise<{ client: Client; tools: Tool[] }> {
    const client = new Client({ ...GATEWAY_CLIENT_INFO });
    const transport = await this.opts.createTransport();
    client.onclose = () => this.connectionLost(client, new Error("upstream MCP connection closed"), false);
    client.onerror = err => log.warn(`[upstream] ${logSafe(err)}`);
    this.connecting = client;
    this.pendingRefresh = false;
    try {
      await client.connect(transport, { timeout: this.opts.timeoutMs });
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.requestRefresh(client));
      const tools = await listAllTools(client, this.opts.timeoutMs);
      return { client, tools };
    } catch (err) {
      if (this.connecting === client) this.connecting = undefined;
      client.onclose = undefined;
      await client.close().catch(() => {});
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Make a freshly connected client the live one. */
  private async install(client: Client, tools: Tool[]): Promise<void> {
    this.client = client;
    this.connecting = undefined;
    this.connectionFailures = 0;
    await this.callbacks.onTools(tools);
    if (this.closing || this.client !== client) return; // closed or lost meanwhile
    this.lastError = undefined;
    this.setState("connected");
    this.scheduleHealthCheck(client);
    if (this.pendingRefresh) {
      // tools/list_changed arrived during the first listing: that list may already be stale.
      this.pendingRefresh = false;
      this.requestRefresh(client);
    }
  }

  /**
   * The live connection is gone (closed, or too many connection-level failures):
   * report it and reconnect. `closeClient` also tears the old client down (a hung
   * stdio child is stopped this way).
   */
  private connectionLost(client: Client, error: Error, closeClient: boolean): void {
    if (this.closing || client !== this.client) return;
    this.client = undefined;
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.connectionFailures = 0;
    this.lastError = error;
    this.setState("reconnecting", error);
    if (closeClient) void client.close().catch(() => {});
    this.scheduleReconnect(1);
  }

  private noteOutcome(client: Client, outcome: "failure" | "answered" | "neutral", err?: unknown): void {
    if (client !== this.client || outcome === "neutral") return;
    if (outcome === "answered") {
      this.connectionFailures = 0;
      return;
    }
    this.connectionFailures++;
    if (this.connectionFailures >= this.healthCheck.maxFailures) {
      const error = new Error(
        `upstream MCP server unreachable (${this.connectionFailures} failed requests in a row): ${logSafe(errorMessage(err), 200)}`,
      );
      this.connectionLost(client, error, true);
    }
  }

  private scheduleHealthCheck(client: Client): void {
    if (this.healthCheck.intervalMs <= 0 || this.closing) return;
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = setTimeout(() => void this.runHealthCheck(client), this.healthCheck.intervalMs);
    this.healthTimer.unref();
  }

  private async runHealthCheck(client: Client): Promise<void> {
    if (this.closing || client !== this.client) return;
    try {
      await this.ping(this.healthCheck.timeoutMs);
    } catch {
      // counted by ping()
    }
    if (client === this.client) this.scheduleHealthCheck(client);
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
        this.connecting = undefined;
        await client.close().catch(() => {});
        return;
      }
      await this.install(client, tools);
      log.info(`[upstream] reconnected (attempt ${attempt})`);
    } catch (err) {
      this.lastError = err instanceof Error ? err : new Error(String(err));
      log.warn(`[upstream] reconnect attempt ${attempt}/${this.reconnect.maxAttempts} failed: ${logSafe(errorMessage(err))}`);
      this.scheduleReconnect(attempt + 1);
    }
  }

  /** Coalesce list_changed bursts into sequential full refreshes. */
  private requestRefresh(client: Client): void {
    if (client !== this.client) {
      // Not installed yet: refresh once it is, instead of dropping the notification.
      if (client === this.connecting) this.pendingRefresh = true;
      return;
    }
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
