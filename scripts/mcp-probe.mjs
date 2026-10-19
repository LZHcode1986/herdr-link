#!/usr/bin/env node
/**
 * MCP stdio probe: spawns the real herdr-link bundle and tees both
 * directions to a log file in the OS temp directory so the raw handshake with
 * a host (codex) can be inspected. stdout of this process carries only the
 * server's responses; all logging goes to the file.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bundlePath = resolve(root, "dist/herdr-link.mcp.js");
const log = createWriteStream(join(tmpdir(), "mcp-probe.log"), { flags: "a" });
const stamp = () => new Date().toISOString().slice(11, 23);
const dump = (dir, chunk) => {
  log.write(`[${stamp()}] ${dir}: ${JSON.stringify(String(chunk))}\n`);
};

const child = spawn(process.execPath, [bundlePath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});
log.write(`[${stamp()}] probe start, spawned pid=${child.pid}\n`);

process.stdin.on("data", (chunk) => {
  dump("host->server", chunk);
  child.stdin.write(chunk);
});
child.stdout.on("data", (chunk) => {
  dump("server->host", chunk);
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => dump("server-stderr", chunk));
process.stdin.on("end", () => {
  dump("info", "host closed stdin; ending child");
  child.stdin.end();
});
child.on("exit", (code, sig) => {
  dump("info", `child exit code=${code} sig=${sig}`);
  log.end();
  process.exit(code ?? 0);
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
