import express, { type Request, type Response } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  HEADER_CASCET_PARENT_ID,
  HEADER_CASCET_PAYMENT_ID,
  HEADER_PAYMENT_SIGNATURE,
  type CascetConfig,
  type PaymentReceipt,
} from "@cascet/core";
import type { HTTPRequestContext } from "@x402/core/server";
import { expressAdapter } from "./adapter.js";
import { buildPaywall, type Paywall } from "./paywall.js";
import { connectUpstream, type UpstreamConnection } from "./upstream.js";
import { ReceiptStore, makeEventPusher } from "./store.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2025-06-18";

function rpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message, data } };
}

export interface RunningGateway {
  close: () => Promise<void>;
  port: number;
}

export async function startGateway(cfg: CascetConfig): Promise<RunningGateway> {
  const upstream: UpstreamConnection = await connectUpstream(cfg.upstream);
  const { tools } = await upstream.client.listTools();
  const toolNames = tools.map(t => t.name);
  const paywall: Paywall = await buildPaywall(cfg, toolNames);

  const store = new ReceiptStore(`.cascet/${slug(cfg.name)}.receipts.jsonl`);
  const pushEvent = makeEventPusher(cfg.eventsUrl);

  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use((_req, res, next) => {
    res.set({
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": `accept, authorization, content-type, ${HEADER_PAYMENT_SIGNATURE}, ${HEADER_CASCET_PARENT_ID}, mcp-protocol-version, mcp-session-id`,
      "access-control-expose-headers": `PAYMENT-REQUIRED, PAYMENT-RESPONSE, ${HEADER_CASCET_PAYMENT_ID}`,
    });
    next();
  });
  app.options("*path", (_req, res) => void res.sendStatus(204));

  app.get("/health", (_req, res) => void res.json({ status: "ok", server: cfg.name }));

  app.get("/pricing", (_req, res) => {
    res.json({
      server: cfg.name,
      network: cfg.network,
      asset: { symbol: cfg.asset.symbol, packageHash: cfg.asset.packageHash },
      tools: toolNames.map(name => ({
        name,
        priceUsd: paywall.priceOf(name)?.price,
        amountRaw: paywall.assetAmountOf(name)?.amount,
      })),
    });
  });

  app.get("/receipts", (_req, res) => void res.json({ receipts: store.list() }));

  app.post("/mcp", (req, res) => {
    void handleMcp(req, res).catch(err => {
      if (!res.headersSent) {
        res.status(500).json(rpcError(null, -32603, `gateway error: ${message(err)}`));
      }
    });
  });

  async function handleMcp(req: Request, res: Response): Promise<void> {
    const body = req.body as JsonRpcRequest | JsonRpcRequest[];
    if (Array.isArray(body)) {
      res.status(400).json(rpcError(null, -32600, "batch requests are not supported"));
      return;
    }
    if (!body || body.jsonrpc !== "2.0") {
      res.status(400).json(rpcError(null, -32600, "invalid JSON-RPC request"));
      return;
    }

    // Notifications / responses: acknowledge without a body.
    if (body.id === undefined || body.method === undefined) {
      res.sendStatus(202);
      return;
    }

    switch (body.method) {
      case "initialize": {
        const requested = (body.params?.protocolVersion as string) ?? PROTOCOL_VERSION;
        res.json(
          rpcResult(body.id, {
            protocolVersion: requested,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: `${cfg.name} (via CasCet)`, version: "0.1.0" },
          }),
        );
        return;
      }
      case "ping": {
        res.json(rpcResult(body.id, {}));
        return;
      }
      case "tools/list": {
        const priced = tools.map(tool => {
          const price = paywall.priceOf(tool.name);
          if (!price) return tool;
          return {
            ...tool,
            description: `${tool.description ?? ""} [PAID: ${price.price} per call via x402/Casper]`.trim(),
            _meta: { ...tool._meta, cascet: { priceUsd: price.price, network: cfg.network } },
          };
        });
        res.json(rpcResult(body.id, { tools: priced }));
        return;
      }
      case "tools/call": {
        await handleToolCall(req, res, body);
        return;
      }
      default: {
        res.json(rpcError(body.id, -32601, `method not supported by CasCet gateway: ${body.method}`));
        return;
      }
    }
  }

  async function handleToolCall(req: Request, res: Response, body: JsonRpcRequest): Promise<void> {
    const started = Date.now();
    const toolName = (body.params as { name?: string } | undefined)?.name;
    if (!toolName) {
      res.json(rpcError(body.id, -32602, "tools/call requires params.name"));
      return;
    }

    const price = paywall.priceOf(toolName);

    // Free tool: pass straight through.
    if (!price) {
      const result = await upstream.client.callTool({
        name: toolName,
        arguments: (body.params as { arguments?: Record<string, unknown> })?.arguments ?? {},
      });
      res.json(rpcResult(body.id, result));
      return;
    }

    // Paid tool: run the x402 flow against the tool's synthetic route.
    const context: HTTPRequestContext = {
      adapter: expressAdapter(req),
      path: paywall.routeFor(toolName),
      method: "POST",
      paymentHeader: req.get(HEADER_PAYMENT_SIGNATURE) ?? undefined,
    };
    const processed = await paywall.http.processHTTPRequest(context);

    if (processed.type === "payment-error") {
      // 402 challenge (or verification failure): forward exactly what x402 built.
      res.status(processed.response.status).set(processed.response.headers);
      res.json(processed.response.body ?? rpcError(body.id, -32002, "payment required"));
      return;
    }

    if (processed.type === "no-payment-required") {
      // Defensive: route table says free even though pricing says paid.
      const result = await upstream.client.callTool({
        name: toolName,
        arguments: (body.params as { arguments?: Record<string, unknown> })?.arguments ?? {},
      });
      res.json(rpcResult(body.id, result));
      return;
    }

    // payment-verified: execute the tool first — buyers are only charged for
    // successful calls. A failed upstream call leaves the authorization unsettled.
    // The payment id is minted NOW and forwarded via _meta so the upstream tool
    // can use it as the parent of its own downstream (cascading) purchases.
    const paymentId = uuidv4();
    let toolResult: Awaited<ReturnType<typeof upstream.client.callTool>>;
    try {
      toolResult = await upstream.client.callTool({
        name: toolName,
        arguments: (body.params as { arguments?: Record<string, unknown> })?.arguments ?? {},
        _meta: { cascet: { paymentId, server: cfg.name } },
      });
    } catch (err) {
      res.json(rpcError(body.id, -32603, `upstream tool failed (not charged): ${message(err)}`));
      return;
    }
    if (toolResult.isError) {
      res.json(rpcResult(body.id, toolResult));
      return;
    }

    const settled = await paywall.http.processSettlement(
      processed.paymentPayload,
      processed.paymentRequirements,
      processed.declaredExtensions,
      { request: context },
    );

    if (!settled.success) {
      res
        .status(settled.response.status)
        .set(settled.response.headers)
        .json(settled.response.body ?? rpcError(body.id, -32002, `settlement failed: ${settled.errorReason}`));
      recordReceipt({ toolName, started, txHash: undefined, payer: settled.payer, status: "failed", parentId: parentIdOf(req) });
      return;
    }

    const receipt = recordReceipt({
      id: paymentId,
      toolName,
      started,
      txHash: settled.transaction,
      payer: settled.payer,
      status: "settled",
      parentId: parentIdOf(req),
    });

    res.set(settled.headers);
    res.set(HEADER_CASCET_PAYMENT_ID, paymentId);
    res.json(
      rpcResult(body.id, {
        ...toolResult,
        _meta: {
          ...(toolResult._meta as Record<string, unknown> | undefined),
          cascet: {
            paymentId,
            txHash: receipt.txHash,
            amountRaw: receipt.amountRaw,
            assetSymbol: receipt.assetSymbol,
            network: receipt.network,
          },
        },
      }),
    );
  }

  function parentIdOf(req: Request): string | undefined {
    return req.get(HEADER_CASCET_PARENT_ID) ?? undefined;
  }

  function recordReceipt(input: {
    id?: string;
    toolName: string;
    started: number;
    txHash?: string;
    payer?: string;
    status: "settled" | "failed";
    parentId?: string;
  }): PaymentReceipt {
    const amount = paywall.assetAmountOf(input.toolName);
    const receipt: PaymentReceipt = {
      id: input.id ?? uuidv4(),
      parentId: input.parentId,
      createdAt: new Date().toISOString(),
      network: cfg.network,
      server: cfg.name,
      tool: input.toolName,
      payer: input.payer ?? "unknown",
      payTo: cfg.payTo,
      amountRaw: amount?.amount ?? "0",
      asset: cfg.asset.packageHash,
      assetSymbol: cfg.asset.symbol,
      priceUsd: paywall.priceOf(input.toolName)?.price,
      txHash: input.txHash,
      status: input.status,
      latencyMs: Date.now() - input.started,
    };
    store.add(receipt);
    pushEvent({ type: "receipt", receipt });
    return receipt;
  }

  const server = app.listen(cfg.port, () => {
    console.log(`⛩️  CasCet gateway "${cfg.name}" listening on http://localhost:${cfg.port}/mcp`);
    console.log(`    wrapped tools: ${toolNames.join(", ")}`);
  });

  pushEvent({
    type: "server-online",
    server: cfg.name,
    tools: toolNames.map(name => ({ name, priceUsd: paywall.priceOf(name)?.price })),
  });

  return {
    port: cfg.port,
    close: async () => {
      pushEvent({ type: "server-offline", server: cfg.name });
      server.close();
      await upstream.close();
    },
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
