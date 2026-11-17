import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  isSupportedProtocolVersion,
  negotiateProtocolVersion,
} from "./protocol.js";

describe("protocol version negotiation", () => {
  it("prefers the client's version only when it is supported", () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) assert.equal(negotiateProtocolVersion(version), version);
    assert.equal(negotiateProtocolVersion("2030-01-01"), LATEST_PROTOCOL_VERSION);
    assert.equal(negotiateProtocolVersion(42), LATEST_PROTOCOL_VERSION);
    assert.equal(negotiateProtocolVersion(undefined), LATEST_PROTOCOL_VERSION);
  });

  it("lists the latest version first", () => {
    assert.equal(SUPPORTED_PROTOCOL_VERSIONS[0], LATEST_PROTOCOL_VERSION);
    assert.equal(isSupportedProtocolVersion("2025-06-18"), true);
    assert.equal(isSupportedProtocolVersion("2025-06-18 "), false);
  });
});
