/**
 * Release governance: every version manifest must match package.json.
 * The Herdr marketplace plugin manifest is installed from this repo, so a
 * version drift there silently ships an outdated plugin listing.
 * Run with: node --experimental-strip-types --test test/*.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MCP_SERVER_VERSION } from "../src/mcp.ts";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

test("release version manifests stay consistent with package.json", () => {
  const packageJson = JSON.parse(read("../package.json")) as { version: string };
  const version = packageJson.version;
  assert.match(version, /^\d+\.\d+\.\d+$/, "package.json version must be semver");

  // package-lock.json records the root package version twice.
  const lock = JSON.parse(read("../package-lock.json")) as {
    version: string;
    packages: Record<string, { version?: string }>;
  };
  assert.equal(lock.version, version, "package-lock.json top-level version");
  assert.equal(lock.packages[""]?.version, version, "package-lock.json root package version");

  // serverInfo.version is informational but must match package.json.
  assert.equal(MCP_SERVER_VERSION, version, "src/mcp.ts MCP_SERVER_VERSION");

  const pluginVersion = read("../herdr-plugin.toml").match(/^version = "([^"]+)"$/m)?.[1];
  assert.equal(pluginVersion, version, "herdr-plugin.toml version");
});
