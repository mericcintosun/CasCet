import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { PaymentRequirements } from "@x402/core/types";
import { balanceItemKey, dictionaryAddress, latestContractHash, usedNonceItemKey } from "../token-probe.js";
import * as fx from "./rpc-fixtures.js";
import { replayFetch, type Replay } from "./rpc-replay.js";

/** A Casper JSON-RPC node stand-in on 127.0.0.1 (no network): answers like {@link replayFetch}. */
export interface FakeNode {
  /** JSON-RPC endpoint. */
  url: string;
  /** "<method> <params.key>" of every call, in order. */
  calls: string[];
  /** Answer every call with HTTP 503 (a node that is down). */
  down: boolean;
  close(): Promise<void>;
}

export async function startFakeNode(routes: Record<string, Replay>): Promise<FakeNode> {
  const calls: string[] = [];
  const answer = replayFetch(routes, calls);
  const sockets = new Set<Socket>();
  const node: FakeNode = {
    url: "",
    calls,
    down: false,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk as Buffer));
    req.on("end", () => {
      void (async () => {
        if (node.down) {
          res.writeHead(503).end("down");
          return;
        }
        try {
          const body = Buffer.concat(chunks).toString("utf8");
          const response = await answer(node.url, { method: "POST", headers: {}, body, signal: AbortSignal.timeout(5_000) });
          res.writeHead(response.status, { "content-type": "application/json" }).end(await response.text());
        } catch (err) {
          res.writeHead(500).end(err instanceof Error ? err.message : String(err));
        }
      })();
    });
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  node.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`;
  return node;
}

/** The official Wrapped CSPR on testnet (recorded package and contract, version 8). */
export const WCSPR_TESTNET = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";
const WCSPR_CONTRACT = latestContractHash(fx.wcsprTestnetPackageResponse.result.stored_value.ContractPackage);
const wcsprNamedKey = (name: string): string =>
  fx.wcsprTestnetContractResponse.result.stored_value.Contract.named_keys.find(key => key.name === name)!.key;

/** A U256 dictionary value as `query_global_state` returns it. */
export function u256Response(value: bigint) {
  return { jsonrpc: "2.0", id: 1, result: { api_version: "2.0.0", stored_value: { CLValue: { cl_type: "U256", bytes: "", parsed: value.toString() } } } };
}

/**
 * Node routes for testnet Wrapped CSPR: its package, contract (transfer_with_authorization
 * takes `value`) and name, `balances` for the given payers, `used_nonces` true for the
 * given (payer, nonce) pairs, and "value was not found" for every other item (unused
 * nonces, zero balances).
 */
export function wcsprNodeRoutes(opts: {
  balances?: Record<string, bigint>;
  usedNonces?: Array<{ payer: string; nonce: string }>;
}): Record<string, Replay> {
  const routes: Record<string, Replay> = {
    [`query_global_state hash-${WCSPR_TESTNET}`]: fx.wcsprTestnetPackageResponse,
    [`query_global_state hash-${WCSPR_CONTRACT}`]: fx.wcsprTestnetContractResponse,
    [`query_global_state ${wcsprNamedKey("name")}`]: fx.wcsprTestnetNameResponse,
    query_global_state: fx.testnetUnusedNonceResponse,
  };
  for (const [payer, balance] of Object.entries(opts.balances ?? {})) routes[wcsprBalanceCall(payer)] = u256Response(balance);
  for (const { payer, nonce } of opts.usedNonces ?? []) routes[wcsprNonceCall(payer, nonce)] = fx.testnetUsedNonceResponse;
  return routes;
}

/** The `query_global_state` call of the used_nonces item of (payer, nonce) on Wrapped CSPR, as {@link FakeNode.calls} lists it. */
export function wcsprNonceCall(payer: string, nonce: string): string {
  return `query_global_state ${dictionaryAddress(wcsprNamedKey("used_nonces"), usedNonceItemKey(payer, nonce))}`;
}

/** The `query_global_state` call of the balances item of `payer` on Wrapped CSPR (a route key of {@link wcsprNodeRoutes}). */
export function wcsprBalanceCall(payer: string): string {
  return `query_global_state ${dictionaryAddress(wcsprNamedKey("balances"), balanceItemKey(payer))}`;
}

/** Requirements of a Wrapped CSPR payment as a CasCet gateway builds them. */
export function wcsprRequirements(amount: string, payTo: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: "casper:casper-test",
    asset: WCSPR_TESTNET,
    amount,
    payTo,
    maxTimeoutSeconds: 300,
    extra: { name: "Wrapped CSPR", symbol: "WCSPR", version: "1", decimals: "9", authorizationStyle: "cep3009-value" },
  };
}
