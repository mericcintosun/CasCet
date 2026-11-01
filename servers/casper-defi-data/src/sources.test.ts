import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BODY_BYTES,
  casperStakingApy,
  coingeckoSimple,
  computeStakingApy,
  parseCoingeckoRow,
  type FetchLike,
} from "./sources.js";

// Example answers from the cspr.cloud REST docs (/supply and /auction-metrics).
const SUPPLY = {
  data: {
    token: "CSPR",
    total: 13549811451,
    circulating: 13087471947,
    total_annual_issuance: 0.0821,
    annual_ecosystem_sustain_issuance: 0.020525,
    annual_staking_rewards_issuance: 0.061575,
    timestamp: 1747731497,
  },
};
const AUCTION = {
  data: {
    current_era_id: 12137,
    active_validator_number: 100,
    total_bids_number: 256,
    active_bids_number: 110,
    total_active_era_stake: "17143148308665709822",
  },
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

/** A response whose body arrives as a stream of small chunks, with no content-length header. */
function streamed(body: string, chunkBytes = 16 * 1024) {
  const bytes = new TextEncoder().encode(body);
  const state = { pulledBytes: 0, cancelled: false };
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      const chunk = bytes.subarray(offset, offset + chunkBytes);
      offset += chunk.length;
      state.pulledBytes += chunk.length;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(stream, { status: 200 }), state };
}

describe("parseCoingeckoRow", () => {
  it("keeps a well-formed row as is", () => {
    const row = { usd: 0.0231, usd_24h_vol: 11842113, usd_24h_change: -1.42 };
    assert.deepEqual(parseCoingeckoRow({ "casper-network": row }, "casper-network"), row);
  });

  it("keeps a null 24h change (CoinGecko sends it for illiquid assets)", () => {
    assert.deepEqual(parseCoingeckoRow({ ousg: { usd: 112.9, usd_24h_change: null } }, "ousg"), {
      usd: 112.9,
      usd_24h_vol: undefined,
      usd_24h_change: null,
    });
  });

  it("rejects a missing, non-numeric, zero or negative price", () => {
    for (const row of [undefined, null, [], { usd: "3312.4" }, { usd: 0 }, { usd: -1 }, { usd: null }]) {
      assert.equal(parseCoingeckoRow({ "pax-gold": row }, "pax-gold"), undefined, JSON.stringify(row));
    }
    assert.equal(parseCoingeckoRow("nope", "pax-gold"), undefined);
    assert.equal(parseCoingeckoRow(null, "pax-gold"), undefined);
  });

  it("drops volume and change fields of the wrong type or sign", () => {
    assert.deepEqual(parseCoingeckoRow({ id: { usd: 1, usd_24h_vol: -5, usd_24h_change: "1.2" } }, "id"), {
      usd: 1,
      usd_24h_vol: undefined,
      usd_24h_change: undefined,
    });
  });
});

describe("coingeckoSimple", () => {
  const fallback = { usd: 3312.4, usd_24h_change: 0.35, usd_24h_vol: 0 };

  it("returns the live quote and asks for exactly one id", async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async url => {
      urls.push(url);
      return json({ "pax-gold": { usd: 3400.5, usd_24h_vol: 10, usd_24h_change: 1.5 } });
    };
    assert.deepEqual(await coingeckoSimple("pax-gold", fallback, fetchImpl), {
      usd: 3400.5,
      usd_24h_vol: 10,
      usd_24h_change: 1.5,
      live: true,
    });
    assert.equal(
      urls[0],
      "https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true",
    );
  });

  it("falls back to the labeled snapshot on HTTP errors, network errors and bad payloads", async () => {
    const answers: FetchLike[] = [
      async () => json({ status: { error_code: 429 } }, { status: 429 }),
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => new Response("<html>rate limited</html>", { status: 200 }),
      async () => json({ "pax-gold": { usd: "NaN" } }),
      async () => new Response("{}", { status: 200, headers: { "content-length": String(10 * 1024 * 1024) } }),
    ];
    for (const fetchImpl of answers) {
      assert.deepEqual(await coingeckoSimple("pax-gold", fallback, fetchImpl), { ...fallback, live: false });
    }
  });

  it("stops reading a streamed body over 256 KiB that declares no length, and falls back", async () => {
    // Valid JSON: if the cap did not hold, this would parse into a live quote.
    const { response, state } = streamed(JSON.stringify({ "pax-gold": { usd: 3400.5 }, pad: "x".repeat(1024 * 1024) }));
    assert.equal(response.headers.get("content-length"), null);
    assert.deepEqual(await coingeckoSimple("pax-gold", fallback, async () => response), { ...fallback, live: false });
    assert.equal(state.cancelled, true, "the rest of the body is not read");
    assert.ok(state.pulledBytes <= MAX_BODY_BYTES + 2 * 16 * 1024, `read ${state.pulledBytes} bytes`);
  });

  it("reads a body that arrives in several chunks below the cap", async () => {
    const { response } = streamed(JSON.stringify({ "pax-gold": { usd: 3400.5 }, pad: "x".repeat(100 * 1024) }));
    const quote = await coingeckoSimple("pax-gold", fallback, async () => response);
    assert.equal(quote.live, true);
    assert.equal(quote.usd, 3400.5);
  });
});

