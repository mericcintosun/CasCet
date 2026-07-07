import { buildPaymentGraph } from "@cascet/core";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const store = getStore();
  return Response.json({
    receipts: store.receipts,
    servers: [...store.servers.values()],
    graph: buildPaymentGraph(store.receipts),
  });
}
