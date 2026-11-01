import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Stdio MCP server whose "env" tool reports the environment it was started with. */
export const ENV_UPSTREAM_FIXTURE = fileURLToPath(new URL("./env-upstream.mjs", import.meta.url));

/** Variables the OS adds to every process (macOS: __CF_USER_TEXT_ENCODING), measured with an empty environment. */
export function osBaselineEnvironment(): string[] {
  return JSON.parse(
    execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], { env: {} }).toString(),
  ) as string[];
}
