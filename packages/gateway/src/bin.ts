import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cascetConfigSchema } from "@cascet/core";
import { startGateway } from "./server.js";
import { log, logSafe } from "./log.js";

const configPath = resolve(process.argv[2] ?? "cascet.config.json");
const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
const cfg = cascetConfigSchema.parse(raw);

try {
  const gateway = await startGateway(cfg, {
    // The upstream is gone for good: exit non-zero so a process supervisor restarts the gateway.
    onFatal: error => {
      log.error(`[gateway] ${logSafe(error)}; exiting`);
      void gateway.close().finally(() => process.exit(1));
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void gateway.close().finally(() => process.exit(0));
    });
  }
} catch (err) {
  log.error(`[gateway] failed to start: ${logSafe(err)}`);
  process.exit(1);
}
