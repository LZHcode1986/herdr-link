#!/usr/bin/env node
/**
 * Herdr Link OpenCode installer.
 *
 * Deploys exactly one OpenCode runtime bundle into the OpenCode plugin
 * directory as `plugins/herdr-link.js`. V1 and V2 are separate bundles for
 * separate hosts; both must never be placed in one plugin directory, and a
 * runtime switch is confirmed and backed up.
 *
 * The installer verifies the source bundle against the fixed build manifest,
 * runs a mandatory V1 SDK precheck (target-directory ESM resolution plus a
 * filesystem version read when deploying V1), refuses to overwrite unknown or
 * modified files without explicit confirmation, scans for duplicate or
 * cross-runtime Herdr Link plugin entries, and verifies the deployed file by
 * importing a byte-identical copy under its own ESM semantics. A failed
 * post-deploy verification rolls the target back — restoring the timestamped
 * backup, or removing the file this run just wrote when no previous file
 * existed.
 *
 * It never installs dependencies, never deletes other plugins, and never
 * touches anything outside its own target file and backup.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MANIFEST_PATH, PACKAGE_ROOT, RUNTIMES, sha256File } from "./build-opencode.mjs";

const PLUGIN_BASENAME = "herdr-link.js";
const V1_SDK_PACKAGE = "@opencode-ai/plugin";
const V1_SDK_SUPPORTED = "^1.18.13 (>=1.18.13 <2.0.0)";
const MARKER_RE = /herdr-link bundle runtime=(v1|v2) version=(\d+\.\d+\.\d+)/;
const COMMAND_TIMEOUT_MS = 30_000;
const HOST_CHECK_TIMEOUT_MS = 60_000;

const USAGE = `usage: herdr-link-opencode-install --runtime v1|v2 [options]

Deploys exactly one OpenCode runtime bundle to <config>/plugins/herdr-link.js.
V1 and V2 are different bundles for different hosts; never deploy both into one
plugin directory. A runtime switch is confirmed and backed up.

options:
  --runtime v1|v2     OpenCode runtime to deploy (required)
  --dry-run           print the plan and exit without writing anything
  --yes, -y           confirm a runtime switch or replacement non-interactively
  --config-dir <dir>  OpenCode configuration directory (default: detected)
  --no-host-check     skip the best-effort \`opencode plugin list\` check
  -h, --help          show this help`;

function parseArgs(argv) {
  const options = { help: false, runtime: undefined, dryRun: false, yes: false, configDir: undefined, hostCheck: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--runtime") options.runtime = argv[++index];
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--config-dir") options.configDir = argv[++index];
    else if (arg === "--no-host-check") options.hostCheck = false;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`unknown argument "${arg}"\n\n${USAGE}`);
  }
  if (!options.help && !RUNTIMES[options.runtime]) {
    throw new Error(options.runtime === undefined ? `missing --runtime\n\n${USAGE}` : `unknown runtime "${options.runtime}"\n\n${USAGE}`);
  }
  if (options.configDir === undefined && argv.includes("--config-dir")) {
    throw new Error(`--config-dir requires a directory\n\n${USAGE}`);
  }
  return options;
}

function readManifest() {
  const manifestFile = resolve(PACKAGE_ROOT, MANIFEST_PATH);
  if (!existsSync(manifestFile)) {
    throw new Error(`this herdr-link package has no ${MANIFEST_PATH}; reinstall herdr-link@latest`);
  }
  return JSON.parse(readFileSync(manifestFile, "utf8"));
}

/** Marker, size and SHA-256 identity of an OpenCode bundle file. */
function readBundleIdentity(file) {
  const bytes = readFileSync(file);
  const marker = MARKER_RE.exec(bytes.toString("utf8", 0, Math.min(bytes.length, 4096)));
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    runtime: marker?.[1],
    version: marker?.[2],
  };
}

function nearestExistingDir(dir) {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function runOpenCode(args, timeout) {
  const command = process.platform === "win32" ? "opencode.cmd" : "opencode";
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    shell: process.platform === "win32",
  });
}

function defaultConfigDir() {
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "opencode");
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "opencode");
  return join(homedir(), ".config", "opencode");
}

/** Config directory: explicit flag, then the host's own answer, then platform defaults. */
function detectConfigDir() {
  const result = runOpenCode(["debug", "paths"], COMMAND_TIMEOUT_MS);
  if (!result.error && result.status === 0) {
    const match = /^config\s+(.+?)\s*$/m.exec(result.stdout ?? "");
    if (match?.[1]) return { dir: resolve(match[1]), source: "`opencode debug paths`" };
  }
  return { dir: defaultConfigDir(), source: "platform default (HOME/XDG/AppData)" };
}

