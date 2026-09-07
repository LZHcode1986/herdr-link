import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const bundlePath = resolve(root, "dist/herdr-link.mcp.js");
const requiredTools = ["herdr_link_start", "herdr_link_peers", "herdr_link_send", "herdr_link_close"];
const bundle = readFileSync(bundlePath, "utf8");

for (const tool of requiredTools) {
  if (!bundle.includes(JSON.stringify(tool))) {
    throw new Error(`MCP bundle is missing required tool ${tool}`);
  }
}

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: "mcp-version-check",
  method: "initialize",
  params: { protocolVersion: "2025-06-18" },
});
const child = spawnSync(process.execPath, [bundlePath], {
  cwd: root,
  input: `${initialize}\n`,
  encoding: "utf8",
  timeout: 10_000,
});

if (child.error) throw child.error;
if (child.status !== 0) {
  throw new Error(`MCP bundle exited with status ${child.status}: ${child.stderr.trim()}`);
}

const response = child.stdout
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .find((message) => message.id === "mcp-version-check");
const reportedVersion = response?.result?.serverInfo?.version;

if (reportedVersion !== packageJson.version) {
  throw new Error(
    `MCP version mismatch: package.json=${packageJson.version}, serverInfo.version=${reportedVersion ?? "<missing>"}`,
  );
}

console.log(`MCP bundle ${reportedVersion} matches package.json ${packageJson.version}`);
console.log(`MCP bundle contains ${requiredTools.join(", ")}`);
