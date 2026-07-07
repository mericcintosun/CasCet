import { subscribe } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Server-Sent Events stream of live CasCet events for the dashboard. */
export async function GET(): Promise<Response> {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      send({ type: "hello" });
      unsubscribe = subscribe(event => send(event));
      // Heartbeat keeps intermediaries from closing the idle connection.
      const heartbeat = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 15000);
      (controller as unknown as { _cleanup?: () => void })._cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
    },
    cancel() {
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
