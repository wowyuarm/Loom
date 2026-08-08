import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentWorkspace } from "../../src/workspace/agent-workspace.js";

test("loads the complete interactivity snapshot from an Agent Workspace", async () => {
  const root = await createWorkspace({ interactivity: "interactivity behavior" });

  const snapshot = await new AgentWorkspace(root).loadTurnSnapshot("interactivity");

  assert.deepEqual(snapshot, {
    identity: "identity material",
    longTermMemory: "long-term memory",
    behavior: "interactivity behavior",
    currentAttention: "current attention",
  });
});

test("selects proactivity behavior for a proactive snapshot", async () => {
  const root = await createWorkspace();

  const snapshot = await new AgentWorkspace(root).loadTurnSnapshot("proactivity");

  assert.equal(snapshot.behavior, "proactivity behavior");
});

test("leaves unknown Agent Workspace files outside the required material contract", async () => {
  const root = await createWorkspace();
  await mkdir(path.join(root, ".private"));
  await writeFile(path.join(root, ".private", "notes.md"), "individual work", "utf8");

  const snapshot = await new AgentWorkspace(root).loadTurnSnapshot("interactivity");

  assert.equal(snapshot.identity, "identity material");
});

test("identifies a missing required Agent Workspace material", async () => {
  const root = await createWorkspace();
  await rm(path.join(root, "identity.md"));

  await assert.rejects(
    new AgentWorkspace(root).loadTurnSnapshot("interactivity"),
    {
      name: "AgentWorkspaceMaterialError",
      message: "Required Agent Workspace material identity.md is missing",
    },
  );
});

test("rejects a required Agent Workspace material containing only whitespace", async () => {
  const root = await createWorkspace({ memory: " \n\t" });

  await assert.rejects(
    new AgentWorkspace(root).loadTurnSnapshot("interactivity"),
    {
      name: "AgentWorkspaceMaterialError",
      message: "Required Agent Workspace material memory.md is empty",
    },
  );
});

async function createWorkspace(overrides: Partial<Record<Material, string>> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "loom-agent-workspace-"));
  await mkdir(path.join(root, "behavior"), { recursive: true });
  const materials: Record<Material, string> = {
    identity: "identity material",
    memory: "long-term memory",
    interactivity: "interactivity behavior",
    proactivity: "proactivity behavior",
    attention: "current attention",
    ...overrides,
  };
  await Promise.all([
    writeFile(path.join(root, "identity.md"), materials.identity, "utf8"),
    writeFile(path.join(root, "memory.md"), materials.memory, "utf8"),
    writeFile(path.join(root, "behavior", "interactivity.md"), materials.interactivity, "utf8"),
    writeFile(path.join(root, "behavior", "proactivity.md"), materials.proactivity, "utf8"),
    writeFile(path.join(root, "attention.md"), materials.attention, "utf8"),
  ]);
  return root;
}

type Material = "identity" | "memory" | "interactivity" | "proactivity" | "attention";
