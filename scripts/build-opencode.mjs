#!/usr/bin/env node
/**
 * Builds one OpenCode runtime bundle (V1 or V2) with a stable runtime/version
 * marker and refreshes `dist/herdr-link.opencode.manifest.json`.
 *
 * The manifest is the single fixed record the installer, the bundle checks and
 * CI/Release all read: for each runtime it stores the bundle path, version,
 * byte size and SHA-256. It is rebuilt from scratch whenever the package
 * version changes, so a stale entry can never survive a version bump.
 *
 * esbuild is imported lazily: this module is also imported by the installer,
 * which must run from a packed npm install where devDependencies (including
 * esbuild) are absent.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const MANIFEST_PATH = "dist/herdr-link.opencode.manifest.json";

export const RUNTIMES = {
  v1: {
    entry: "src/opencode.ts",
    file: "dist/herdr-link.opencode.js",
    external: ["@opencode-ai/plugin"],
  },
  v2: {
    entry: "src/opencode-v2.ts",
    file: "dist/herdr-link.opencode-v2.js",
    external: [],
  },
};

/** Stable identity marker embedded at the top of every bundle. */
export function markerFor(runtime, version) {
  return `/*! herdr-link bundle runtime=${runtime} version=${version} */`;
}

export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** esbuild options shared by the build, the checks and the reproducibility rebuild. */
export function bundleBuildOptions(runtime, version, { root = PACKAGE_ROOT, outfile } = {}) {
  const config = RUNTIMES[runtime];
  if (!config) throw new Error(`unknown OpenCode runtime "${runtime}"`);
  return {
    absWorkingDir: root,
    entryPoints: [config.entry],
    outfile: outfile ?? resolve(root, config.file),
    bundle: true,
    format: "esm",
    platform: "node",
    external: config.external,
    banner: { js: markerFor(runtime, version) },
    logLevel: "silent",
  };
}

/** Builds one runtime bundle; returns the written file and, when requested, its metafile. */
export async function buildRuntime(runtime, { root = PACKAGE_ROOT, version, outfile, metafile = false } = {}) {
  const options = bundleBuildOptions(runtime, version, { root, outfile });
  const { build } = await import("esbuild");
  const result = await build({ ...options, metafile });
  return { outfile: options.outfile, metafile: result.metafile };
}

function updateManifest(runtime, entry, version) {
  const manifestFile = resolve(PACKAGE_ROOT, MANIFEST_PATH);
  let manifest;
  if (existsSync(manifestFile)) {
    try {
      const existing = JSON.parse(readFileSync(manifestFile, "utf8"));
      if (existing?.name === "herdr-link" && existing?.version === version) manifest = existing;
    } catch {
      // Unreadable or outdated manifest: rebuild it from this build.
    }
  }
  manifest ??= { name: "herdr-link", version, bundles: {} };
  const bundles = { v1: manifest.bundles?.v1, v2: manifest.bundles?.v2 };
  bundles[runtime] = entry;
  const ordered = {};
  for (const key of ["v1", "v2"]) {
    if (bundles[key]) ordered[key] = bundles[key];
  }
  const next = { name: "herdr-link", version, bundles: ordered };
  mkdirSync(dirname(manifestFile), { recursive: true });
  writeFileSync(manifestFile, `${JSON.stringify(next, null, 2)}\n`);
}

function parseArgs(argv) {
  let runtime;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--runtime") runtime = argv[++index];
    else if (arg.startsWith("--runtime=")) runtime = arg.slice("--runtime=".length);
    else throw new Error(`unknown argument "${arg}"`);
  }
  if (!RUNTIMES[runtime]) throw new Error("usage: node scripts/build-opencode.mjs --runtime v1|v2");
  return { runtime };
}

async function main() {
  const { runtime } = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8"));
  const version = packageJson.version;
  const { outfile } = await buildRuntime(runtime, { version });
  const bytes = readFileSync(outfile);
  const entry = {
    runtime,
    file: RUNTIMES[runtime].file,
    version,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  updateManifest(runtime, entry, version);
  console.log(
    `built ${entry.file} (runtime=${runtime}, version=${version}, bytes=${entry.bytes}, sha256=${entry.sha256.slice(0, 16)}…)`,
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
