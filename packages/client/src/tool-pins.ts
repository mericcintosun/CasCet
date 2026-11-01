import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Tool-definition pinning against tool poisoning (OWASP MCP03).
 *
 * The first time a bridge sees a gateway, it records a sha256 of every tool
 * definition it is served (trust on first use). On later runs, a tool whose
 * definition no longer matches its pin, or a tool that appears after the
 * gateway was pinned, is quarantined: the bridge withholds its definition from
 * the model, refuses to call or pay for it, and prints the full new definition
 * to stderr. The user accepts a change by restarting with
 * `--accept-tool-changes`, which re-pins the definitions served in that run.
 */

/** Model-visible fields of an MCP tool definition; the pin covers exactly these. */
export const PINNED_TOOL_FIELDS = ["name", "title", "description", "inputSchema", "outputSchema", "annotations"] as const;

export interface ToolPinOptions {
  /** Pin file (JSON). `cascet connect` uses CASCET_TOOL_PINS or ~/.cascet/tool-pins.json. */
  path: string;
  /** Accept new or changed definitions and re-pin them (the user passed --accept-tool-changes). */
  acceptChanges?: boolean;
}

export interface PinnedTool {
  sha256: string;
  pinnedAt: string;
  /** The pinned fields, kept so a later change can be shown next to the original. */
  definition: Record<string, unknown>;
}

export interface PinFile {
  version: 1;
  gateways: Record<string, { tools: Record<string, PinnedTool> }>;
}

/** Thrown when the pin file exists but cannot be read or parsed. */
export class PinFileError extends Error {
  override name = "PinFileError";
}

export type ToolTrust = "trusted" | "quarantined" | "unknown";

/** Default pin file: ~/.cascet/tool-pins.json. */
export function defaultToolPinsPath(): string {
  return join(homedir(), ".cascet", "tool-pins.json");
}

/** The pin key for a gateway: origin + path, without credentials, query or fragment. */
export function gatewayPinKey(gatewayUrl: string): string {
  const url = new URL(gatewayUrl);
  return `${url.origin}${url.pathname}`;
}

/** The pinned fields of a tool definition (undefined fields omitted). */
export function pinnedToolDefinition(tool: Record<string, unknown>): Record<string, unknown> {
  const definition: Record<string, unknown> = {};
  for (const field of PINNED_TOOL_FIELDS) {
    if (tool[field] !== undefined) definition[field] = tool[field];
  }
  return definition;
}

/** sha256 (hex) over the canonical JSON of a tool's pinned fields. */
export function toolDigest(tool: Record<string, unknown>): string {
  return sha256(canonicalJson(pinnedToolDefinition(tool)));
}

