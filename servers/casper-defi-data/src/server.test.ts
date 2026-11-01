import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDataServer, safeTool, type DataServerOptions } from "./server.js";
import type { FetchLike } from "./sources.js";

const offline: FetchLike = async () => {
  throw new TypeError("fetch failed");
};

async function connect(opts: DataServerOptions) {
  const server = createDataServer({ log: () => {}, ...opts });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** cspr.cloud answering with the example values of its REST docs. */
const csprCloudDocs: FetchLike = async url =>
  new Response(
    JSON.stringify(
      url.endsWith("/supply")
        ? { data: { total: 13549811451, annual_staking_rewards_issuance: 0.061575 } }
        : { data: { total_active_era_stake: "17143148308665709822", active_validator_number: 100, current_era_id: 12137 } },
    ),
  );

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find(c => c.type === "text")?.text ?? "";
}

describe("casper-defi-data tools", { timeout: 15_000 }, () => {
  it("serve the labeled snapshots unchanged when the upstreams are unreachable", async () => {
    const h = await connect({ fetchImpl: offline, env: {} });
    try {
      const cspr = JSON.parse(textOf(await h.client.callTool({ name: "get_cspr_market_data", arguments: {} })));
      assert.deepEqual(cspr, {
        asset: "CSPR",
        priceUsd: 0.0231,
        volume24hUsd: 11_842_113,
        change24hPct: -1.42,
        source: "snapshot(2026-07-07)",
      });
      const gold = JSON.parse(textOf(await h.client.callTool({ name: "get_rwa_price", arguments: { asset: "gold" } })));
      assert.deepEqual(gold, {
        asset: "gold",
        proxyToken: "pax-gold",
        priceUsd: 3312.4,
        change24hPct: 0.35,
        source: "snapshot(2026-07-07)",
      });
      const yields = JSON.parse(textOf(await h.client.callTool({ name: "get_defi_yields", arguments: {} })));
      assert.equal(yields.source, "snapshot(2026-07-07)");
      assert.deepEqual(
        yields.yields.map((y: { apyPct: number }) => y.apyPct),
        [11.2, 10.1],
      );
    } finally {
      await h.close();
    }
  });

  it("computes live yields from cspr.cloud over one era's stake and names the network (L50, L23)", async () => {
    const h = await connect({ fetchImpl: csprCloudDocs, env: { CSPR_CLOUD_TOKEN: "tok", CSPR_CLOUD_URL: "https://api.cspr.cloud" } });
    try {
      const yields = JSON.parse(textOf(await h.client.callTool({ name: "get_defi_yields", arguments: {} })));
      assert.equal(yields.source, "cspr.cloud(live, mainnet): /supply + /auction-metrics");
      assert.deepEqual(yields.network, {
        name: "mainnet",
        // Half of the documented 17,143,148,309 CSPR, which sums two eras.
        totalStakedCspr: 8571574154,
        activeValidators: 100,
        eraId: 12137,
        totalSupplyCspr: 13549811451,
      });
      assert.equal(yields.yields[0].apyPct, 9.7);
      assert.equal(yields.yields[1].apyPct, 8.8);
    } finally {
      await h.close();
    }
  });

  it("labels yields from the default cspr.cloud as testnet data (L23)", async () => {
    const h = await connect({ fetchImpl: csprCloudDocs, env: { CSPR_CLOUD_TOKEN: "tok" } });
    try {
      const yields = JSON.parse(textOf(await h.client.callTool({ name: "get_defi_yields", arguments: {} })));
      assert.equal(yields.source, "cspr.cloud(live, testnet): /supply + /auction-metrics");
      assert.equal(yields.network.name, "testnet");
    } finally {
      await h.close();
    }
  });

  it("reuses a live quote for a minute, then serves it with its age while CoinGecko fails (L24)", async () => {
    let now = 1_000_000;
    let calls = 0;
    let up = true;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return up
        ? new Response(JSON.stringify({ "pax-gold": { usd: 3400.5, usd_24h_change: 1.5 } }))
        : new Response("{}", { status: 429 });
    };
    const h = await connect({ fetchImpl, env: {}, now: () => now });
    const gold = async () =>
      JSON.parse(textOf(await h.client.callTool({ name: "get_rwa_price", arguments: { asset: "gold" } }))) as {
        priceUsd: number;
        source: string;
      };
    try {
      assert.deepEqual(await gold(), {
        asset: "gold",
        proxyToken: "pax-gold",
        priceUsd: 3400.5,
        change24hPct: 1.5,
        source: "coingecko(live)",
      });
      now += 30_000;
      assert.equal((await gold()).source, "coingecko(live)");
      assert.equal(calls, 1, "a fresh answer is reused");

      up = false;
      now += 270_000;
      const cached = await gold();
      assert.equal(cached.priceUsd, 3400.5);
      assert.equal(cached.source, "coingecko(cached, 5 min old)");
      assert.equal(calls, 2);

      now += 15 * 60_000;
      const snapshot = await gold();
      assert.equal(snapshot.priceUsd, 3312.4);
      assert.equal(snapshot.source, "snapshot(2026-07-07)");
    } finally {
      await h.close();
    }
  });

  it("validates input before doing any work", async () => {
    let calls = 0;
    const h = await connect({
      fetchImpl: async () => {
        calls++;
        throw new TypeError("fetch failed");
      },
      env: {},
    });
    try {
      const wrongAsset = await h.client.callTool({ name: "get_rwa_price", arguments: { asset: "bitcoin" } });
      assert.equal(wrongAsset.isError, true);
      const huge = await h.client.callTool({
        name: "get_rwa_price",
        arguments: { asset: "gold", junk: Array.from({ length: 100 }, (_, i) => i) },
      });
      assert.equal(huge.isError, true);
      assert.equal(calls, 0);
    } finally {
      await h.close();
    }
  });
});

describe("safeTool", () => {
  it("turns an unexpected exception into a generic error with a reference", async () => {
    const lines: string[] = [];
    const handler = safeTool("get_rwa_price", line => lines.push(line), async () => {
      throw new Error("ENOENT: open '/srv/cascet/secret.json' at https://internal.example/x");
    });
    const result = await handler();
    assert.equal(result.isError, true);
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /^get_rwa_price failed: internal error \(ref [0-9a-f]{8}\)$/);
    assert.ok(lines.some(l => l.includes("/srv/cascet/secret.json")), "details stay in the operator log");
  });
});
