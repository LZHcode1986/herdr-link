/**
 * Installer rollback tests. The real CLI runs against a throwaway package root
 * whose bundle carries a valid marker and hash but the wrong export shape, so
 * only the final post-deploy verification fails — after the target was already
 * written. Covers both rollback branches (first install: remove; replacement:
 * restore the timestamped backup) plus the untouched happy path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const version = "9.9.9";
const marker = `/*! herdr-link bundle runtime=v2 version=${version} */\n`;
const brokenShapeBundle = `${marker}export default { id: "not-herdr-link" };\n`;
const validBundle = `${marker}export default { id: "herdr-link", setup() {} };\n`;

interface Fixture {
  root: string;
  configDir: string;
  target: string;
}

function createFixture(bundleSource: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "herdr-link-install-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  copyFileSync(join(repoRoot, "scripts", "install-opencode.mjs"), join(root, "scripts", "install-opencode.mjs"));
  copyFileSync(join(repoRoot, "scripts", "build-opencode.mjs"), join(root, "scripts", "build-opencode.mjs"));
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "herdr-link", version })}\n`);
  writeFileSync(join(root, "dist", "fake-v2.js"), bundleSource);
  const manifest = {
    name: "herdr-link",
    version,
    bundles: {
      v2: {
        runtime: "v2",
        file: "dist/fake-v2.js",
        version,
        bytes: Buffer.byteLength(bundleSource),
        sha256: createHash("sha256").update(bundleSource).digest("hex"),
      },
    },
  };
  writeFileSync(join(root, "dist", "herdr-link.opencode.manifest.json"), `${JSON.stringify(manifest)}\n`);
  const configDir = join(root, "config");
  return { root, configDir, target: join(configDir, "plugins", "herdr-link.js") };
}

function runInstaller(fixture: Fixture) {
  return spawnSync(
    process.execPath,
    [join(fixture.root, "scripts", "install-opencode.mjs"), "--runtime", "v2", "--config-dir", fixture.configDir, "--yes"],
    { cwd: fixture.root, encoding: "utf8", timeout: 30_000 },
  );
}

function backupsOf(fixture: Fixture): string[] {
  const dir = join(fixture.configDir, "plugins");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith("herdr-link.js.backup-"));
}

test("installer removes a failed first deployment and reports the rollback", (t) => {
  const fixture = createFixture(brokenShapeBundle);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const result = runInstaller(fixture);

  assert.equal(result.status, 1);
  assert.equal(existsSync(fixture.target), false, "no failed bundle may stay behind");
  assert.match(result.stderr, /removed the file this run wrote/);
  assert.match(result.stderr, /deployed V2 bundle does not export/);
});

test("installer restores the previous file when a replacement fails verification", (t) => {
  const fixture = createFixture(brokenShapeBundle);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const previous = "// previous unrecognized bundle\n";
  mkdirSync(join(fixture.configDir, "plugins"), { recursive: true });
  writeFileSync(fixture.target, previous);

  const result = runInstaller(fixture);

  assert.equal(result.status, 1);
  assert.equal(readFileSync(fixture.target, "utf8"), previous, "the previous file must be restored");
  const backups = backupsOf(fixture);
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(fixture.configDir, "plugins", backups[0]!), "utf8"), previous);
  assert.match(result.stderr, /restored the previous file from/);
});

test("installer still installs a bundle that verifies", (t) => {
  const fixture = createFixture(validBundle);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const result = runInstaller(fixture);

  assert.equal(result.status, 0);
  assert.equal(readFileSync(fixture.target, "utf8"), validBundle);
  assert.match(result.stdout, /verified: runtime=v2/);
  assert.equal(backupsOf(fixture).length, 0);
});
