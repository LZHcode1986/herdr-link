#!/usr/bin/env node
/**
 * Deterministic checks for the two OpenCode runtime bundles.
 *
 * Verifies the fixed build manifest, runtime markers, byte/SHA-256 identity,
 * import-graph isolation between V1 and V2, build reproducibility, and that
 * `package.json.files` actually ships the bundles, the manifest and the
 * installer. With `--root <dir>` it can run against an extracted npm tarball,
 * which is how Release validates the real publish candidate.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import {
  buildRuntime,
  MANIFEST_PATH,
  markerFor,
  PACKAGE_ROOT,
  RUNTIMES,
  sha256File,
} from "./build-opencode.mjs";

function parseArgs(argv) {
  let root = PACKAGE_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      const value = argv[++index];
      if (!value) throw new Error("--root requires a directory");
      root = resolve(value);
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return { root };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** True when a `package.json.files` pattern covers the given package-relative path. */
function isPacked(relativePath, files) {
  return files.some((pattern) => {
    if (typeof pattern !== "string") return false;
    if (pattern === relativePath) return true;
    const prefix = pattern.endsWith("/") ? pattern : `${pattern}/`;
    return relativePath.startsWith(prefix);
  });
}

async function checkRuntime(root, runtime, version) {
  const entry = manifestEntry(root, runtime);
  const file = resolve(root, entry.file);
  assert(entry.runtime === runtime, `manifest ${runtime} entry has runtime "${entry.runtime}"`);
  assert(entry.version === version, `manifest ${runtime} entry has version "${entry.version}", expected "${version}"`);
  assert(entry.file === RUNTIMES[runtime].file, `manifest ${runtime} entry points at "${entry.file}"`);

  const bytes = readFileSync(file);
  const sha256 = sha256File(file);
  assert(bytes.length === entry.bytes, `${entry.file} is ${bytes.length} bytes, manifest says ${entry.bytes}`);
  assert(sha256 === entry.sha256, `${entry.file} sha256 ${sha256} does not match the manifest ${entry.sha256}`);
  const text = bytes.toString("utf8");
  const marker = markerFor(runtime, version);
  assert(text.startsWith(marker), `${entry.file} does not start with its runtime marker "${marker}"`);

  if (runtime === "v1") {
    assert(!text.includes("@opencode/plugin"), `${entry.file} references the V2 SDK "@opencode/plugin"`);
  } else {
    assert(!text.includes("@opencode-ai/plugin"), `${entry.file} references the V1 SDK "@opencode-ai/plugin"`);
    assert(!text.includes("@opencode/plugin"), `${entry.file} references the V2 SDK "@opencode/plugin" at runtime`);
  }

  // Reproducibility: rebuild with the same options and compare, then audit the
  // import graph from the metafile (authoritative, not a text heuristic).
  const scratch = mkdtempSync(join(tmpdir(), "herdr-link-bundles-"));
  try {
    const rebuiltPath = join(scratch, basename(entry.file));
    const { metafile } = await buildRuntime(runtime, { root, version, outfile: rebuiltPath, metafile: true });
    const rebuiltSha = sha256File(rebuiltPath);
    assert(rebuiltSha === sha256, `${entry.file} is not reproducible: rebuild produced ${rebuiltSha}`);

    const outputs = Object.values(metafile.outputs);
    assert(outputs.length === 1, `${entry.file} rebuild produced ${outputs.length} outputs`);
    const externals = outputs[0].imports.filter((item) => item.external).map((item) => item.path);
    const nonNodeExternals = externals.filter((path) => !path.startsWith("node:"));
    if (runtime === "v1") {
      assert(
        nonNodeExternals.length === 1 && nonNodeExternals[0] === "@opencode-ai/plugin",
        `v1 bundle externals must be node builtins plus "@opencode-ai/plugin"; found ${nonNodeExternals.join(", ") || "none"}`,
      );
    } else {
      assert(
        nonNodeExternals.length === 0,
        `v2 bundle must not import any runtime SDK; found ${nonNodeExternals.join(", ")}`,
      );
    }

    // esbuild reports metafile paths with forward slashes, but normalize anyway
    // so a Windows run cannot fail the import-graph audit on path separators.
    const inputs = Object.keys(metafile.inputs).map((path) => path.replaceAll(sep, "/"));
    const includesInput = (suffix) => inputs.some((path) => path.endsWith(suffix));
    assert(includesInput("src/herdr.ts"), `${runtime} bundle does not inline the shared herdr core`);
    assert(includesInput("src/protocol.ts"), `${runtime} bundle does not inline the shared protocol core`);
    if (runtime === "v1") {
      assert(includesInput("src/opencode.ts"), "v1 bundle does not include src/opencode.ts");
      assert(!includesInput("src/opencode-v2.ts"), "v1 bundle includes src/opencode-v2.ts");
      assert(
        !inputs.some((path) => path.includes("node_modules/@opencode/")),
        "v1 bundle includes the V2 SDK package",
      );
    } else {
      assert(includesInput("src/opencode-v2.ts"), "v2 bundle does not include src/opencode-v2.ts");
      assert(!includesInput("src/opencode.ts"), "v2 bundle includes src/opencode.ts");
      assert(
        !inputs.some((path) => path.includes("node_modules/@opencode")),
        "v2 bundle includes an OpenCode SDK package",
      );
    }
    return { externals, sha256 };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function manifestEntry(root, runtime) {
  const entry = manifest.bundles?.[runtime];
  assert(entry, `manifest is missing the ${runtime} bundle entry`);
  return entry;
}

const { root } = parseArgs(process.argv.slice(2));
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const manifestFile = resolve(root, MANIFEST_PATH);
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
} catch {
  throw new Error(`missing or unreadable ${MANIFEST_PATH}; build both bundles first`);
}

assert(manifest.name === packageJson.name, `manifest name "${manifest.name}" does not match "${packageJson.name}"`);
assert(
  manifest.version === packageJson.version,
  `manifest version "${manifest.version}" does not match package.json "${packageJson.version}"`,
);

const files = packageJson.files ?? [];
assert(isPacked(MANIFEST_PATH, files), `package.json.files does not ship ${MANIFEST_PATH}`);

const results = {};
for (const runtime of ["v1", "v2"]) {
  assert(isPacked(RUNTIMES[runtime].file, files), `package.json.files does not ship ${RUNTIMES[runtime].file}`);
  results[runtime] = await checkRuntime(root, runtime, packageJson.version);
}
for (const script of ["scripts/install-opencode.mjs", "scripts/build-opencode.mjs"]) {
  assert(isPacked(script, files), `package.json.files does not ship ${script}`);
}

console.log("OpenCode bundle check OK");
for (const runtime of ["v1", "v2"]) {
  const entry = manifest.bundles[runtime];
  console.log(
    `  ${runtime}: ${entry.file} sha256=${entry.sha256.slice(0, 16)}… externals=[${results[runtime].externals.join(", ")}]` +
      ` (reproducible, import graph isolated)`,
  );
}
console.log(`  manifest: ${MANIFEST_PATH} (version ${manifest.version}, shipped by package.json.files)`);
