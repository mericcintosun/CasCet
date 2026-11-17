import type { Request } from "express";
import type { HTTPAdapter } from "@x402/core/server";

/**
 * Bridge an Express request into the framework-agnostic x402 HTTPAdapter.
 * `publicUrl` (config `publicUrl`) replaces the request's scheme and Host.
 */
export function expressAdapter(req: Request, publicUrl?: string): HTTPAdapter {
  return {
    getHeader: name => req.get(name) ?? undefined,
    getMethod: () => req.method,
    getPath: () => req.path,
    getUrl: () => `${publicUrl ?? `${req.protocol}://${req.get("host") ?? "localhost"}`}${req.originalUrl}`,
    getAcceptHeader: () => req.get("accept") ?? "*/*",
    getUserAgent: () => req.get("user-agent") ?? "",
    getQueryParams: () => req.query as Record<string, string | string[]>,
    getQueryParam: name => req.query[name] as string | string[] | undefined,
  };
}

/** The same request as seen without any payment header (used to issue a fresh 402 challenge). */
export function withoutPaymentHeader(adapter: HTTPAdapter): HTTPAdapter {
  return {
    ...adapter,
    getHeader: name => (/^(payment-signature|x-payment)$/i.test(name) ? undefined : adapter.getHeader(name)),
  };
}
