import { subscribe } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Server-Sent Events stream of live CasCet events for the dashboard. */
export async function GET(): Promise<Response> {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup(); // stream already closed
        }
      };
      send({ type: "hello" });
      const unsubscribe = subscribe(event => send(event));
      // Heartbeat (an SSE comment, ignored by EventSource) keeps intermediaries
      // from closing the idle connection.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 15000);
      // Cleared when the client disconnects (cancel) — previously it ran forever (L28).
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
    },
    cancel() {
      cleanup();
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
