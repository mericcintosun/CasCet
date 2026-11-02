import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isAuthorizationStyle } from "@cascet/core";
import { ledgerKey, type PersistedAuthorization } from "./authorization-ledger.js";
import { logText, type FacilitatorLogger } from "./facilitator-core.js";

/**
 * The self-hosted facilitator's state file (F11): every authorization it holds
 * a settlement transaction for, so that a restarted facilitator never submits
 * a second transaction for one of them (it would revert, the nonce being used,
 * and burn its whole gas limit) and answers a settle retry with the hash it
 * knows. A settle retry of a payment that was still pending follows its
 * transaction, as it would without the restart.
 *
 * Format (JSON, one file per facilitator):
 *
 *   {
 *     "format": "cascet-facilitator-state",
 *     "version": 1,
 *     "network": "casper:casper",
 *     "authorizations": [
 *       {
 *         "asset": "<token package hash, 64 hex>",
 *         "from": "00<payer account hash, 64 hex>",
 *         "nonce": "<64 hex>",
 *         "txHash": "<settlement transaction, 64 hex>",
 *         "state": "submitted" | "settled" | "failed",
 *         "validBefore": <unix seconds>,
 *         // "submitted" only: no final outcome seen, the transaction may still execute
 *         "value": "<decimal>",            // still counted against the payer's balance
 *         "status": "pending" | "unknown", // what the last settle of the payment answered
 *         "fingerprint": "<64 hex>",       // SHA-256 of the exact payment: only it may follow
 *         "style": "legacy-amount" | "cep3009-value"
 *       }
 *     ]
 *   }
 *
 * It holds no key and no signature, and only authorizations that can still
 * execute: an entry is dropped once its validBefore is more than 60 s past.
 *
 * Writes are atomic and durable: a temporary file in the same directory
 * (created exclusively, mode 0600) is written and fsynced, renamed over the
 * file, and the directory is fsynced. A reader, a backup or a crash sees the
 * previous complete state or the new one, never a mix. Saves are coalesced:
 * the changes made while a write runs go out together in the next one.
 *
 * Loading is strict and fails closed: a file that is not valid JSON, not this
 * format, another version or another network's, or has any entry that is not
 * exactly what this module writes, keeps the facilitator from starting (it may
 * hold transactions that can still execute). A missing file is an empty state.
 */

export const STATE_FILE_FORMAT = "cascet-facilitator-state";
export const STATE_FILE_VERSION = 1;

/** The state file cannot be read or understood: the facilitator must not start. */
export class FacilitatorStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FacilitatorStateError";
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const ACCOUNT_KEY = /^00[0-9a-f]{64}$/;
/** Canonical decimal of at most 78 digits (a U256). */
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const norm = (s: string) => s.toLowerCase().replace(/^0x/, "");
const excerpt = (v: unknown) => logText(JSON.stringify(v) ?? String(v)).slice(0, 40);

/** The state file's text for `records`: exactly what {@link parseFacilitatorState} reads back. */
export function serializeFacilitatorState(network: string, records: readonly PersistedAuthorization[]): string {
  const authorizations = records.map(r => ({
    asset: norm(r.id.asset).replace(/^hash-/, ""),
    from: norm(r.id.from),
    nonce: norm(r.id.nonce),
    txHash: r.txHash.toLowerCase(),
    state: r.state,
    validBefore: r.validBefore,
    ...(r.state === "submitted"
      ? {
          value: (r.value ?? 0n).toString(),
          status: r.status ?? "unknown",
          ...(r.fingerprint !== undefined && r.style !== undefined ? { fingerprint: r.fingerprint.toLowerCase(), style: r.style } : {}),
        }
      : {}),
  }));
  return `${JSON.stringify({ format: STATE_FILE_FORMAT, version: STATE_FILE_VERSION, network, authorizations }, null, 2)}\n`;
}

/**
 * Read the text of a state file kept for `network`. Throws
 * {@link FacilitatorStateError} naming the first thing that is wrong.
 */
