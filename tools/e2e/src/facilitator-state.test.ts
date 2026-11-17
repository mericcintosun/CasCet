import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { AuthorizationLedger, type PersistedAuthorization } from "./authorization-ledger.js";
import {
  FacilitatorStateFile,
  loadFacilitatorState,
  parseFacilitatorState,
  serializeFacilitatorState,
  writeFileAtomic,
  type StateFileSystem,
} from "./facilitator-state.js";
import { FakeClock } from "./test-helpers.js";

const NETWORK = "casper:casper";
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const NOW = Math.floor(T0 / 1000);
const ID = { network: NETWORK, asset: "8d".repeat(32), from: `00${"65".repeat(32)}`, nonce: "9c".repeat(32) };

const RECORDS: PersistedAuthorization[] = [
  {
    id: ID,
    txHash: "ab".repeat(32),
    state: "submitted",
    validBefore: NOW + 300,
    value: 500_000_000n,
    status: "pending",
    fingerprint: "f1".repeat(32),
    style: "legacy-amount",
  },
  { id: { ...ID, nonce: "01".repeat(32) }, txHash: "ac".repeat(32), state: "submitted", validBefore: NOW + 200, value: 7n, status: "unknown" },
  { id: { ...ID, nonce: "02".repeat(32) }, txHash: "ad".repeat(32), state: "settled", validBefore: NOW + 100 },
  { id: { ...ID, nonce: "03".repeat(32) }, txHash: "ae".repeat(32), state: "failed", validBefore: NOW + 100 },
];

const quietLog = { error: () => {} };

/** node:fs/promises with every operation recorded, and failures on demand. */
function spyFs(hooks: { syncError?: Error; renameError?: Error; beforeOpen?: () => Promise<void> } = {}) {
  const ops: string[] = [];
  const wrap = (h: FileHandle, name: string): FileHandle =>
    ({
      chmod: async (mode: number) => {
        ops.push(`chmod ${name} ${mode.toString(8)}`);
        return h.chmod(mode);
      },
      writeFile: async (data: string, encoding: BufferEncoding) => {
        ops.push(`write ${name}`);
        return h.writeFile(data, encoding);
      },
      sync: async () => {
        ops.push(`sync ${name}`);
        if (name === "tmp" && hooks.syncError) throw hooks.syncError;
        return h.sync();
      },
      close: async () => {
        ops.push(`close ${name}`);
        return h.close();
      },
    }) as unknown as FileHandle;
  const fs: StateFileSystem = {
    async open(path, flags, mode) {
      await hooks.beforeOpen?.();
      const name = flags === "r" ? "dir" : "tmp";
      ops.push(`open ${name} ${flags}${mode !== undefined ? ` ${mode.toString(8)}` : ""}`);
      return wrap(await nodeFs.open(path, flags, mode), name);
    },
    async rename(oldPath, newPath) {
      ops.push("rename");
      if (hooks.renameError) throw hooks.renameError;
      return nodeFs.rename(oldPath, newPath);
    },
    async unlink(path) {
      ops.push("unlink");
      return nodeFs.unlink(path);
    },
  };
  return { fs, ops };
}

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "cascet-state-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** A fresh directory per test. */
function testDir(name: string): string {
  const d = join(dir, name);
  mkdirSync(d);
  return d;
}