/** Walks up from `startDir` looking for `<dir>/node_modules/<package>/package.json`. */
function findInstalledPackage(startDir, packageName) {
  const segment = packageName.split("/");
  let current = resolve(startDir);
  for (;;) {
    const manifest = join(current, "node_modules", ...segment, "package.json");
    if (existsSync(manifest)) return { packageRoot: dirname(manifest), manifest };
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value).trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : undefined;
}

function satisfiesV1SdkRange(version) {
  if (!version || version.major !== 1) return false;
  if (version.minor > 18) return true;
  return version.minor === 18 && version.patch >= 13;
}

/**
 * Mandatory V1 precheck. Node's ESM resolution is the primary mechanism
 * (`createRequire` resolves under the `require` condition, which this pure-ESM
 * package does not provide, so it is never used here). The filesystem walk
 * reads the version, because the package does not export `./package.json`.
 */
function v1SdkPrecheck(targetDir) {
  const probeDir = nearestExistingDir(targetDir);
  const probeNote =
    probeDir === resolve(targetDir)
      ? undefined
      : `note: ${targetDir} does not exist yet; the probe used the nearest existing directory ${probeDir}, so resolution from the final plugin location is inferred, not directly observed.`;

  const probe = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", 'process.stdout.write(import.meta.resolve("@opencode-ai/plugin"))'],
    { cwd: probeDir, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS },
  );
  if (probe.error) return { ok: false, detail: `the ESM resolution probe could not run: ${probe.error.message}`, probeNote };
  if (probe.status !== 0) {
    const code = /ERR_[A-Z_]+/.exec(probe.stderr ?? "")?.[0];
    return {
      ok: false,
      detail: `Node could not resolve "${V1_SDK_PACKAGE}" from ${probeDir}${code ? ` (${code})` : ""}`,
      probeNote,
    };
  }
  const resolvedUrl = (probe.stdout ?? "").trim();
  if (!resolvedUrl.startsWith("file:")) {
    return { ok: false, detail: "the ESM resolution probe returned an unexpected result", probeNote };
  }

  const installed = findInstalledPackage(probeDir, V1_SDK_PACKAGE);
  if (!installed) {
    return {
      ok: false,
      detail: `Node resolved "${V1_SDK_PACKAGE}" but no node_modules/${V1_SDK_PACKAGE}/package.json was found from ${probeDir}`,
      probeNote,
    };
  }

  const packageRoot = realpathSync(installed.packageRoot);
  let resolvedFile;
  try {
    resolvedFile = realpathSync(fileURLToPath(resolvedUrl));
  } catch {
    return { ok: false, detail: `the resolved entry ${resolvedUrl} does not exist`, probeNote };
  }
  if (resolvedFile !== packageRoot && !resolvedFile.startsWith(packageRoot + sep)) {
    return {
      ok: false,
      detail: `the resolved entry ${resolvedFile} does not belong to ${packageRoot}; the resolution and version probes disagree`,
      probeNote,
    };
  }

  const version = JSON.parse(readFileSync(installed.manifest, "utf8")).version;
  const parsed = parseVersion(version);
  if (!parsed || !satisfiesV1SdkRange(parsed)) {
    return {
      ok: false,
      detail: `installed ${V1_SDK_PACKAGE}@${version} is outside the supported range ${V1_SDK_SUPPORTED}`,
      probeNote,
    };
  }
  return { ok: true, version, probeDir, probeNote };
}

/** Best-effort host registration check; advisory only, never blocks the install. */
function hostCheck() {
  const result = runOpenCode(["plugin", "list"], HOST_CHECK_TIMEOUT_MS);
  if (result.error) return `host check skipped: ${result.error.message}`;
  if (result.status !== 0) return `host check inconclusive: \`opencode plugin list\` exited with status ${result.status}`;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (output.includes("herdr-link")) return "host check: `opencode plugin list` reports herdr-link";
  return "host check: `opencode plugin list` does not list herdr-link yet; a fresh host start may be required (real tool calls are still a separate acceptance step)";
}

