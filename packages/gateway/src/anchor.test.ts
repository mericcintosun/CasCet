import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PaymentReceipt } from "@cascet/core";
import { Anchorer, chainNameForNetwork, type AnchorChain, type AnchorTxStatus } from "./anchor.js";

function receipt(id: string): PaymentReceipt {
  return {
    id,
    createdAt: new Date().toISOString(),
    network: "casper:casper-test",
    server: "s",
    tool: "t",
    payer: `00${"aa".repeat(32)}`,
    payTo: `00${"bb".repeat(32)}`,
    amountRaw: "1",
    asset: "cc".repeat(32),
    assetSymbol: "TST",
    status: "settled",
  };
}

/** A chain whose transactions resolve to the scripted statuses (default: executed on first poll). */
function fakeChain(script: { submitError?: string; statuses?: Array<AnchorTxStatus | "throw"> } = {}): AnchorChain & { submitted: number } {
  let n = 0;
  const chain = {
    submitted: 0,
    async submit(): Promise<string> {
      if (script.submitError) throw new Error(script.submitError);
      chain.submitted++;
      return (++n).toString(16).padStart(64, "0");
    },
    async status(): Promise<AnchorTxStatus> {
      const next = script.statuses?.shift() ?? { state: "executed" };
      if (next === "throw") throw new Error("transaction not found");
      return next;
    },
  };
  return chain;
}

function anchorer(chain: AnchorChain, opts: Partial<ConstructorParameters<typeof Anchorer>[1]> = {}, clock = { now: 0 }) {
  return new Anchorer(chain, {
    maxConsecutiveFailures: 3,
    cooldownMs: 1_000,
    confirmTimeoutMs: 100,
    pollIntervalMs: 1,
    now: () => clock.now,
    sleep: async () => {
      clock.now += 10;
    },
    ...opts,
  });
}

describe("Anchorer", () => {
  it("reports the hex hash only after the anchor executed, polling through transient errors", async () => {
    const chain = fakeChain({ statuses: ["throw", { state: "pending" }, { state: "executed" }] });
    const a = anchorer(chain);
    const anchored: string[] = [];
    assert.equal(a.enqueue(receipt("r1"), hash => anchored.push(hash)), "queued");
    await a.whenIdle();
    assert.deepEqual(anchored, [`${"0".repeat(63)}1`]);
    assert.equal(a.health().anchored, 1);
    assert.equal(a.health().state, "closed");
  });

  it("never reports an anchor that failed on-chain or did not execute in time", async () => {
    const clock = { now: 0 };
    const chain = fakeChain({ statuses: [{ state: "failed", error: "User error: 1" }, ...Array(20).fill({ state: "pending" })] });
    const a = anchorer(chain, { maxConsecutiveFailures: 10 }, clock);
    const anchored: string[] = [];
    a.enqueue(receipt("r1"), hash => anchored.push(hash));
    a.enqueue(receipt("r2"), hash => anchored.push(hash));
    await a.whenIdle();
    assert.deepEqual(anchored, []);
    assert.equal(a.health().failed, 2);
    assert.match(a.health().lastError ?? "", /not executed within 100 ms|failed on-chain/);
  });

  it("opens the circuit after consecutive failures and stops spending gas", async () => {
    const clock = { now: 0 };
    const chain = fakeChain({ statuses: Array(10).fill({ state: "failed", error: "Unauthorized" }) });
    const a = anchorer(chain, { maxConcurrent: 1 }, clock);
    for (let i = 0; i < 3; i++) a.enqueue(receipt(`r${i}`), () => {});
    await a.whenIdle();
    assert.equal(chain.submitted, 3);
    assert.equal(a.health().state, "open");
    assert.equal(a.enqueue(receipt("r4"), () => {}), "circuit-open");
    await a.whenIdle();
    assert.equal(chain.submitted, 3, "no transaction while the circuit is open");
    assert.equal(a.health().skipped, 1);
  });

  it("lets one trial through after the cooldown and closes again when it succeeds", async () => {
    const clock = { now: 0 };
    const chain = fakeChain({ statuses: [...Array(3).fill({ state: "failed", error: "x" }), { state: "executed" }] });
    const a = anchorer(chain, { maxConcurrent: 1 }, clock);
    for (let i = 0; i < 3; i++) a.enqueue(receipt(`r${i}`), () => {});
    await a.whenIdle();
    assert.equal(a.health().state, "open");
    clock.now += 2_000;
    const anchored: string[] = [];
    assert.equal(a.enqueue(receipt("trial"), hash => anchored.push(hash)), "queued");
    await a.whenIdle();
    assert.equal(anchored.length, 1);
    assert.equal(a.health().state, "closed");
    assert.equal(a.health().consecutiveFailures, 0);
  });

  it("reopens the circuit when the trial fails", async () => {
    const clock = { now: 0 };
    const chain = fakeChain({ submitError: "invalid chain name" });
    const a = anchorer(chain, { maxConcurrent: 1 }, clock);
    for (let i = 0; i < 3; i++) a.enqueue(receipt(`r${i}`), () => {});
    await a.whenIdle();
    clock.now += 2_000;
    a.enqueue(receipt("trial"), () => {});
    await a.whenIdle();
    assert.equal(a.health().state, "open");
    assert.match(a.health().lastError ?? "", /invalid chain name/);
  });

  it("drops queued work when stopped", async () => {
    const a = anchorer(fakeChain());
    a.stop();
    assert.equal(a.enqueue(receipt("r"), () => {}), "stopped");
  });
});

describe("chainNameForNetwork", () => {
  it("derives the Casper chain name from the CAIP-2 network", () => {
    assert.equal(chainNameForNetwork("casper:casper"), "casper");
    assert.equal(chainNameForNetwork("casper:casper-test"), "casper-test");
    assert.equal(chainNameForNetwork("casper-test"), "casper-test");
  });
});
