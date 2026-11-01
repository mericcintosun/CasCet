/**
 * Logging helpers.
 *
 * Values that come from requests, the upstream MCP server or the facilitator
 * are untrusted: they can carry CR/LF (forged log lines), terminal or bidi
 * control characters, or printf-style "%" sequences. Every log call therefore
 * uses a constant "%s" format string, and every untrusted value goes through
 * `logSafe` before it is interpolated into a message.
 */

// C0/C1 controls (except \t, \n, \r, which are folded to spaces first), zero-width
// direction marks, line/paragraph separators and bidi embedding/isolate controls.
const UNSAFE_RANGES: Array<[number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x200e, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];
const UNSAFE_CHARS = new RegExp(
  `[${UNSAFE_RANGES.map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join("")}]`,
  "gu",
);

/** Render an untrusted value as a single, bounded, control-free log fragment. */
export function logSafe(value: unknown, max = 300): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value instanceof Error) {
    text = value.message;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  const cleaned = text.replace(/[\r\n\t]+/g, " ").replace(UNSAFE_CHARS, "?");
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/** Console logging with a constant format string. Build messages with `logSafe` for untrusted parts. */
export const log = {
  info(message: string): void {
    console.log("%s", message);
  },
  warn(message: string): void {
    console.warn("%s", message);
  },
  error(message: string): void {
    console.error("%s", message);
  },
};

/** Error message of an unknown thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