describe("state file format", () => {
  test("what is saved is read back exactly, in the documented shape", () => {
    const text = serializeFacilitatorState(NETWORK, RECORDS);
    assert.deepEqual(parseFacilitatorState(text, NETWORK), RECORDS);
    const doc = JSON.parse(text) as { authorizations: unknown[] };
    assert.deepEqual(Object.keys(doc), ["format", "version", "network", "authorizations"]);
    assert.deepEqual(doc.authorizations[0], {
      asset: ID.asset,
      from: ID.from,
      nonce: ID.nonce,
      txHash: "ab".repeat(32),
      state: "submitted",
      validBefore: NOW + 300,
      value: "500000000",
      status: "pending",
      fingerprint: "f1".repeat(32),
      style: "legacy-amount",
    });
    assert.deepEqual(doc.authorizations[2], { asset: ID.asset, from: ID.from, nonce: "02".repeat(32), txHash: "ad".repeat(32), state: "settled", validBefore: NOW + 100 });
    // Ids are written the way the ledger keys them, so a file never refuses itself.
    const spelled = serializeFacilitatorState(NETWORK, [{ ...RECORDS[2]!, id: { ...ID, asset: `hash-${"8D".repeat(32)}`, nonce: `0x${"9C".repeat(32)}` } }]);
    assert.deepEqual(parseFacilitatorState(spelled, NETWORK)[0]?.id, ID);
  });

  test("anything that is not exactly what this module writes is refused, with the reason", () => {
    const good = JSON.parse(serializeFacilitatorState(NETWORK, RECORDS)) as Record<string, unknown> & { authorizations: Array<Record<string, unknown>> };
    const withEntry = (i: number, change: Record<string, unknown>) => {
      const doc = structuredClone(good);
      doc.authorizations[i] = { ...doc.authorizations[i], ...change };
      return JSON.stringify(doc);
    };
    const cases: Array<[string, RegExp]> = [
      ["", /not valid JSON/],
      ['{"format":"cascet-facilitator-state"', /not valid JSON/],
      ["[]", /not a cascet-facilitator-state file/],
      [JSON.stringify({ name: "casper-defi-data", upstream: {} }), /not a cascet-facilitator-state file/],
      [JSON.stringify({ ...good, version: 2 }), /version is 2; this facilitator reads version 1/],
      [JSON.stringify({ ...good, network: "casper:casper-test" }), /kept for "casper:casper-test", not casper:casper/],
      [JSON.stringify({ ...good, authorizations: {} }), /authorizations must be a list/],
      [JSON.stringify({ ...good, authorizations: [7] }), /authorizations\[0\] must be an object/],
      [withEntry(0, { asset: undefined }), /authorizations\[0\]\.asset must be a package hash/],
      [withEntry(0, { asset: `hash-${"8d".repeat(32)}` }), /authorizations\[0\]\.asset/],
      [withEntry(1, { from: `01${"65".repeat(32)}` }), /authorizations\[1\]\.from must be an account-hash Key/],
      [withEntry(1, { nonce: "9C".repeat(32) }), /authorizations\[1\]\.nonce must be 64 lower-case hex/],
      [withEntry(2, { txHash: "" }), /authorizations\[2\]\.txHash/],
      [withEntry(2, { state: "verified" }), /authorizations\[2\]\.state must be submitted, settled or failed/],
      [withEntry(3, { validBefore: String(NOW) }), /authorizations\[3\]\.validBefore must be unix seconds/],
      [withEntry(3, { validBefore: 1.5 }), /validBefore must be unix seconds/],
      [withEntry(0, { value: undefined }), /authorizations\[0\]\.value must be a decimal amount/],
      [withEntry(0, { value: "-5" }), /value must be a decimal amount/],
      [withEntry(0, { status: "settled" }), /authorizations\[0\]\.status must be pending or unknown/],
      [withEntry(0, { style: undefined }), /both fingerprint and style, or neither/],
      [withEntry(0, { style: "value" }), /authorizations\[0\]\.style must be legacy-amount or cep3009-value/],
      [withEntry(0, { fingerprint: "zz" }), /authorizations\[0\]\.fingerprint must be a payment fingerprint/],
      [JSON.stringify({ ...good, authorizations: [good.authorizations[2], good.authorizations[2]] }), /authorizations\[1\] repeats an earlier authorization/],
    ];
    for (const [text, reason] of cases) assert.throws(() => parseFacilitatorState(text, NETWORK), reason, text.slice(0, 60));
  });
});

describe("loading the state file", () => {
  test("a missing file is an empty state; a corrupt or unreadable one refuses with what is wrong and what to do", async () => {
    const d = testDir("load");
    assert.deepEqual(await loadFacilitatorState(join(d, "missing.json"), NETWORK), { records: [], found: false });

    const path = join(d, "state.json");
    writeFileSync(path, serializeFacilitatorState(NETWORK, RECORDS));
    assert.deepEqual(await loadFacilitatorState(path, NETWORK), { records: RECORDS, found: true });

    writeFileSync(path, '{"format": "cascet-facilitator-state", "version": 1, "net');
    await assert.rejects(loadFacilitatorState(path, NETWORK), (err: Error) => {
      assert.equal(err.name, "FacilitatorStateError");
      assert.match(err.message, /state file .*state\.json is not a valid facilitator state: it is not valid JSON/);
      assert.match(err.message, /restore it from a backup, or move it away only once every authorization it can hold has expired/);
      return true;
    });
    writeFileSync(path, serializeFacilitatorState("casper:casper-test", RECORDS));
    await assert.rejects(loadFacilitatorState(path, NETWORK), /kept for "casper:casper-test", not casper:casper/);
    await assert.rejects(loadFacilitatorState(d, NETWORK), /cannot read the state file .*: EISDIR/);
  });
});

