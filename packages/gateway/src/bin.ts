import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cascetConfigSchema } from "@cascet/core";
import { startGateway } from "./server.js";

const configPath = resolve(process.argv[2] ?? "cascet.config.json");
const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
const cfg = cascetConfigSchema.parse(raw);

const gateway = await startGateway(cfg);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void gateway.close().finally(() => process.exit(0));
  });
}
