/**
 * MCP protocol versions this gateway speaks.
 *
 * The gateway implements the tools subset of MCP over a stateless JSON
 * Streamable HTTP endpoint (no sessions, no server-sent events). These are the
 * revisions whose tools/list and tools/call messages it handles as specified.
 * Kept explicit rather than imported from the SDK so a new SDK release cannot
 * silently make the gateway claim support for a revision it was never checked
 * against.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export const LATEST_PROTOCOL_VERSION = "2025-11-25";

export function isSupportedProtocolVersion(version: unknown): version is string {
  return typeof version === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(version);
}

/**
 * Version negotiation for `initialize`: answer with the client's version when
 * the gateway supports it, otherwise with the latest version the gateway
 * supports (the client then decides whether it can continue).
 */
export function negotiateProtocolVersion(requested: unknown): string {
  return isSupportedProtocolVersion(requested) ? requested : LATEST_PROTOCOL_VERSION;
}