describe("computeStakingApy", () => {
  it("derives the APY from the documented cspr.cloud answers", () => {
    const r = computeStakingApy(SUPPLY, AUCTION);
    assert.ok(r.live);
    const staked = Number(17143148308665709822n) / 1e9;
    assert.equal(r.totalStakedCspr, staked);
    assert.equal(r.nativeApy, (0.061575 * 13549811451 * 100) / staked);
    assert.equal(r.activeValidators, 100);
    assert.equal(r.eraId, 12137);
    assert.equal(r.totalSupply, 13549811451);
  });

  it("falls back on any malformed or implausible field (L50)", () => {
    const withSupply = (patch: Record<string, unknown>) => ({ data: { ...SUPPLY.data, ...patch } });
    const withAuction = (patch: Record<string, unknown>) => ({ data: { ...AUCTION.data, ...patch } });
    const bad: Array<[string, unknown, unknown]> = [
      ["no data", {}, AUCTION],
      ["null body", SUPPLY, null],
      ["zero supply", withSupply({ total: 0 }), AUCTION],
      ["text supply", withSupply({ total: "lots" }), AUCTION],
      ["issuance given as a percentage", withSupply({ annual_staking_rewards_issuance: 6.1575 }), AUCTION],
      ["missing issuance", withSupply({ annual_staking_rewards_issuance: undefined }), AUCTION],
      ["hex stake", SUPPLY, withAuction({ total_active_era_stake: "0x10" })],
      ["padded stake", SUPPLY, withAuction({ total_active_era_stake: " 17143148308665709822 " })],
      ["zero stake", SUPPLY, withAuction({ total_active_era_stake: "0" })],
      ["negative validator count", SUPPLY, withAuction({ active_validator_number: -1 })],
      ["fractional era", SUPPLY, withAuction({ current_era_id: 1.5 })],
      ["implausible APY (stake far too small)", SUPPLY, withAuction({ total_active_era_stake: "1000000000" })],
    ];
    for (const [name, supply, auction] of bad) {
      assert.deepEqual(computeStakingApy(supply, auction), { live: false }, name);
    }
  });
});

describe("casperStakingApy", () => {
  it("does not call cspr.cloud without a token", async () => {
    let calls = 0;
    const r = await casperStakingApy({
      baseUrl: "https://api.testnet.cspr.cloud",
      fetchImpl: async () => {
        calls++;
        return json({});
      },
    });
    assert.deepEqual(r, { live: false });
    assert.equal(calls, 0);
  });

  it("queries /supply and /auction-metrics with the token", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return json(url.endsWith("/supply") ? SUPPLY : AUCTION);
    };
    const r = await casperStakingApy({ baseUrl: "https://api.testnet.cspr.cloud", token: "tok", fetchImpl });
    assert.equal(r.live, true);
    assert.deepEqual(seen.map(s => s.url).sort(), [
      "https://api.testnet.cspr.cloud/auction-metrics",
      "https://api.testnet.cspr.cloud/supply",
    ]);
    assert.ok(seen.every(s => s.auth === "tok"));
  });

  it("falls back when cspr.cloud fails", async () => {
    const r = await casperStakingApy({
      baseUrl: "https://api.testnet.cspr.cloud",
      token: "tok",
      fetchImpl: async () => json({ message: "unauthorized" }, { status: 401 }),
    });
    assert.deepEqual(r, { live: false });
  });
});