export function parseFacilitatorState(text: string, network: string): PersistedAuthorization[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new FacilitatorStateError("it is not valid JSON");
  }
  if (!isObject(doc) || doc["format"] !== STATE_FILE_FORMAT) throw new FacilitatorStateError(`it is not a ${STATE_FILE_FORMAT} file`);
  if (doc["version"] !== STATE_FILE_VERSION) {
    throw new FacilitatorStateError(`its version is ${excerpt(doc["version"])}; this facilitator reads version ${STATE_FILE_VERSION}`);
  }
  if (doc["network"] !== network) throw new FacilitatorStateError(`it was kept for ${excerpt(doc["network"])}, not ${network}`);
  const list = doc["authorizations"];
  if (!Array.isArray(list)) throw new FacilitatorStateError("authorizations must be a list");
  const seen = new Set<string>();
  return list.map((raw, i) => {
    const record = parseRecord(raw, `authorizations[${i}]`, network);
    const key = ledgerKey(record.id);
    if (seen.has(key)) throw new FacilitatorStateError(`authorizations[${i}] repeats an earlier authorization`);
    seen.add(key);
    return record;
  });
}

function parseRecord(raw: unknown, where: string, network: string): PersistedAuthorization {
  if (!isObject(raw)) throw new FacilitatorStateError(`${where} must be an object`);
  const text = (name: string, pattern: RegExp, what: string): string => {
    const v = raw[name];
    if (typeof v !== "string" || !pattern.test(v)) throw new FacilitatorStateError(`${where}.${name} must be ${what}`);
    return v;
  };
  const asset = text("asset", HEX64, "a package hash (64 lower-case hex)");
  const from = text("from", ACCOUNT_KEY, "an account-hash Key (00 + 64 lower-case hex)");
  const nonce = text("nonce", HEX64, "64 lower-case hex");
  const txHash = text("txHash", HEX64, "a transaction hash (64 lower-case hex)");
  const state = raw["state"];
  if (state !== "submitted" && state !== "settled" && state !== "failed") {
    throw new FacilitatorStateError(`${where}.state must be submitted, settled or failed`);
  }
  const validBefore = raw["validBefore"];
  if (typeof validBefore !== "number" || !Number.isSafeInteger(validBefore) || validBefore <= 0) {
    throw new FacilitatorStateError(`${where}.validBefore must be unix seconds`);
  }
  const id = { network, asset, from, nonce };
  if (state !== "submitted") return { id, txHash, state, validBefore };

  const value = BigInt(text("value", DECIMAL, "a decimal amount"));
  const status = raw["status"];
  if (status !== "pending" && status !== "unknown") throw new FacilitatorStateError(`${where}.status must be pending or unknown`);
  if ((raw["fingerprint"] === undefined) !== (raw["style"] === undefined)) {
    throw new FacilitatorStateError(`${where} must have both fingerprint and style, or neither`);
  }
  if (raw["fingerprint"] === undefined) return { id, txHash, state, validBefore, value, status };
  const fingerprint = text("fingerprint", HEX64, "a payment fingerprint (64 lower-case hex)");
  const style = raw["style"];
  if (!isAuthorizationStyle(style)) throw new FacilitatorStateError(`${where}.style must be legacy-amount or cep3009-value`);
  return { id, txHash, state, validBefore, value, status, fingerprint, style };
}

/**
 * Load the state file at `path`, kept for `network`: its records, or an empty
 * state when there is no such file. Anything else that keeps the file from
 * being read and understood throws {@link FacilitatorStateError}.
 */
export async function loadFacilitatorState(path: string, network: string): Promise<{ records: PersistedAuthorization[]; found: boolean }> {
  let text: string;
  try {
    text = await nodeFs.readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { records: [], found: false };
    throw new FacilitatorStateError(`cannot read the state file ${path}: ${code ?? logText(err)}`);
  }
  try {
    return { records: parseFacilitatorState(text, network), found: true };
  } catch (err) {
    throw new FacilitatorStateError(
      `the state file ${path} is not a valid facilitator state: ${(err as Error).message}. It may hold settlement ` +
        "transactions that can still execute: restore it from a backup, or move it away only once every authorization " +
        "it can hold has expired (the longest authorization validity, 3600 s by default, plus 60 s)",
    );
  }
}

