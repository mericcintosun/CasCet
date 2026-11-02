import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { log, logSafe } from "./log.js";

describe("logSafe", () => {
  it("folds CR/LF so a value cannot forge log lines", () => {
    assert.equal(logSafe("tool\r\n[x402] settled everything"), "tool [x402] settled everything");
  });

  it("neutralizes terminal and bidi control characters", () => {
    const value = `a${String.fromCodePoint(0x1b)}[31m${String.fromCodePoint(0x202e)}b${String.fromCodePoint(0x2028)}c${String.fromCodePoint(0)}`;
    assert.equal(logSafe(value), "a?[31m?b?c?");
  });

  it("keeps the CR/LF removal that CodeQL's js/log-injection query recognizes as a sanitizer", () => {
    // The fold to spaces already removes line breaks; this guards the extra, CodeQL-visible form.
    assert.match(logSafe.toString(), /\.replace\(\/\\n\|\\r\/g,\s*""\)/);
    assert.doesNotMatch(logSafe("a\rb\nc\r\nd"), /[\r\n]/);
  });

  it("caps the length and renders non-strings", () => {
    assert.equal(logSafe("x".repeat(500)).length, 301);
    assert.equal(logSafe({ a: 1 }), '{"a":1}');
    assert.equal(logSafe(new Error("bad\nthing")), "bad thing");
    assert.equal(logSafe(10n), "10");
  });
});

describe("log", () => {
  it("always passes a constant format string, so % sequences in messages are inert", () => {
    const spy = mock.method(console, "warn", () => {});
    try {
      log.warn("payment for %s rejected: %d");
      assert.deepEqual(spy.mock.calls[0]?.arguments, ["%s", "payment for %s rejected: %d"]);
    } finally {
      spy.mock.restore();
    }
  });
});