/** JSON with object keys sorted at every level, so key order never changes a digest. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Read a pin file. A missing file is an empty store; anything unreadable or malformed throws PinFileError. */
export function readPinFile(path: string): PinFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return { version: 1, gateways: {} };
    throw new PinFileError(`cannot read the tool pin file ${path}: ${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new PinFileError(`the tool pin file ${path} is not valid JSON; fix it or delete it to pin again`);
  }
  if (!isPinFile(data)) {
    throw new PinFileError(`the tool pin file ${path} has an unexpected format; fix it or delete it to pin again`);
  }
  return data;
}

/** Write a pin file atomically (temp file + rename), readable by the owner only. */
export function writePinFile(path: string, store: PinFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

interface ToolChange {
  name: string;
  kind: "new" | "changed";
  previous?: PinnedTool;
  sha256: string;
  definition: Record<string, unknown>;
}

export interface ToolPinGuardOptions extends ToolPinOptions {
  /** Receives warnings, one line per call (default: stderr). */
  log?: (line: string) => void;
  /** Clock, for tests. */
  now?: () => Date;
}

/**
 * Per-session pin checker for one gateway. Construct it once per bridge
 * process; `inspect` every tools/list page the gateway serves, and ask
 * `status` before calling a tool.
 */
export class ToolPinGuard {
  readonly path: string;
  readonly gatewayKey: string;
  private readonly acceptChanges: boolean;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;
  private readonly trust = new Map<string, "trusted" | "quarantined">();
  /** True when the gateway had no pins when this session first inspected it (trust on first use). */
  private firstContact: boolean | undefined;
  private inspected = false;

  constructor(gatewayUrl: string, options: ToolPinGuardOptions) {
    this.path = options.path;
    this.gatewayKey = gatewayPinKey(gatewayUrl);
    this.acceptChanges = options.acceptChanges ?? false;
    this.log = options.log ?? (line => console.error(line));
    this.now = options.now ?? (() => new Date());
    readPinFile(this.path); // fail fast on a corrupt pin file
  }

  /** True once at least one tools/list page has been inspected in this session. */
  get hasInspected(): boolean {
    return this.inspected;
  }

  /** Trust state of a tool in this session; "unknown" until a tools/list that includes it was inspected. */
  status(name: string): ToolTrust {
    return this.trust.get(name) ?? "unknown";
  }

  /**
   * Check one tools/list page against the pins: pin on first contact, detect
   * changed or new tools, persist accepted pins. Returns the names to withhold
   * from the model. Quarantine is sticky for the rest of the session.
   */
  inspect(tools: readonly unknown[]): { quarantined: Set<string> } {
    const quarantined = new Set<string>();
    let store: PinFile;
    try {
      store = readPinFile(this.path);
    } catch (err) {
      // Fail closed: without readable pins nothing can be verified.
      this.log(`[cascet] ERROR: ${(err as Error).message}. Refusing every tool of ${this.gatewayKey} until this is fixed.`);
      for (const tool of tools) {
        if (isRecord(tool) && typeof tool.name === "string") {
          this.trust.set(tool.name, "quarantined");
          quarantined.add(tool.name);
        }
      }
      this.inspected = true;
      return { quarantined };
    }

    const entry = own(store.gateways, this.gatewayKey);
    if (this.firstContact === undefined) this.firstContact = entry === undefined;
    const pinned = entry?.tools ?? {};
    const updates = new Map<string, PinnedTool>();
    const firstPins: string[] = [];
    const timestamp = this.now().toISOString();

    for (const tool of tools) {
      if (!isRecord(tool) || typeof tool.name !== "string") continue;
      const name = tool.name;
      if (this.trust.get(name) === "quarantined") {
        quarantined.add(name);
        continue;
      }
      const definition = pinnedToolDefinition(tool);
      const digest = sha256(canonicalJson(definition));
      const previous = updates.get(name) ?? own(pinned, name);
      if (previous && previous.sha256 === digest) {
        this.trust.set(name, "trusted");
        continue;
      }
      if (!previous && this.firstContact) {
        updates.set(name, { sha256: digest, pinnedAt: timestamp, definition });
        firstPins.push(name);
        this.trust.set(name, "trusted");
        continue;
      }
      const change: ToolChange = { name, kind: previous ? "changed" : "new", previous, sha256: digest, definition };
      if (this.acceptChanges) {
        updates.set(name, { sha256: digest, pinnedAt: timestamp, definition });
        this.trust.set(name, "trusted");
        this.report(change, "accepted");
        continue;
      }
      this.trust.set(name, "quarantined");
      quarantined.add(name);
      this.report(change, "quarantined");
    }

    if (updates.size > 0) this.persist(updates);
    if (firstPins.length > 0) {
      this.log(
        `[cascet] pinned ${firstPins.length} tool definition(s) of ${this.gatewayKey} on first use ` +
          `(${firstPins.map(sanitize).join(", ")}) in ${this.path}. A later change to any of them will be refused until you accept it.`,
      );
    }
    this.inspected = true;
    return { quarantined };
  }

  private persist(updates: ReadonlyMap<string, PinnedTool>): void {
    try {
      const store = readPinFile(this.path); // re-read: another bridge may have written meanwhile
      let entry = own(store.gateways, this.gatewayKey);
      if (!entry) {
        entry = { tools: {} };
        defineOwn(store.gateways, this.gatewayKey, entry);
      }
      // defineProperty, not assignment: a tool named "__proto__" must stay an ordinary key.
      for (const [name, pin] of updates) defineOwn(entry.tools, name, pin);
      writePinFile(this.path, store);
    } catch (err) {
      this.log(
        `[cascet] WARNING: could not save tool pins to ${this.path} (${(err as Error).message}); ` +
          "they apply to this session only.",
      );
    }
  }

  private report(change: ToolChange, outcome: "quarantined" | "accepted"): void {
    const rule = "#".repeat(78);
    const lines: string[] = [rule];
    if (outcome === "quarantined") {
      lines.push(
        change.kind === "changed"
          ? "WARNING: A TOOL DEFINITION CHANGED since it was pinned (possible tool poisoning, OWASP MCP03)"
          : "WARNING: A NEW TOOL appeared after this gateway's tools were pinned (possible tool poisoning, OWASP MCP03)",
      );
    } else {
      lines.push(
        `NOTICE: --accept-tool-changes re-pinned the ${change.kind === "changed" ? "changed" : "new"} tool below`,
      );
    }
    lines.push(`  gateway : ${this.gatewayKey}`);
    lines.push(`  tool    : ${sanitize(change.name)}`);
    if (change.previous) {
      lines.push(`  pinned  : sha256 ${change.previous.sha256} (${sanitize(change.previous.pinnedAt)})`);
    }
    lines.push(`  now     : sha256 ${change.sha256}`);
    if (change.previous) {
      lines.push("  pinned description:");
      lines.push(...block(change.previous.definition.description));
    }
    lines.push("  description now served (full):");
    lines.push(...block(change.definition.description));
    const { description: _description, name: _name, ...rest } = change.definition;
    if (Object.keys(rest).length > 0) {
      lines.push("  other pinned fields now served (inputSchema, title, outputSchema, annotations):");
      lines.push(...block(JSON.stringify(rest, null, 2)));
    }
    if (outcome === "quarantined") {
      lines.push("CasCet withholds this tool from the model and refuses to call or pay for it.");
      lines.push("If you trust the new definition, restart `cascet connect` with --accept-tool-changes.");
    }
    lines.push(`Pins: ${this.path}`);
    lines.push(rule);
    for (const line of lines) this.log(`[cascet] ${line}`);
  }
}

function block(value: unknown): string[] {
  if (value === undefined) return ["    | (none)"];
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return sanitize(text)
    .split("\n")
    .map(line => `    | ${line}`);
}

/**
 * Make control, bidi-override and zero-width characters visible, so a hostile
 * description cannot rewrite the terminal or hide text inside the warning.
 */
function sanitize(text: string): string {
  return text.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Own-property lookup, so names such as "constructor" never resolve to Object.prototype. */
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function defineOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPinFile(value: unknown): value is PinFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.gateways)) return false;
  for (const gateway of Object.values(value.gateways)) {
    if (!isRecord(gateway) || !isRecord(gateway.tools)) return false;
    for (const tool of Object.values(gateway.tools)) {
      if (
        !isRecord(tool) ||
        typeof tool.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(tool.sha256) ||
        typeof tool.pinnedAt !== "string" ||
        !isRecord(tool.definition)
      ) {
        return false;
      }
    }
  }
  return true;
}
