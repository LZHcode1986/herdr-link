#!/usr/bin/env node
/**
 * Builds the stdio MCP bundle.
 *
 * Uses the esbuild JS API instead of the CLI so the `#!` banner needs no shell
 * quoting: single quotes in an npm script pass through cmd.exe literally, so
 * the CLI form silently produced a bundle without a working shebang on Windows.
 * `check:mcp-bundle` asserts the banner, so such a regression fails the gate.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { build } from "esbuild";

import { PACKAGE_ROOT } from "./build-opencode.mjs";

const outfile = "dist/herdr-link.mcp.js";

await build({
  absWorkingDir: PACKAGE_ROOT,
  entryPoints: ["src/mcp.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  outfile,
});

const bytes = readFileSync(resolve(PACKAGE_ROOT, outfile));
console.log(
  `built ${outfile} (bytes=${bytes.length}, sha256=${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}…)`,
);
