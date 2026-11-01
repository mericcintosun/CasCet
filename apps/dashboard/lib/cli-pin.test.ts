import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_SPEC, cliCommand } from "./connect-config";

/**
 * Finding M13: npm's `latest` @cascet/cli is 0.1.0, which ignores the network
 * pin, the allowlists and the caps. Every command this site shows must run the
 * pinned release through `cliCommand`, so none may be hard-coded.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["app", "components", "lib"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

test("no page or component hard-codes an unpinned npx @cascet/cli or @latest", () => {
  const files = DIRS.flatMap((d) => sources(join(ROOT, d)));
  assert.ok(files.length > 20, "the scan found the dashboard sources");
  const offenders: string[] = [];
  for (const file of files) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        // "npx @cascet/cli " with no "@version", or any @latest.
        if (/npx\s+(?:-y\s+)?["']?@cascet\/cli(?!@)/.test(line) || /@cascet\/cli@latest/.test(line)) {
          offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        }
      });
  }
  assert.deepEqual(offenders, []);
});

test("cliCommand runs the pinned spec", () => {
  assert.equal(cliCommand("account-hash 01ab"), `npx ${CLI_SPEC} account-hash 01ab`);
});