/** The file operations of an atomic write: node:fs/promises, or a spy in tests. */
export interface StateFileSystem {
  open(path: string, flags: string, mode?: number): Promise<FileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

/**
 * Platforms that cannot open or fsync a directory (Windows) answer with these:
 * the file's content is durable already, only the rename's durability is best
 * effort there.
 */
const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EISDIR", "EPERM", "EACCES", "EINVAL", "ENOTSUP", "EBADF"]);

/**
 * Replace `path` with `text` atomically and durably: a new temporary file in
 * the same directory (exclusive, mode 0600) is written and fsynced, renamed
 * over `path`, and the directory is fsynced. On any failure before the rename,
 * the temporary file is removed and `path` keeps its previous content.
 */
export async function writeFileAtomic(path: string, text: string, fs: StateFileSystem = nodeFs): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  let handle: FileHandle | undefined;
  let created = false;
  try {
    handle = await fs.open(tmp, "wx", 0o600);
    created = true;
    await handle.chmod(0o600); // whatever the umask: payer accounts and transactions, for the owner only
    await handle.writeFile(text, "utf8");
    await handle.sync(); // the content is on disk before the name points at it
    await handle.close();
    handle = undefined;
    await fs.rename(tmp, path); // atomic: readers see the old file or the new one
  } catch (err) {
    await handle?.close().catch(() => undefined);
    if (created) await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
  // The rename survives a power loss once the directory entry is on disk too.
  let dirHandle: FileHandle | undefined;
  try {
    dirHandle = await fs.open(dir, "r");
    await dirHandle.sync();
  } catch (err) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
  } finally {
    await dirHandle?.close().catch(() => undefined);
  }
}

export interface FacilitatorStateFileOptions {
  path: string;
  network: string;
  /** What to save, read when a write starts: the ledger's `persistedAuthorizations()`. */
  snapshot: () => readonly PersistedAuthorization[];
  /** Where a failed background save is reported. */
  log: Pick<FacilitatorLogger, "error">;
  /** File operations (tests). */
  fs?: StateFileSystem;
}

/**
 * Saves the ledger to its state file, one write at a time. A save requested
 * while a write runs joins the next write, whose snapshot is taken when it
 * starts, so it includes every change made until then.
 */
export class FacilitatorStateFile {
  readonly path: string;
  private readonly network: string;
  private readonly snapshot: () => readonly PersistedAuthorization[];
  private readonly log: Pick<FacilitatorLogger, "error">;
  private readonly fs: StateFileSystem;
  /** Settles once the last write started so far has finished; never rejects. */
  private tail: Promise<void> = Promise.resolve();
  /** The next write, not started yet: save requests join it. */
  private queued: Promise<void> | undefined;
  /** The write whose failure a background save already reports. */
  private reported: Promise<void> | undefined;
  private failed = false;

  constructor(opts: FacilitatorStateFileOptions) {
    this.path = opts.path;
    this.network = opts.network;
    this.snapshot = opts.snapshot;
    this.log = opts.log;
    this.fs = opts.fs ?? nodeFs;
  }

  /**
   * Save the current state. Resolves once a write that includes every change
   * made before this call is on disk; rejects when that write fails.
   */
  save(): Promise<void> {
    if (this.queued) return this.queued;
    const write = this.tail.then(async () => {
      // Changes from here on need another write: this one's snapshot is taken now.
      this.queued = undefined;
      try {
        await writeFileAtomic(this.path, serializeFacilitatorState(this.network, this.snapshot()), this.fs);
        this.failed = false;
      } catch (err) {
        this.failed = true;
        throw err;
      }
    });
    this.queued = write;
    this.tail = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  /** Save in the background after a change: a failure is logged, and the next save tries again. */
  schedule(): void {
    const write = this.save();
    if (write === this.reported) return;
    this.reported = write;
    write.catch(err =>
      this.log.error(`could not save the state file ${this.path}: ${logText(err)}; the next change or the minute's sweep saves it again`),
    );
  }

  /** True after a failed write, until one succeeds: the file is behind the ledger. */
  get stale(): boolean {
    return this.failed;
  }
}
