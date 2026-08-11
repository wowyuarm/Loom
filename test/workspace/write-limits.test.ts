import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKSPACE_WRITE_LIMITS,
  enforceWorkspaceWriteLimit,
} from "../../src/workspace/workspace-write-limits.js";

const kiB = 1024;
const MiB = 1024 * kiB;

function bytes(base: number): string {
  return "x".repeat(base);
}

test("WORKSPACE_WRITE_LIMITS carries the calibrated per-file limits", () => {
  const byPath = new Map(WORKSPACE_WRITE_LIMITS.map(rule => [rule.label, rule.limitBytes]));
  assert.equal(byPath.get("attention.md"), 64 * kiB);
  assert.equal(byPath.get("identity.md"), 64 * kiB);
  assert.equal(byPath.get("memory.md"), 256 * kiB);
  assert.equal(byPath.get("facts.json"), 64 * kiB);
  assert.equal(byPath.get("behavior/interactivity.md"), 64 * kiB);
  assert.equal(byPath.get("behavior/proactivity.md"), 64 * kiB);
  assert.equal(byPath.get("daily/<day>.md"), 128 * kiB);
  assert.equal(byPath.get("episodes/<day>/<id>.md"), 32 * kiB);
  assert.equal(byPath.get("threads/index.md"), 256 * kiB);
  assert.equal(byPath.get("threads/<line>/thread.md"), 256 * kiB);
});

test("an over-limit write is rejected with a recoverable error naming file, cap and excess", () => {
  const rel = "attention.md";
  const cap = 64 * kiB;
  const actual = cap + 1;
  assert.throws(
    () => enforceWorkspaceWriteLimit(rel, bytes(actual)),
    (error: unknown) => {
      const message = String(error instanceof Error ? error.message : error);
      return message.includes(rel)
        && message.includes(String(cap))
        && message.includes(String(actual))
        && message.includes(String(actual - cap))
        && message.toLowerCase().includes("delete");
    },
  );
});

test("a write exactly at the limit is allowed", () => {
  assert.doesNotThrow(() => enforceWorkspaceWriteLimit("attention.md", bytes(64 * kiB)));
  assert.doesNotThrow(() => enforceWorkspaceWriteLimit("threads/index.md", bytes(256 * kiB)));
});

test("a write within the limit is allowed", () => {
  assert.doesNotThrow(() => enforceWorkspaceWriteLimit("attention.md", bytes(1024)));
  assert.doesNotThrow(() => enforceWorkspaceWriteLimit("memory.md", bytes(128 * kiB)));
});

test("daily and episode any-day/id paths are capped by their prefix rules", () => {
  assert.throws(() => enforceWorkspaceWriteLimit("daily/2026-08-09.md", bytes(128 * kiB + 1)));
  assert.throws(() => enforceWorkspaceWriteLimit("episodes/2026-08-09/abc.md", bytes(32 * kiB + 1)));
  assert.doesNotThrow(() => enforceWorkspaceWriteLimit("daily/2026-08-09.md", bytes(128 * kiB)));
  assert.doesNotThrow(() => enforceWorkspaceWriteLimit("episodes/2026-08-09/abc.md", bytes(32 * kiB)));
});

test("threads index and line thread.md are capped by path patterns", () => {
  assert.throws(() => enforceWorkspaceWriteLimit("threads/index.md", bytes(256 * kiB + 1)));
  assert.throws(() => enforceWorkspaceWriteLimit("threads/garden/thread.md", bytes(256 * kiB + 1)));
  assert.doesNotThrow(() => enforceWorkspaceWriteLimit("threads/garden/thread.md", bytes(256 * kiB)));
});

test("unmatched or malformed paths are not limited (default pass)", () => {
  assert.doesNotThrow(() => enforceWorkspaceWriteLimit("threads/garden/notes/2026-08-09.md", bytes(MiB)));
  assert.doesNotThrow(() => enforceWorkspaceWriteLimit("unlisted-file.md", bytes(5 * MiB)));
  assert.doesNotThrow(() => enforceWorkspaceWriteLimit("garden/cuttings.md", bytes(5 * MiB)));
  // Malformed date / non-.md / nested paths that the precise rules do not catch.
  assert.doesNotThrow(() => enforceWorkspaceWriteLimit("daily/2026-08", bytes(5 * MiB)));
  assert.doesNotThrow(() => enforceWorkspaceWriteLimit("daily/notes/2026-08-09.md", bytes(5 * MiB)));
  assert.doesNotThrow(() => enforceWorkspaceWriteLimit("daily/2026-08-09", bytes(5 * MiB)));
  assert.doesNotThrow(() => enforceWorkspaceWriteLimit("episodes/2026-08-09", bytes(5 * MiB)));
  assert.doesNotThrow(() => enforceWorkspaceWriteLimit("episodes/2026-08-09/a/b.md", bytes(5 * MiB)));
});

test("an empty or non-relative path is not limited", () => {
  assert.doesNotThrow(() => enforceWorkspaceWriteLimit("", bytes(5 * MiB)));
});
