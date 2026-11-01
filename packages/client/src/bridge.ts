import { createInterface } from "node:readline";
import type { PayingFetch } from "./paying-fetch.js";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  errorMessage,
  isTimeoutError,
  paymentFailureReason,
  readTextCapped,
  validateByteLimit,
  validateTimeoutMs,
  withDeadline,
  type FetchLike,
} from "./http.js";
import { ToolPinGuard, type ToolPinOptions } from "./tool-pins.js";

export interface BridgeOptions {
  /**
   * Deadline for each forwarded message in ms (default 30000). Paid calls are
   * also bounded by the paying fetch's own deadline.
   */
  timeoutMs?: number;
  /**
   * Pin tool definitions per gateway and quarantine changed or new tools
   * (OWASP MCP03). Omit to disable pinning.
   */
  toolPins?: ToolPinOptions;
  /** Largest gateway response accepted, in bytes (default 16 MiB). */
  maxResponseBytes?: number;
  /** Receives log lines (default: stderr). */
  log?: (line: string) => void;
}

/** The message handler behind {@link runBridge}; exported for tests and custom transports. */
export interface Bridge {
  /** Handle one line from the host; resolves to the line to write back, if any. Never rejects. */
  handleLine(line: string): Promise<string | undefined>;
}

type JsonRpcId = string | number;

interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/** Conventional MCP tool names; anything else is not echoed back in a quarantine stub. */
const SAFE_TOOL_NAME = /^[A-Za-z0-9_./-]{1,128}$/;

const QUARANTINE_NOTICE =
  "[CasCet] This tool is quarantined: its definition changed since it was pinned, or it appeared after " +
  "the gateway's tools were pinned. CasCet will not call it or pay for it. Ask the user to review the " +
  "warning in the cascet connect log and to restart the bridge with --accept-tool-changes if they trust it.";

/**
 * stdio ⇄ paid-HTTP bridge.
 *
 * Runs as a local stdio MCP server for any MCP host (Claude Code, Claude
 * Desktop, Cursor…) and forwards every JSON-RPC message to a CasCet gateway
 * over HTTP. Only `tools/call` may be paid: its 402 challenge is answered by
 * the paying fetch within the spending policy. Every other method is forwarded
 * without payment. With `toolPins`, tool definitions are pinned and a changed
 * or new tool is withheld from the model and never called.
 *
 * stdout carries JSON-RPC only; all logging goes to stderr.
 */
export async function runBridge(gatewayMcpUrl: string, paying: PayingFetch, options: BridgeOptions = {}): Promise<void> {
  const log = options.log ?? (line => console.error(line));
  const bridge = createBridge(gatewayMcpUrl, paying, { ...options, log });
  const rl = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });

  rl.on("line", line => {
    void bridge
      .handleLine(line)
      .then(out => {
        if (out !== undefined) process.stdout.write(`${out}\n`);
      })
      .catch(err => log(`[cascet] bridge error: ${errorMessage(err)}`));
  });

  // Keep the process alive until the host closes stdin.
  await new Promise<void>(resolvePromise => rl.on("close", resolvePromise));
}

