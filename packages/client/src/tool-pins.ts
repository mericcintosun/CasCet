import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Definition pinning against tool poisoning (OWASP MCP03).
 *
 * The first time a bridge sees a gateway, it records a sha256 of every tool
 * definition and of the gateway's `initialize` instructions (trust on first
 * use). Later, a tool whose definition no longer matches its pin, a tool that
 * appears after the gateway's tools were pinned, and instructions that changed
 * or appeared are quarantined: the bridge withholds them from the model,
 * refuses to call or pay for such a tool, and prints the full new text and its
 * sha256 to stderr. The user accepts exactly the definitions they reviewed by
 * restarting with `--accept-tool-changes=<sha256>[,<sha256>...]`. Any other
 * change stays quarantined, even while that flag is set, so a flag left in an
 * MCP host config never accepts a later change.
 */

/** Model-visible fields of an MCP tool definition; the pin covers exactly these. */
export const PINNED_TOOL_FIELDS = ["name", "title", "description", "inputSchema", "outputSchema", "annotations"] as const;

/** The `cascet connect` flag that accepts reviewed definitions by digest. */
export const ACCEPT_TOOL_CHANGES_FLAG = "--accept-tool-changes";

const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface ToolPinOptions {
  /** Pin file (JSON). `cascet connect` uses CASCET_TOOL_PINS or ~/.cascet/tool-pins.json. */
  path: string;
  /**
   * sha256 digests, as printed in a quarantine warning, of new or changed
   * definitions the user reviewed and accepts. Only a definition whose current
   * digest is listed is (re-)pinned; every other change stays quarantined.
   */
  acceptDigests?: readonly string[];
}

/** A pinned definition: a tool's pinned fields, or `{ instructions }` of a gateway. */
export interface PinnedDefinition {
  sha256: string;
  pinnedAt: string;
  /** The pinned fields, kept so a later change can be shown next to the original. */
  definition: Record<string, unknown>;
}

/** Pins of one gateway. */
export interface GatewayPins {
  tools: Record<string, PinnedDefinition>;
  /** The `instructions` of the gateway's initialize result, once it sent any. */
  instructions?: PinnedDefinition;
}

export interface PinFile {
  version: 1;
  gateways: Record<string, GatewayPins>;
}

/** Thrown when the pin file exists but cannot be read or parsed, or cannot be written. */
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

