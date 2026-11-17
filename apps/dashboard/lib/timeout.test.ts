import { test } from "node:test";
import assert from "node:assert/strict";
import { isTimeoutError, timeoutSignal, withTimeout } from "./timeout";

test("withTimeout passes a fast result through and rejects a slow one with the given error", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 1_000, () => new Error("late")), 7);
  await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 1_000, () => new Error("late")), /boom/);
  const never = new Promise<number>(() => {});
  await assert.rejects(withTimeout(never, 20, () => new Error("node did not answer")), /node did not answer/);
});

test("a promise that loses the race and rejects later does not surface as unhandled", async () => {
  let rejectLater: (e: Error) => void = () => {};
  const slow = new Promise<number>((_, reject) => {
    rejectLater = reject;
  });
  await assert.rejects(withTimeout(slow, 10, () => new Error("timeout")), /timeout/);
  rejectLater(new Error("late failure"));
  await new Promise((r) => setTimeout(r, 10));
});

test("timeoutSignal makes fetch-style aborts recognisable as timeouts", async () => {
  const signal = timeoutSignal(5);
  assert.ok(signal, "Node has AbortSignal.timeout");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(signal.aborted, true);
  assert.equal(isTimeoutError(signal.reason), true);
  assert.equal(isTimeoutError(new Error("other")), false);
  assert.equal(isTimeoutError(null), false);
});
