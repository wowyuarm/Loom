import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const MIRROR_SCRIPT = new URL("../../../src/integrations/workspace-mirror/mirror.mjs", import.meta.url).pathname;

interface RunResult {
  status: number;
  stderr: string;
}

// execFileSync throws on non-zero exit; this wrapper returns the exit code and
// stderr instead, matching how the systemd timer observes the script.
function runMirror(root: string): RunResult {
  try {
    execFileSync(process.execPath, [MIRROR_SCRIPT, "--root", root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    return { status: 0, stderr: "" };
  } catch (error) {
    const failed = error as { status?: number; stderr?: string };
    return { status: failed.status ?? 1, stderr: failed.stderr ?? "" };
  }
}

function fixture(t: test.TestContext): string {
  const root = mkdtempSync(path.join(tmpdir(), "loom-workspace-mirror-"));
  mkdirSync(path.join(root, "configuration"));
  mkdirSync(path.join(root, "workspace"));
  execFileSync("git", ["init", "-q"], { cwd: path.join(root, "workspace") });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeConfig(root: string, body: string): void {
  writeFileSync(path.join(root, "configuration", "instance.yaml"), `version: 1\n${body}`);
}

test("mirror exits 0 without action when workspaceMirror is unconfigured", t => {
  const root = fixture(t);
  writeConfig(root, "");
  const result = runMirror(root);
  assert.equal(result.status, 0);
});

test("mirror exits 0 without action when disabled", t => {
  const root = fixture(t);
  writeConfig(root, "workspaceMirror:\n  enabled: false\n  remote: git@example.com:test.git\n");
  const result = runMirror(root);
  assert.equal(result.status, 0);
});

test("mirror rejects unknown workspaceMirror fields", t => {
  const root = fixture(t);
  writeConfig(root, [
    "workspaceMirror:",
    "  enabled: true",
    "  remote: git@example.com:test.git",
    "  intervalMinutes: 30",
    "",
  ].join("\n"));
  const result = runMirror(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown workspaceMirror field\(s\): intervalMinutes/);
});

test("mirror rejects a non-boolean enabled", t => {
  const root = fixture(t);
  writeConfig(root, "workspaceMirror:\n  enabled: \"yes\"\n  remote: git@example.com:test.git\n");
  const result = runMirror(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /enabled must be a boolean/);
});

test("mirror rejects an empty or non-string branch", t => {
  for (const branch of ["\"\"", "123"]) {
    const root = fixture(t);
    writeConfig(root, `workspaceMirror:\n  enabled: true\n  remote: git@example.com:test.git\n  branch: ${branch}\n`);
    const result = runMirror(root);
    assert.equal(result.status, 1, `branch=${branch}`);
    assert.match(result.stderr, /branch must be a non-empty string/);
  }
});

test("mirror accepts a valid enabled/remote/branch configuration and proceeds to push", t => {
  const root = fixture(t);
  writeConfig(root, [
    "workspaceMirror:",
    "  enabled: true",
    "  remote: git@example.com:test.git",
    "  branch: mirror",
    "",
  ].join("\n"));
  // The configuration passes validation; the script proceeds to git push and
  // fails there because the remote does not exist. That failure must come from
  // the push phase, not from configuration rejection.
  const result = runMirror(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /push failed/);
});
