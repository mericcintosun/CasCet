import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PurchaseFailure,
  REASONS,
  classifyPurchaseError,
  cleanProviderText,
  internalErrorResult,
  isPaymentId,
} from "./sanitize.js";
import { INTERNAL_ERRORS, LEAK_MARKERS } from "./test-fakes.js";

const idle = () => ({ signal: new AbortController().signal, cancelled: new AbortController().signal });

describe("classifyPurchaseError", () => {
  const cases: Array<[string, unknown, string]> = [
    ["unreachable gateway", INTERNAL_ERRORS.unreachable(), REASONS.unreachable],
    ["JSON-RPC error from the gateway", INTERNAL_ERRORS.rpcError(), REASONS.providerError],
    ["HTTP 500 from the gateway", INTERNAL_ERRORS.http500(), "the data provider answered HTTP 500"],
    ["HTTP 402 after paying", new Error("MCP request tools/call failed: HTTP 402 {\"x402Version\":2}"), REASONS.paymentRejected],
    ["client budget abort", INTERNAL_ERRORS.budget(), REASONS.policy],
    [
      "client allowlist abort",
      new Error("Failed to create payment payload: Payment creation aborted: payTo 00abc is not allowlisted"),
      REASONS.policy,
    ],
    [
      "network not registered",
      new Error('Failed to create payment payload: No network/scheme registered for x402 version: 2 which comply {"payTo":"00ab"}'),
      REASONS.policy,
    ],
    [
      "analyst network veto",
      new Error("Failed to create payment payload: analyst payment policy: network casper:casper is not in CASCET_NETWORK"),
      REASONS.policy,
    ],
    ["scheme failure", new Error("Failed to create payment payload: No client registered for scheme: exact"), REASONS.paymentFailed],
    ["bad 402 challenge", new Error("Failed to parse payment requirements: Invalid payment required response"), REASONS.paymentFailed],
    ["non-JSON body", new SyntaxError("Unexpected token < in JSON at position 0"), REASONS.malformed],
    ["timeout from a lower layer", new DOMException("The operation was aborted due to timeout", "TimeoutError"), REASONS.timedOut],
    ["anything else", new Error("something odd at /srv/cascet/app.js:1:1"), REASONS.failed],
    ["a thrown string", "weird", REASONS.failed],
    ["a pre-classified failure", new PurchaseFailure(REASONS.malformed), REASONS.malformed],
  ];
  for (const [name, err, expected] of cases) {
    it(`maps ${name}`, () => assert.equal(classifyPurchaseError(err, idle()), expected));
  }

  it("labels any failure after an inbound cancellation as cancelled", () => {
    const inbound = new AbortController();
    inbound.abort("Request timed out");
    assert.equal(classifyPurchaseError("Request timed out", { signal: inbound.signal, cancelled: inbound.signal }), REASONS.cancelled);
  });

  it("labels a failure after the purchase deadline as timed out", () => {
    const deadline = new AbortController();
    deadline.abort();
    assert.equal(
      classifyPurchaseError(new Error("Failed to create payment payload: analyst payment policy: the analysis was aborted"), {
        signal: deadline.signal,
        cancelled: new AbortController().signal,
      }),
      REASONS.timedOut,
    );
  });

  it("only ever returns caller-safe text", () => {
    for (const make of Object.values(INTERNAL_ERRORS)) {
      const reason = classifyPurchaseError(make(), idle());
      for (const marker of LEAK_MARKERS) assert.ok(!reason.includes(marker), `"${reason}" leaks "${marker}"`);
    }
  });
});

describe("internalErrorResult", () => {
  it("returns only a reference and logs the details under it", () => {
    const lines: string[] = [];
    const err = new Error("ENOENT: no such file or directory, open '/srv/cascet/keys/analyst.pem'");
    const result = internalErrorResult(err, line => lines.push(line));
    assert.equal(result.isError, true);
    const text = result.content[0]?.text ?? "";
    const ref = /^analysis failed: internal error \(ref ([0-9a-f]{8})\)$/.exec(text)?.[1];
    assert.ok(ref, `unexpected text: ${text}`);
    assert.ok(!text.includes("/srv/cascet") && !text.includes("ENOENT"));
    assert.ok(lines.some(l => l.includes(`ref ${ref}`) && l.includes("/srv/cascet/keys/analyst.pem")));
  });
});

describe("cleanProviderText", () => {
  it("strips control and bidi characters and collapses whitespace", () => {
    assert.equal(cleanProviderText("a\u0000b‮c\n\td​", 50), "a b c d");
  });

  it("caps the length", () => {
    const out = cleanProviderText("x".repeat(100), 10);
    assert.equal(out.length, 10);
    assert.ok(out.endsWith("…"));
  });
});

describe("isPaymentId", () => {
  it("accepts gateway UUIDs only", () => {
    assert.equal(isPaymentId("6f1c2a8e-1b2c-4d3e-8f40-0a1b2c3d4e01"), true);
    assert.equal(isPaymentId("6F1C2A8E-1B2C-4D3E-8F40-0A1B2C3D4E01"), true);
    assert.equal(isPaymentId("not-a-uuid"), false);
    assert.equal(isPaymentId("6f1c2a8e-1b2c-4d3e-8f40-0a1b2c3d4e01\r\nX: 1"), false);
    assert.equal(isPaymentId(42), false);
    assert.equal(isPaymentId(undefined), false);
  });
});