function findDuplicateEntries(configDir, cwd, target) {
  const found = [];
  const globalVariant = join(configDir, "plugins", "herdr-link", "index.js");
  if (existsSync(globalVariant)) found.push(globalVariant);

  let current = resolve(cwd);
  for (;;) {
    for (const relative of [join(".opencode", "plugins", PLUGIN_BASENAME), join(".opencode", "plugins", "herdr-link", "index.js")]) {
      const candidate = join(current, relative);
      if (existsSync(candidate) && resolve(candidate) !== resolve(target)) found.push(candidate);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...new Set(found)];
}

function inspectTarget(target, runtime, sourceEntry, manifest) {
  if (!existsSync(target)) return { action: "install" };
  if (statSync(target).isDirectory()) {
    throw new Error(`${target} exists and is a directory; remove it or install manually`);
  }
  const identity = readBundleIdentity(target);
  if (identity.sha256 === sourceEntry.sha256) return { action: "up-to-date", identity };
  const other = runtime === "v1" ? "v2" : "v1";
  const otherEntry = manifest.bundles?.[other];
  if (otherEntry && identity.sha256 === otherEntry.sha256) {
    return { action: "switch", identity, fromRuntime: other };
  }
  return { action: "replace", identity };
}

function backupPathFor(target, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${target}.backup-${stamp}`;
}

function writeBundleAtomically(sourceFile, target) {
  mkdirSync(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.${PLUGIN_BASENAME}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    copyFileSync(sourceFile, temp);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Post-install check: byte identity, runtime marker, and the runtime-specific
 * export shape. Node infers the module type of a bare `.js` file from the
 * nearest package.json, while OpenCode's host decides that for the deployed
 * location; a byte-identical copy inside an isolated `type: module` root
 * checks the file's own ESM semantics on every supported Node version without
 * pretending to be the host. Bare-specifier resolution still walks up into the
 * configuration directory from there.
 */
async function verifyDeployed(target, runtime, sourceEntry) {
  const identity = readBundleIdentity(target);
  if (identity.sha256 !== sourceEntry.sha256) {
    throw new Error(`deployed ${target} sha256 ${identity.sha256} does not match the verified source`);
  }
  if (identity.runtime !== runtime) {
    throw new Error(`deployed ${target} carries runtime=${identity.runtime ?? "unknown"}`);
  }

  const verifyDir = join(dirname(target), `.herdr-link-verify-${process.pid}-${randomBytes(4).toString("hex")}`);
  mkdirSync(verifyDir, { recursive: true });
  try {
    writeFileSync(join(verifyDir, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
    copyFileSync(target, join(verifyDir, "bundle.js"));
    const module = await import(pathToFileURL(join(verifyDir, "bundle.js")).href);
    if (runtime === "v1") {
      if (typeof module.herdrLinkPlugin !== "function") {
        throw new Error('deployed V1 bundle does not export the named "herdrLinkPlugin" function');
      }
    } else if (!module.default || module.default.id !== "herdr-link" || typeof module.default.setup !== "function") {
      throw new Error('deployed V2 bundle does not export default { id: "herdr-link", setup() }');
    }
  } finally {
    rmSync(verifyDir, { recursive: true, force: true });
  }
}

/**
 * Rolls a failed deployment back after `verifyDeployed` rejects. The previous
 * file is restored from the timestamped backup, or — for a first install — the
 * file this run just wrote is removed. Never throws: the original verification
 * error stays the primary failure reported to the user.
 */
function rollbackDeployment(target, backup) {
  if (backup) {
    try {
      copyFileSync(backup, target);
      console.error(`post-deploy verification failed; restored the previous file from ${backup}`);
    } catch (error) {
      console.error(`post-deploy verification failed and the automatic restore did not work: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`the previous file is preserved at ${backup}; restore it manually before starting OpenCode`);
    }
    return;
  }
  try {
    rmSync(target, { force: true });
    console.error("post-deploy verification failed; removed the file this run wrote (no previous file existed)");
  } catch (error) {
    console.error(`post-deploy verification failed and the automatic cleanup did not work: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`remove ${target} manually before starting OpenCode`);
  }
}

function confirm(question) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolvePromise) => {
    readline.question(question, (answer) => {
      readline.close();
      resolvePromise(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function stateLabel(state, runtime) {
  if (state.action === "install") return "new install (target does not exist)";
  if (state.action === "up-to-date") return "already installed (identical bundle)";
  if (state.action === "switch") return `runtime switch: ${state.fromRuntime} → ${runtime} (requires confirmation)`;
  return "replace an unrecognized or modified existing file (requires confirmation)";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const runtime = options.runtime;

  const packageJson = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8"));
  const version = packageJson.version;
  const manifest = readManifest();
  if (manifest.name !== packageJson.name || manifest.version !== version) {
    throw new Error(`build manifest version ${manifest.version} does not match package.json ${version}; reinstall herdr-link@latest`);
  }
  const sourceEntry = manifest.bundles?.[runtime];
  if (!sourceEntry) throw new Error(`this herdr-link package does not contain the ${runtime} bundle; reinstall the package`);
  const sourceFile = resolve(PACKAGE_ROOT, sourceEntry.file);
  if (!existsSync(sourceFile)) throw new Error(`missing ${sourceEntry.file}; the herdr-link package installation is incomplete`);
  if (sha256File(sourceFile) !== sourceEntry.sha256) {
    throw new Error(`${sourceEntry.file} does not match the build manifest (modified or corrupted); reinstall herdr-link@${version}`);
  }
  const sourceIdentity = readBundleIdentity(sourceFile);
  if (sourceIdentity.runtime !== runtime || sourceIdentity.version !== version) {
    throw new Error(`${sourceEntry.file} marker mismatch (runtime=${sourceIdentity.runtime ?? "unknown"}, version=${sourceIdentity.version ?? "unknown"})`);
  }

  const configDir = options.configDir ? { dir: resolve(options.configDir), source: "--config-dir" } : detectConfigDir();
  const target = join(configDir.dir, "plugins", PLUGIN_BASENAME);

  const duplicates = findDuplicateEntries(configDir.dir, process.cwd(), target);
  if (duplicates.length > 0) {
    console.error("Refusing to deploy: another Herdr Link plugin entry is already loaded for this OpenCode setup:");
    for (const file of duplicates) console.error(`  ${file}`);
    console.error("Remove or migrate the duplicate entry first; the installer never deletes other plugin files.");
    process.exitCode = 1;
    return;
  }

  let v1Sdk;
  if (runtime === "v1") {
    v1Sdk = v1SdkPrecheck(dirname(target));
    if (!v1Sdk.ok) {
      console.error(`V1 SDK precheck failed: ${v1Sdk.detail}`);
      console.error(`OpenCode V1 must be able to resolve "${V1_SDK_PACKAGE}" from ${dirname(target)}.`);
      console.error(`Supported range: ${V1_SDK_SUPPORTED}.`);
      console.error("Install the SDK where the plugin can resolve it, for example:");
      console.error(`  cd ${configDir.dir} && npm install ${V1_SDK_PACKAGE}@"^1.18.13"`);
      console.error("Herdr Link does not install dependencies for you. Runtime v2 does not need this SDK.");
      if (v1Sdk.probeNote) console.error(v1Sdk.probeNote);
      process.exitCode = 1;
      return;
    }
  }

  const state = inspectTarget(target, runtime, sourceEntry, manifest);
  const backup = state.action === "install" || state.action === "up-to-date" ? undefined : backupPathFor(target);

  console.log("Herdr Link OpenCode installer");
  console.log(`  package:  herdr-link@${version} (${sourceEntry.file})`);
  console.log(`  runtime:  ${runtime}`);
  console.log(`  config:   ${configDir.dir} (from ${configDir.source})`);
  console.log(`  target:   ${target}`);
  console.log(`  state:    ${stateLabel(state, runtime)}`);
  if (backup) console.log(`  backup:   ${backup}`);
  if (runtime === "v1") {
    console.log(`  v1 sdk:   ${V1_SDK_PACKAGE}@${v1Sdk.version} resolves from ${v1Sdk.probeDir}`);
  } else {
    console.log("  v1 sdk:   not required for runtime v2");
  }
  if (v1Sdk?.probeNote) console.log(`  note:     ${v1Sdk.probeNote}`);

  if (options.dryRun) {
    console.log("dry run: no files were written");
    return;
  }

  if (state.action === "up-to-date") {
    console.log(`nothing to do: ${target} already matches this build`);
    return;
  }

  if (state.action === "switch" || state.action === "replace") {
    if (!options.yes) {
      if (!process.stdin.isTTY) {
        console.error(
          `refusing to ${state.action === "switch" ? "switch runtime" : "replace the existing file"} without explicit confirmation: stdin is not a TTY; re-run with --yes`,
        );
        process.exitCode = 1;
        return;
      }
      const question =
        state.action === "switch"
          ? `Switch ${state.fromRuntime} → ${runtime} at ${target}? [y/N] `
          : `Replace ${target} (runtime=${state.identity.runtime ?? "unknown"}, ${state.identity.sha256.slice(0, 16)}…)? [y/N] `;
      if (!(await confirm(question))) {
        console.error("aborted; no files were changed");
        process.exitCode = 1;
        return;
      }
    }
  }

  if (backup) copyFileSync(target, backup);
  writeBundleAtomically(sourceFile, target);
  try {
    await verifyDeployed(target, runtime, sourceEntry);
  } catch (error) {
    rollbackDeployment(target, backup);
    throw error;
  }

  console.log(`installed ${target}`);
  if (backup) console.log(`backup:   ${backup}`);
  console.log(`verified: runtime=${runtime}, sha256=${sourceEntry.sha256.slice(0, 16)}…, export shape OK`);

  if (options.hostCheck) {
    console.log(options.configDir ? "host check skipped: an explicit --config-dir was used" : hostCheck());
  }
  console.log("next:     restart OpenCode so it loads the deployed bundle");
}

main().catch((error) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
