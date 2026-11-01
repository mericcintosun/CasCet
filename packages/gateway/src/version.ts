import { createRequire } from "node:module";

/** Version of @cascet/gateway, read from its package.json (src/ and dist/ both sit next to it). */
export const GATEWAY_VERSION: string = (() => {
  try {
    const version = (createRequire(import.meta.url)("../package.json") as { version?: unknown }).version;
    return typeof version === "string" ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
