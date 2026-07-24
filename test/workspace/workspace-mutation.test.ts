import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  beginWorkspaceMutation,
  beginWorkspaceTreeMutation,
  recoverWorkspaceMutations,
} from "../../src/workspace/workspace-mutation.js";

test("restores an incomplete Workspace mutation before the Workspace is reused", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-workspace-mutation-"));
  const workspaceRoot = path.join(root, "workspace");
  const journalRoot = path.join(root, "runtime", "workspace-mutations");
  const daily = path.join(workspaceRoot, "daily", "2026-07-24.md");
  await mkdir(path.dirname(daily), { recursive: true });
  await writeFile(daily, "complete earlier narrative\n", "utf8");

  const opened = await beginWorkspaceMutation<{ outcome: string }>({
    workspaceRoot,
    journalRoot,
    operationKey: "life-recorder:activity-1",
  });
  assert.equal(opened.state, "active");
  await opened.mutation.write("daily/2026-07-24.md", "partial replacement\n");
  assert.equal(await readFile(daily, "utf8"), "partial replacement\n");

  await recoverWorkspaceMutations({ workspaceRoot, journalRoot });

  assert.equal(await readFile(daily, "utf8"), "complete earlier narrative\n");
});

test("replays a completed Workspace mutation without repeating its work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-workspace-completed-"));
  const workspaceRoot = path.join(root, "workspace");
  const journalRoot = path.join(root, "runtime", "workspace-mutations");
  await mkdir(workspaceRoot, { recursive: true });
  const options = { workspaceRoot, journalRoot, operationKey: "memory-reflector:2026-07-24" };

  const first = await beginWorkspaceMutation<{ outcome: "updated"; runId: string }>(options);
  assert.equal(first.state, "active");
  await first.mutation.write("memory.md", "complete new memory\n");
  await first.mutation.complete({ outcome: "updated", runId: "reflection-1" });

  const reopened = await beginWorkspaceMutation<{ outcome: "updated"; runId: string }>(options);

  assert.deepEqual(reopened, {
    state: "completed",
    result: { outcome: "updated", runId: "reflection-1" },
  });
  assert.equal(await readFile(path.join(workspaceRoot, "memory.md"), "utf8"), "complete new memory\n");
});

test("restores an incomplete Thread tree including moves", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-workspace-tree-"));
  const workspaceRoot = path.join(root, "workspace");
  const journalRoot = path.join(root, "runtime", "workspace-mutations");
  const threadRoot = path.join(workspaceRoot, "threads");
  await mkdir(path.join(threadRoot, "garden"), { recursive: true });
  await chmod(threadRoot, 0o750);
  await writeFile(path.join(threadRoot, "index.md"), "garden\n", "utf8");
  await writeFile(path.join(threadRoot, "garden", "thread.md"), "living thread\n", "utf8");

  const opened = await beginWorkspaceTreeMutation<{ outcome: string }>({
    workspaceRoot,
    journalRoot,
    operationKey: "thread-maintainer:activity-1",
    treePath: "threads",
  });
  assert.equal(opened.state, "active");
  await rename(path.join(threadRoot, "garden"), path.join(threadRoot, "archive"));
  await writeFile(path.join(threadRoot, "index.md"), "partial archive\n", "utf8");

  await recoverWorkspaceMutations({ workspaceRoot, journalRoot });

  assert.equal(await readFile(path.join(threadRoot, "index.md"), "utf8"), "garden\n");
  assert.equal(await readFile(path.join(threadRoot, "garden", "thread.md"), "utf8"), "living thread\n");
  assert.equal((await stat(threadRoot)).mode & 0o777, 0o750);
});
