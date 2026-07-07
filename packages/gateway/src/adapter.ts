import type { Request } from "express";
import type { HTTPAdapter } from "@x402/core/server";

/** Bridge an Express request into the framework-agnostic x402 HTTPAdapter. */
export function expressAdapter(req: Request): HTTPAdapter {
  return {
    getHeader: name => req.get(name) ?? undefined,
    getMethod: () => req.method,
    getPath: () => req.path,
    getUrl: () => `${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`,
    getAcceptHeader: () => req.get("accept") ?? "*/*",
    getUserAgent: () => req.get("user-agent") ?? "",
    getQueryParams: () => req.query as Record<string, string | string[]>,
    getQueryParam: name => req.query[name] as string | string[] | undefined,
  };
}