/** sha256 (hex) of a gateway's initialize instructions, as printed in a quarantine warning. */
export function instructionsDigest(instructions: string): string {
  return sha256(canonicalJson({ instructions }));
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

/**
 * Validate the digests a user accepts: 64 hex characters each (any letter
 * case, surrounding spaces ignored). Returns them lower-cased, de-duplicated.
 */
export function normalizeAcceptDigests(digests: readonly string[]): string[] {
  const out = new Set<string>();
  for (const entry of digests) {
    const digest = typeof entry === "string" ? entry.trim().toLowerCase() : "";
    if (!SHA256_HEX.test(digest)) {
      throw new Error(
        `${JSON.stringify(String(entry).slice(0, 80))} is not a sha256 digest (64 hex characters, as printed next to a quarantined tool)`,
      );
    }
    out.add(digest);
  }
  return [...out];
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

/**
 * Make sure new pins can be saved: create the pin file's directory (owner-only)
 * when it is missing and check that it is writable. Pins are written with a
 * temp file and a rename, so the directory is what must be writable.
 *
 * @throws PinFileError naming the path and the reason.
 */
export function ensurePinFileWritable(path: string): void {
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    accessSync(dir, constants.W_OK);
  } catch (err) {
    throw new PinFileError(
      `cannot save tool pins to ${path} (${(err as Error).message}); without saved pins every session would trust ` +
        "the gateway's tools on first use again",
    );
  }
}

type PinSubject = { kind: "tool"; name: string } | { kind: "instructions" };

interface PinChange {
  subject: PinSubject;
  kind: "new" | "changed";
  previous?: PinnedDefinition;
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
 * process; `inspect` every tools/list page and `inspectInstructions` every
 * initialize result the gateway serves, and ask `status` before calling a tool.
 */
export class ToolPinGuard {
  readonly path: string;
  readonly gatewayKey: string;
  private readonly acceptDigests: ReadonlySet<string>;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;
  private readonly trust = new Map<string, "trusted" | "quarantined">();
  /**
   * Tool pins made in this session (first use or accepted). They take
   * precedence over the file, so they hold even when the file cannot be
   * written (read-only directory, full disk).
   */
  private readonly sessionPins = new Map<string, PinnedDefinition>();
  private sessionInstructionsPin: PinnedDefinition | undefined;
  private instructionsTrust: "trusted" | "quarantined" | undefined;
  /**
   * Trust on first use, decided at the first check of this session and kept
   * for the whole session, so every page of the first tools/list is pinned.
   * Tools: the gateway had no tool pins. Instructions: it had no pins at all.
   */
  private toolsFirstContact: boolean | undefined;
  private instructionsFirstContact: boolean | undefined;
  /** Digests of the definitions quarantined in this session, for the combined accept flag. */
  private readonly quarantinedDigests: string[] = [];
  private inspected = false;

  constructor(gatewayUrl: string, options: ToolPinGuardOptions) {
    this.path = options.path;
    this.gatewayKey = gatewayPinKey(gatewayUrl);
    this.acceptDigests = new Set(normalizeAcceptDigests(options.acceptDigests ?? []));
    this.log = options.log ?? (line => console.error(line));
    this.now = options.now ?? (() => new Date());
    readPinFile(this.path); // fail fast on a corrupt pin file
    ensurePinFileWritable(this.path); // and on one that could never be saved
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
   * changed or new tools, pin the accepted ones. Returns the names to withhold
   * from the model. Quarantine is sticky for the rest of the session.
   */
  inspect(tools: readonly unknown[]): { quarantined: Set<string> } {
    const quarantined = new Set<string>();
    const store = this.load();
    if (!store) {
      // Fail closed: without readable pins nothing can be verified.
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
    this.toolsFirstContact ??= entry === undefined || Object.keys(entry.tools).length === 0;
    const pinned = entry?.tools ?? {};
    const updates = new Map<string, PinnedDefinition>();
    const firstPins: string[] = [];
    const timestamp = this.now().toISOString();
    let quarantinedNow = false;

    for (const tool of tools) {
      if (!isRecord(tool) || typeof tool.name !== "string") continue;
      const name = tool.name;
      if (this.trust.get(name) === "quarantined") {
        quarantined.add(name);
        continue;
      }
      const definition = pinnedToolDefinition(tool);
      const digest = sha256(canonicalJson(definition));
      const previous = this.sessionPins.get(name) ?? own(pinned, name);
      if (previous?.sha256 === digest) {
        this.trust.set(name, "trusted");
        continue;
      }
      const pin: PinnedDefinition = { sha256: digest, pinnedAt: timestamp, definition };
      if (!previous && this.toolsFirstContact) {
        this.sessionPins.set(name, pin);
        updates.set(name, pin);
        firstPins.push(name);
        this.trust.set(name, "trusted");
        continue;
      }
      const change: PinChange = {
        subject: { kind: "tool", name },
        kind: previous ? "changed" : "new",
        previous,
        sha256: digest,
        definition,
      };
      if (this.acceptDigests.has(digest)) {
        this.sessionPins.set(name, pin);
        updates.set(name, pin);
        this.trust.set(name, "trusted");
        this.report(change, "accepted");
        continue;
      }
      this.trust.set(name, "quarantined");
      quarantined.add(name);
      this.quarantine(change);
      quarantinedNow = true;
    }

    if (updates.size > 0) this.persist({ tools: updates });
    if (firstPins.length > 0) {
      this.log(
        `[cascet] pinned ${firstPins.length} tool definition(s) of ${this.gatewayKey} on first use ` +
          `(${firstPins.map(sanitize).join(", ")}) in ${this.path}. A later change to any of them will be refused until you accept it.`,
      );
    }
    if (quarantinedNow) this.logCombinedFlag();
    this.inspected = true;
    return { quarantined };
  }

  /**
   * Check the `instructions` of an initialize result, which many MCP hosts put
   * straight into the model's context. Returns true when they may be passed
   * on, false when they must be withheld: changed or new since the gateway was
   * pinned, not text, or unverifiable (unreadable pin file).
   */
  inspectInstructions(instructions: unknown): boolean {
    if (instructions === undefined) return true;
    if (typeof instructions !== "string") {
      this.log(`[cascet] WARNING: ${this.gatewayKey} sent initialize instructions that are not text; withholding them.`);
      return false;
    }
    if (this.instructionsTrust === "quarantined") return false;
    const store = this.load();
    if (!store) return false;

    const entry = own(store.gateways, this.gatewayKey);
    this.instructionsFirstContact ??=
      entry === undefined || (Object.keys(entry.tools).length === 0 && entry.instructions === undefined);
    const definition = { instructions };
    const digest = sha256(canonicalJson(definition));
    const previous = this.sessionInstructionsPin ?? entry?.instructions;
    if (previous?.sha256 === digest) {
      this.instructionsTrust = "trusted";
      return true;
    }
    const pin: PinnedDefinition = { sha256: digest, pinnedAt: this.now().toISOString(), definition };
    if (!previous && this.instructionsFirstContact) {
      this.sessionInstructionsPin = pin;
      this.instructionsTrust = "trusted";
      this.persist({ instructions: pin });
      this.log(`[cascet] pinned the initialize instructions of ${this.gatewayKey} on first use in ${this.path}.`);
      return true;
    }
    const change: PinChange = {
      subject: { kind: "instructions" },
      kind: previous ? "changed" : "new",
      previous,
      sha256: digest,
      definition,
    };
    if (this.acceptDigests.has(digest)) {
      this.sessionInstructionsPin = pin;
      this.instructionsTrust = "trusted";
      this.persist({ instructions: pin });
      this.report(change, "accepted");
      return true;
    }
    this.instructionsTrust = "quarantined";
    this.quarantine(change);
    this.logCombinedFlag();
    return false;
  }

  /** Read the pin file, or log the failure and return undefined (callers fail closed). */
  private load(): PinFile | undefined {
    try {
      return readPinFile(this.path);
    } catch (err) {
      this.log(
        `[cascet] ERROR: ${(err as Error).message}. Refusing every tool of ${this.gatewayKey} and withholding ` +
          "its instructions until this is fixed.",
      );
      return undefined;
    }
  }

  private persist(update: { tools?: ReadonlyMap<string, PinnedDefinition>; instructions?: PinnedDefinition }): void {
    try {
      const store = readPinFile(this.path); // re-read: another bridge may have written meanwhile
      let entry = own(store.gateways, this.gatewayKey);
      if (!entry) {
        entry = { tools: {} };
        defineOwn(store.gateways, this.gatewayKey, entry);
      }
      // defineProperty, not assignment: a tool named "__proto__" must stay an ordinary key.
      for (const [name, pin] of update.tools ?? []) defineOwn(entry.tools, name, pin);
      if (update.instructions) entry.instructions = update.instructions;
      writePinFile(this.path, store);
    } catch (err) {
      this.log(
        `[cascet] WARNING: could not save pins to ${this.path} (${(err as Error).message}); ` +
          "they apply to this session only, and the next session will trust this gateway on first use again.",
      );
    }
  }

  private quarantine(change: PinChange): void {
    if (!this.quarantinedDigests.includes(change.sha256)) this.quarantinedDigests.push(change.sha256);
    this.report(change, "quarantined");
  }

  /** After several quarantines, print one flag that accepts all of them (each was shown in full above). */
  private logCombinedFlag(): void {
    if (this.quarantinedDigests.length < 2) return;
    this.log(
      `[cascet] ${this.quarantinedDigests.length} definitions of ${this.gatewayKey} are quarantined. After reviewing ` +
        `each one above, accept all of them with: ${ACCEPT_TOOL_CHANGES_FLAG}=${this.quarantinedDigests.join(",")}`,
    );
  }

  private report(change: PinChange, outcome: "quarantined" | "accepted"): void {
    const isTool = change.subject.kind === "tool";
    const rule = "#".repeat(78);
    const lines: string[] = [rule];
    if (outcome === "quarantined") {
      const what = isTool
        ? change.kind === "changed"
          ? "A TOOL DEFINITION CHANGED since it was pinned"
          : "A NEW TOOL appeared after this gateway's tools were pinned"
        : change.kind === "changed"
          ? "THE GATEWAY'S INSTRUCTIONS CHANGED since they were pinned"
          : "NEW INSTRUCTIONS appeared after this gateway was pinned";
      lines.push(`WARNING: ${what} (possible tool poisoning, OWASP MCP03)`);
    } else {
      const what = isTool
        ? change.kind === "changed"
          ? "re-pinned the changed tool below"
          : "pinned the new tool below"
        : change.kind === "changed"
          ? "re-pinned the gateway's changed instructions below"
          : "pinned the gateway's new instructions below";
      lines.push(`NOTICE: ${what}, which you accepted with ${ACCEPT_TOOL_CHANGES_FLAG}=${change.sha256}`);
    }
    lines.push(`  gateway : ${this.gatewayKey}`);
    if (change.subject.kind === "tool") lines.push(`  tool    : ${sanitize(change.subject.name)}`);
    if (change.previous) {
      lines.push(`  pinned  : sha256 ${change.previous.sha256} (${sanitize(change.previous.pinnedAt)})`);
    }
    lines.push(`  now     : sha256 ${change.sha256}`);
    if (isTool) {
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
    } else {
      if (change.previous) {
        lines.push("  pinned instructions:");
        lines.push(...block(change.previous.definition.instructions));
      }
      lines.push("  instructions now served (full):");
      lines.push(...block(change.definition.instructions));
    }
    if (outcome === "quarantined") {
      lines.push(
        isTool
          ? "CasCet withholds this tool from the model and refuses to call or pay for it."
          : "CasCet withholds these instructions from the model.",
      );
      lines.push("If you reviewed the text above and trust it, accept exactly this version by restarting");
      lines.push(`cascet connect with: ${ACCEPT_TOOL_CHANGES_FLAG}=${change.sha256}`);
      lines.push("Any other change stays quarantined, even while that flag is set.");
    } else {
      lines.push("The flag accepts only this exact version; you can remove it now.");
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

function isPinnedDefinition(value: unknown): value is PinnedDefinition {
  return (
    isRecord(value) &&
    typeof value.sha256 === "string" &&
    SHA256_HEX.test(value.sha256) &&
    typeof value.pinnedAt === "string" &&
    isRecord(value.definition)
  );
}

function isPinFile(value: unknown): value is PinFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.gateways)) return false;
  for (const gateway of Object.values(value.gateways)) {
    if (!isRecord(gateway) || !isRecord(gateway.tools)) return false;
    if (gateway.instructions !== undefined && !isPinnedDefinition(gateway.instructions)) return false;
    for (const tool of Object.values(gateway.tools)) {
      if (!isPinnedDefinition(tool)) return false;
    }
  }
  return true;
}
