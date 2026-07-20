import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { createWorkspaceReadTools } from "../../src/workspace/tools.js";

test("retains Pi read and ls behavior for paths inside the Agent Workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-workspace-tools-"));
  await mkdir(path.join(root, "notes"));
  await writeFile(path.join(root, "notes", "today.md"), "first\nsecond\nthird\n", "utf8");
  const tools = createWorkspaceReadTools(root);

  const listing = await execute(tools, "ls", { path: "notes" });
  const reading = await execute(tools, "read", { path: "notes/today.md", offset: 2, limit: 1 });

  assert.equal(text(listing), "today.md");
  assert.match(text(reading), /^second/);
  assert.match(text(reading), /more lines in file/);
});

test("rejects lexical paths outside the Agent Workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-workspace-tools-"));
  const tools = createWorkspaceReadTools(root);

  for (const candidate of ["/etc/hosts", "../outside.md", "notes/../../outside.md", "~/notes.md"]) {
    await assert.rejects(
      execute(tools, "read", { path: candidate }),
      /path must stay inside the Agent Workspace/i,
    );
  }
});

test("rejects symlinks that resolve outside the Agent Workspace", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "loom-workspace-tools-"));
  const root = path.join(parent, "workspace");
  const outside = path.join(parent, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  await writeFile(path.join(outside, "private.md"), "outside material", "utf8");
  await symlink(outside, path.join(root, "escape"));
  const tools = createWorkspaceReadTools(root);

  await assert.rejects(
    execute(tools, "read", { path: "escape/private.md" }),
    /path must stay inside the Agent Workspace/i,
  );
  await assert.rejects(
    execute(tools, "ls", { path: "escape" }),
    /path must stay inside the Agent Workspace/i,
  );
});

async function execute(
  tools: ToolDefinition[],
  name: string,
  params: Record<string, unknown>,
) {
  const tool = tools.find(candidate => candidate.name === name);
  assert.ok(tool);
  return tool.execute("tool-call", params, undefined, undefined, undefined as never);
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content
    .flatMap(block => block.type === "text" ? [block.text] : [])
    .join("\n");
}