describe("atomic writes", () => {
  test("temporary file, fsync, rename, then the directory: the file is complete, mode 0600, and nothing is left behind", async () => {
    const d = testDir("atomic");
    const path = join(d, "state.json");
    writeFileSync(path, "previous", { mode: 0o644 });
    const { fs, ops } = spyFs();
    await writeFileAtomic(path, "next\n", fs);
    assert.deepEqual(ops, [
      "open tmp wx 600",
      "chmod tmp 600",
      "write tmp",
      "sync tmp",
      "close tmp",
      "rename",
      "open dir r",
      "sync dir",
      "close dir",
    ]);
    assert.equal(readFileSync(path, "utf8"), "next\n");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(d), ["state.json"]);
  });

  test("a write that fails before the rename keeps the previous file and removes its temporary file", async () => {
    const d = testDir("failing");
    const path = join(d, "state.json");
    writeFileSync(path, "previous");
    const io = Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
    for (const hooks of [{ syncError: io }, { renameError: io }]) {
      const { fs, ops } = spyFs(hooks);
      await assert.rejects(writeFileAtomic(path, "next", fs), /EIO/);
      assert.equal(readFileSync(path, "utf8"), "previous");
      assert.deepEqual(readdirSync(d), ["state.json"], "no temporary file left");
      assert.ok(ops.includes("unlink"));
      assert.ok(!ops.includes("open dir r"));
    }
    // No directory: nothing is created anywhere.
    await assert.rejects(writeFileAtomic(join(d, "missing", "state.json"), "next"), /ENOENT/);
  });

  test("a reader never sees a partial file while saves run", async () => {
    const path = join(testDir("readers"), "state.json");
    let records: PersistedAuthorization[] = [];
    const state = new FacilitatorStateFile({ path, network: NETWORK, snapshot: () => records, log: quietLog });
    await state.save();
    const saves: Array<Promise<void>> = [];
    let reads = 0;
    for (let i = 0; i < 40; i++) {
      records = Array.from({ length: i * 10 }, (_, n) => ({ ...RECORDS[2]!, id: { ...ID, nonce: n.toString(16).padStart(64, "0") } }));
      saves.push(state.save());
      const text = await nodeFs.readFile(path, "utf8");
      assert.ok(parseFacilitatorState(text, NETWORK).length % 10 === 0, "a complete file");
      reads++;
    }
    await Promise.all(saves);
    assert.equal(parseFacilitatorState(readFileSync(path, "utf8"), NETWORK).length, 390, "the last state wins");
    assert.equal(reads, 40);
  });
});

describe("saving the ledger", () => {
  test("saves are coalesced: requests made while a write runs share the next write, which includes them all", async () => {
    const path = join(testDir("coalesce"), "state.json");
    let gate: Promise<void> | undefined;
    const { fs, ops } = spyFs({ beforeOpen: () => gate ?? Promise.resolve() });
    let records: PersistedAuthorization[] = [];
    const state = new FacilitatorStateFile({ path, network: NETWORK, snapshot: () => records, log: quietLog, fs });
    const writes = () => ops.filter(op => op === "rename").length;

    // Requests in one tick: one write.
    await Promise.all(Array.from({ length: 10 }, () => state.save()));
    assert.equal(writes(), 1);

    // A write in progress; changes made meanwhile go out in exactly one more write.
    let open!: () => void;
    gate = new Promise(r => (open = r));
    records = [RECORDS[2]!];
    const running = state.save();
    await new Promise(r => setImmediate(r)); // the write has started (its snapshot is taken)
    records = [RECORDS[2]!, RECORDS[3]!];
    const joined = [state.save(), state.save(), state.save()];
    assert.equal(joined[0], joined[2], "one promise for the queued write");
    gate = undefined;
    open();
    await Promise.all([running, ...joined]);
    assert.equal(writes(), 3);
    assert.deepEqual(parseFacilitatorState(readFileSync(path, "utf8"), NETWORK), [RECORDS[2], RECORDS[3]]);
  });

  test("a failed save rejects for the caller that awaits it, is logged once, leaves the file stale until a save succeeds", async () => {
    const d = testDir("stale");
    const path = join(d, "state.json");
    const errors: string[] = [];
    const io = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    let failing: Error | undefined = io;
    const fs: StateFileSystem = {
      open: (p, flags, mode) => (failing && flags === "wx" ? Promise.reject(failing) : nodeFs.open(p, flags, mode)),
      rename: nodeFs.rename,
      unlink: nodeFs.unlink,
    };
    const state = new FacilitatorStateFile({ path, network: NETWORK, snapshot: () => RECORDS, log: { error: m => errors.push(m) }, fs });
    state.schedule();
    state.schedule();
    await assert.rejects(state.save(), /ENOSPC/);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /could not save the state file .*state\.json: ENOSPC/);
    assert.equal(state.stale, true);
    assert.deepEqual(readdirSync(d), []);

    failing = undefined;
    await state.save();
    assert.equal(state.stale, false);
    assert.deepEqual(parseFacilitatorState(readFileSync(path, "utf8"), NETWORK), RECORDS);
  });

  test("expired authorizations are dropped: on restore, and from the file at the next save", async () => {
    const path = join(testDir("prune"), "state.json");
    const clock = new FakeClock(T0);
    const ledger = new AuthorizationLedger({ now: clock.now });
    const state = new FacilitatorStateFile({ path, network: NETWORK, snapshot: () => ledger.persistedAuthorizations(), log: quietLog });
    const expired = { ...RECORDS[3]!, id: { ...ID, nonce: "04".repeat(32) }, validBefore: NOW - 61 };
    assert.equal(ledger.restore([...RECORDS, expired]), RECORDS.length, "validBefore + 60 s passed: dropped");
    await state.save();
    assert.deepEqual(parseFacilitatorState(readFileSync(path, "utf8"), NETWORK), RECORDS);

    clock.advance(161_000); // the authorizations valid for 100 s are past their 60 s grace
    ledger.sweep();
    await state.save();
    assert.deepEqual(
      parseFacilitatorState(readFileSync(path, "utf8"), NETWORK).map(r => r.id.nonce),
      [ID.nonce, "01".repeat(32)],
    );
  });
});
