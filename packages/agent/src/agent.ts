import Anthropic from "@anthropic-ai/sdk";
import { PaidMcpHttpClient, type McpToolInfo, type PayingFetch } from "@cascet/client";

/** Model the agent reasons with. Opus 4.8 with adaptive thinking (see claude-api skill). */
const DEFAULT_MODEL = "claude-opus-4-8";

const SYSTEM_PROMPT = `You are an autonomous DeFi/RWA portfolio agent operating on the Casper Network.

You reach the outside world through paid MCP tools served over x402: every tool call costs
real money and is settled on-chain in CEP-18 tokens. You hold a fixed budget for this task — when
it runs out, further calls are rejected by the paywall, so spend deliberately.

Rules:
- Buy only the data you actually need to answer the user's goal. Do not call a tool "just in case".
- Each tool's price (in USD) is stated in its description. Prefer cheaper tools when they suffice.
- If a tool call is rejected because it would exceed the budget, adapt: work with what you already
  bought instead of retrying.
- Ground every claim in data you actually purchased. Cite the tool and the numbers it returned.
- End with a concrete, actionable recommendation for the user's DeFi/RWA goal.`;

export interface AgentToolCall {
  tool: string;
  priceUsd?: string;
  /** CasCet payment id when the call settled a payment, or undefined if it was rejected. */
  paymentId?: string;
  ok: boolean;
}

export interface AgentResult {
  /** The agent's final synthesized recommendation. */
  answer: string;
  /** Every paid tool the agent chose to buy, in order. */
  toolCalls: AgentToolCall[];
  /** Total raw CEP-18 units the agent authorized this run. */
  spentRaw: string;
}

export type AgentEvent =
  | { type: "tools_listed"; tools: Array<{ name: string; priceUsd?: string }> }
  | { type: "thinking"; text: string }
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; tool: string; input: Record<string, unknown>; priceUsd?: string }
  | { type: "tool_result"; tool: string; ok: boolean; paymentId?: string }
  | { type: "final"; result: AgentResult };

export interface RunAgentOptions {
  /** The DeFi/RWA question the agent should answer. */
  goal: string;
  /** MCP endpoint of the (paid) CasCet gateway, e.g. http://localhost:4402/mcp. */
  gatewayMcpUrl: string;
  /** A paying fetch (from createPayingFetch) that answers x402 challenges under a budget. */
  paying: PayingFetch;
  /** Override the reasoning model (default claude-opus-4-8). */
  model?: string;
  /** Cap on agent<->tool round trips. Defaults to 8. */
  maxTurns?: number;
  /** Observe the agent's decisions as they happen (for demos/dashboards). */
  onEvent?: (event: AgentEvent) => void;
}

/**
 * Run an autonomous Claude agent against a paid MCP gateway.
 *
 * Claude discovers the paid tools on offer (with their x402 prices), decides which to buy to
 * satisfy a DeFi/RWA goal, pays per call out of a fixed on-chain budget, and synthesizes a
 * recommendation. This is the LLM-in-the-loop half of CasCet: the buyer that makes the paid-MCP
 * economy autonomous.
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const { goal, gatewayMcpUrl, paying, onEvent } = opts;
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTurns = opts.maxTurns ?? 8;

  const anthropic = new Anthropic();
  const mcp = new PaidMcpHttpClient(gatewayMcpUrl, paying.fetch);
  await mcp.initialize();

  const mcpTools = await mcp.listTools();
  onEvent?.({
    type: "tools_listed",
    tools: mcpTools.map(t => ({ name: t.name, priceUsd: t._meta?.cascet?.priceUsd })),
  });

  const priceOf = new Map(mcpTools.map(t => [t.name, t._meta?.cascet?.priceUsd]));
  const tools = mcpTools.map(toAnthropicTool);

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: goal }];
  const toolCalls: AgentToolCall[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    for (const block of response.content) {
      if (block.type === "text") onEvent?.({ type: "assistant_text", text: block.text });
      else if (block.type === "thinking") onEvent?.({ type: "thinking", text: block.thinking });
    }

    // Echo the assistant turn back verbatim (keeps thinking blocks intact for the next call).
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const answer = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map(b => b.text)
        .join("\n")
        .trim();
      const result: AgentResult = { answer, toolCalls, spentRaw: paying.spentRaw() };
      onEvent?.({ type: "final", result });
      return result;
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const input = (use.input ?? {}) as Record<string, unknown>;
      const priceUsd = priceOf.get(use.name);
      onEvent?.({ type: "tool_call", tool: use.name, input, priceUsd });

      try {
        const { result, paymentId } = await mcp.callTool(use.name, input);
        const text = extractText(result);
        toolCalls.push({ tool: use.name, priceUsd, paymentId, ok: true });
        onEvent?.({ type: "tool_result", tool: use.name, ok: true, paymentId });
        toolResults.push({ type: "tool_result", tool_use_id: use.id, content: text });
      } catch (err) {
        // Over-budget rejections and upstream errors land here — tell Claude so it can adapt.
        const message = err instanceof Error ? err.message : String(err);
        toolCalls.push({ tool: use.name, priceUsd, ok: false });
        onEvent?.({ type: "tool_result", tool: use.name, ok: false });
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: `Tool call failed (could not settle payment or upstream error): ${message}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Ran out of turns without a natural end — return what we have.
  const result: AgentResult = {
    answer: "(agent stopped after reaching the maximum number of tool-buying turns)",
    toolCalls,
    spentRaw: paying.spentRaw(),
  };
  onEvent?.({ type: "final", result });
  return result;
}

/** Map a CasCet-advertised MCP tool to an Anthropic tool definition, folding the price into the description. */
function toAnthropicTool(tool: McpToolInfo): Anthropic.Tool {
  const price = tool._meta?.cascet?.priceUsd;
  const description = price
    ? `${tool.description ?? tool.name} [x402 price: ${price} per call]`
    : tool.description ?? tool.name;

  const schema = tool.inputSchema;
  const input_schema: Anthropic.Tool.InputSchema =
    schema && schema.type === "object"
      ? { type: "object", properties: schema.properties ?? {}, required: schema.required }
      : { type: "object", properties: {} };

  return { name: tool.name, description, input_schema };
}

/** Pull the text payload out of an MCP tool result's content blocks. */
function extractText(result: Record<string, unknown>): string {
  const content = result.content;
  if (!Array.isArray(content)) return JSON.stringify(result);
  const text = content
    .filter((c): c is { type: string; text: string } => c?.type === "text" && typeof c.text === "string")
    .map(c => c.text)
    .join("\n");
  return text || JSON.stringify(result);
}