/** Build the bridge's message handler without wiring it to stdio. */
export function createBridge(gatewayMcpUrl: string, paying: PayingFetch, options: BridgeOptions = {}): Bridge {
  const log = options.log ?? (line => console.error(line));
  const timeoutMs = validateTimeoutMs(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "bridge timeoutMs");
  const maxBytes = validateByteLimit(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, "bridge maxResponseBytes");
  const unpaid: FetchLike = withDeadline(paying.fetchUnpaid ?? ((input, init) => fetch(input, init)), timeoutMs);
  const paid: FetchLike = withDeadline(paying.fetch, timeoutMs);
  const pins = options.toolPins
    ? new ToolPinGuard(gatewayMcpUrl, { ...options.toolPins, log })
    : undefined;
  let verifying: Promise<void> | undefined;
  let pinCheckSeq = 0;

  const post = (fetchImpl: FetchLike, body: string) =>
    fetchImpl(gatewayMcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body,
    });

  async function handleLine(line: string): Promise<string | undefined> {
    try {
      return await handle(line);
    } catch (err) {
      log(`[cascet] bridge error: ${errorMessage(err)}`);
      return undefined;
    }
  }

  async function handle(line: string): Promise<string | undefined> {
    const raw = line.trim();
    if (!raw) return undefined;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return rpcError(null, -32700, "CasCet bridge: parse error (expected one JSON-RPC message per line)");
    }
    if (!isRecord(message)) {
      return rpcError(null, -32600, "CasCet bridge: batch requests and non-object messages are not supported");
    }
    const msg = message as RpcMessage;
    const method = typeof msg.method === "string" ? msg.method : undefined;
    const id = isJsonRpcId(msg.id) ? msg.id : undefined;

    if (method === undefined || id === undefined) {
      // Notification (or a response from the host): forward without payment, nothing to answer.
      try {
        const response = await post(unpaid, raw);
        await response.body?.cancel().catch(() => undefined);
      } catch (err) {
        log(`[cascet] notification forward failed: ${errorMessage(err)}`);
      }
      return undefined;
    }
    if (method === "tools/call") return toolCall(raw, id, msg.params);
    return forwardUnpaid(raw, id, method);
  }

  async function forwardUnpaid(raw: string, id: JsonRpcId, method: string): Promise<string> {
    let response: Response;
    let text: string;
    try {
      response = await post(unpaid, raw);
      text = await readTextCapped(response, maxBytes);
    } catch (err) {
      return rpcError(id, -32603, `CasCet bridge: ${method} failed: ${errorMessage(err)}`);
    }
    if (response.status === 402) {
      return rpcError(id, -32603, `CasCet bridge: the gateway asked for payment on ${method}; CasCet only pays for tools/call`);
    }
    const reply = parseReply(text);
    if (!reply) return rpcError(id, -32603, `CasCet bridge: unexpected gateway response to ${method} (HTTP ${response.status})`);
    reply.id = id;
    const result = reply.result;
    if (method === "tools/list" && pins && isRecord(result) && Array.isArray(result.tools)) {
      const tools: unknown[] = result.tools;
      const { quarantined } = pins.inspect(tools);
      // Withhold changed definitions from the model: a poisoned description works the moment
      // the model reads it, even if the tool is never called. Entries without a string name
      // cannot be pinned and are dropped, and a stub never echoes an unusual tool name.
      result.tools = tools.flatMap(tool => {
        if (!isRecord(tool) || typeof tool.name !== "string") return [];
        if (!quarantined.has(tool.name)) return [tool];
        return SAFE_TOOL_NAME.test(tool.name)
          ? [{ name: tool.name, description: QUARANTINE_NOTICE, inputSchema: { type: "object", properties: {} } }]
          : [];
      });
    }
    return JSON.stringify(reply);
  }

  async function toolCall(raw: string, id: JsonRpcId, params: unknown): Promise<string> {
    const name = isRecord(params) && typeof params.name === "string" ? params.name : undefined;
    if (name === undefined) return rpcError(id, -32602, "CasCet bridge: tools/call requires params.name");

    if (pins) {
      try {
        await ensureVerified(pins);
      } catch (err) {
        return toolError(id, `CasCet refused to call "${name}": could not verify the gateway's tool definitions (${errorMessage(err)}).`);
      }
      const trust = pins.status(name);
      if (trust === "quarantined") {
        return toolError(
          id,
          `CasCet refused to call "${name}": its definition changed since it was pinned, or it is new. ` +
            "It may be a tool-poisoning attempt. The user can review the change in the cascet connect log " +
            "and restart the bridge with --accept-tool-changes to trust it.",
        );
      }
      if (trust === "unknown") {
        return toolError(id, `CasCet refused to call "${name}": the gateway does not list this tool, so its definition cannot be verified.`);
      }
    }

    let response: Response;
    let text: string;
    try {
      response = await post(paid, raw);
      text = await readTextCapped(response, maxBytes);
    } catch (err) {
      const note = isTimeoutError(err) ? " If a payment was already authorized, it may still settle." : "";
      return toolError(id, `CasCet: the call to "${name}" did not complete: ${errorMessage(err)}.${note}`);
    }
    if (response.status === 402) {
      const reason = paymentFailureReason(response.headers);
      return toolError(id, `CasCet: the gateway did not accept payment for "${name}"${reason ? `: ${reason}` : ""}.`);
    }
    const reply = parseReply(text);
    if (!reply) return toolError(id, `CasCet: unexpected gateway response to "${name}" (HTTP ${response.status}).`);
    reply.id = id;
    return JSON.stringify(reply);
  }

  /** Make sure this session has checked the gateway's tool list before any tool is called. */
  async function ensureVerified(guard: ToolPinGuard): Promise<void> {
    if (guard.hasInspected) return;
    verifying ??= (async () => {
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        pinCheckSeq += 1;
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: `cascet-pin-check-${pinCheckSeq}`,
          method: "tools/list",
          ...(cursor ? { params: { cursor } } : {}),
        });
        const response = await post(unpaid, body);
        const reply = parseReply(await readTextCapped(response, maxBytes));
        if (!reply || !isRecord(reply.result) || !Array.isArray(reply.result.tools)) {
          throw new Error(`tools/list returned no tool list (HTTP ${response.status})`);
        }
        guard.inspect(reply.result.tools);
        cursor = typeof reply.result.nextCursor === "string" ? reply.result.nextCursor : undefined;
        if (!cursor) return;
      }
    })().finally(() => {
      verifying = undefined;
    });
    await verifying;
  }

  return { handleLine };
}

/** Parse a gateway reply into a JSON-RPC response object, or undefined when it is not one. */
function parseReply(text: string): RpcMessage | undefined {
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.jsonrpc !== "2.0" || !("result" in parsed || "error" in parsed)) return undefined;
  return parsed as RpcMessage;
}

function rpcError(id: JsonRpcId | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/** A tool-level failure the model can read and react to (MCP: errors inside the result, isError: true). */
function toolError(id: JsonRpcId, text: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text }] } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
