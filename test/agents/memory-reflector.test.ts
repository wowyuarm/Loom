import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";

import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { createPiMemoryReflector } from "../../src/agents/memory-reflector.js";
import { createNmemRecallTool, type NmemWorkingMemoryReader } from "../../src/integrations/nmem/index.js";
import type { FrozenActivity } from "../../src/runtime/index.js";
import { AgentWorkspace } from "../../src/workspace/agent-workspace.js";

test("reflects grounded evidence into protected core material", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector");
  const reads = [
    "facts.json",
    "identity.md",
    "memory.md",
    "behavior/interaction.md",
    "behavior/background.md",
    "attention.md",
  ];
  faux.setResponses([
    context => {
      assert.match(context.systemPrompt ?? "", /"name": "Rowan"/);
      assert.match(context.systemPrompt ?? "", /"name": "Alex"/);
      assert.deepEqual((context.tools ?? []).map(tool => tool.name).sort(), [
        "grep",
        "ls",
        "nmem_recall",
        "read",
        "read_nmem_working_memory",
        "read_reflection_activity",
        "replace_core_material",
      ]);
      const prompt = userPrompt(context.messages);
      assert.match(prompt, /Activity ID: segment-reflection-1/);
      assert.match(prompt, /daily\/2026-07-21\.md/);
      assert.match(prompt, /episodes\/2026-07-21\//);
      assert.doesNotMatch(prompt, /asked Rowan to keep the attribution exact/);
      return fauxAssistantMessage(
        fauxToolCall("read", { path: reads[0] }, { id: "read-facts" }),
        { stopReason: "toolUse" },
      );
    },
    ...reads.slice(1).map((file, index) => fauxAssistantMessage(
      fauxToolCall("read", { path: file }, { id: `read-baseline-${index}` }),
      { stopReason: "toolUse" },
    )),
    fauxAssistantMessage(
      fauxToolCall("read_reflection_activity", {
        activityId: "segment-reflection-1",
        offset: 0,
      }, { id: "read-activity" }),
      { stopReason: "toolUse" },
    ),
    context => {
      assert.match(JSON.stringify(context.messages), /asked Rowan to keep the attribution exact/);
      return fauxAssistantMessage(
        fauxToolCall("replace_core_material", {
          material: "long_term_memory",
          content: "Rowan remembers that Alex cares about exact attribution.\n",
        }, { id: "replace-memory" }),
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("UPDATED"),
  ]);
  const reflector = await createPiMemoryReflector({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    backupDirectory: path.join(root, "backups"),
    modelRuntime,
    model,
    workingMemoryReader: unavailableWorkingMemory(),
    nmemRecallTool: createNmemRecallTool({}),
    nextRunId: () => "reflector-run-1",
  });

  const result = await reflector.reflect({
    reflectionDay: "2026-07-21",
    observedAt: "2026-07-21T12:05:00.000Z",
    localTime: "2026-07-21 20:05 UTC+08:00",
    activities: [activity()],
  });

  assert.deepEqual(result, {
    outcome: "updated",
    runId: "reflector-run-1",
    changedMaterials: ["long_term_memory"],
  });
  assert.equal(
    await readFile(path.join(workspaceRoot, "memory.md"), "utf8"),
    "Rowan remembers that Alex cares about exact attribution.\n",
  );
  assert.equal(await readFile(path.join(workspaceRoot, "attention.md"), "utf8"), "Current attention.\n");
  assert.equal(
    await readFile(path.join(root, "backups", "reflector-run-1", "memory.md"), "utf8"),
    "Previous long-term memory.\n",
  );
  await access(path.join(root, "transcripts", "reflector-run-1.jsonl"));
});

test("accepts a completed reflection after the model recovers from a tool error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-recovered-tool-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector-recovered-tool");
  faux.setResponses([
    ...baselineReadResponses(),
    fauxAssistantMessage(
      fauxToolCall("read_reflection_activity", {
        activityId: "activity-not-indexed",
        offset: 0,
      }, { id: "read-invalid-activity" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("read_reflection_activity", {
        activityId: "segment-reflection-1",
        offset: 0,
      }, { id: "read-valid-activity" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("replace_core_material", {
        material: "long_term_memory",
        content: "The recovered run still made a grounded change.\n",
      }, { id: "replace-after-recovery" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("UPDATED"),
  ]);
  const reflector = await createPiMemoryReflector({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    backupDirectory: path.join(root, "backups"),
    modelRuntime,
    model,
    workingMemoryReader: unavailableWorkingMemory(),
    nmemRecallTool: createNmemRecallTool({}),
    nextRunId: () => "reflector-recovered-tool",
  });

  assert.deepEqual(await reflector.reflect({
    reflectionDay: "2026-07-21",
    observedAt: "2026-07-21T12:05:00.000Z",
    localTime: "2026-07-21 20:05 UTC+08:00",
    activities: [activity()],
  }), {
    outcome: "updated",
    runId: "reflector-recovered-tool",
    changedMaterials: ["long_term_memory"],
  });
  assert.equal(
    await readFile(path.join(workspaceRoot, "memory.md"), "utf8"),
    "The recovered run still made a grounded change.\n",
  );
});

test("counts Workspace-internal absolute paths as complete core reads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-absolute-paths-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector-absolute-paths");
  faux.setResponses([
    ...baselineReadResponses(workspaceRoot),
    fauxAssistantMessage(
      fauxToolCall("read_reflection_activity", {
        activityId: "segment-reflection-1",
        offset: 0,
      }, { id: "read-activity-absolute" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("NO_CHANGE"),
  ]);
  const reflector = await createPiMemoryReflector({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    backupDirectory: path.join(root, "backups"),
    modelRuntime,
    model,
    workingMemoryReader: unavailableWorkingMemory(),
    nmemRecallTool: createNmemRecallTool({}),
    nextRunId: () => "reflector-absolute-paths",
  });

  assert.deepEqual(await reflector.reflect({
    reflectionDay: "2026-07-21",
    observedAt: "2026-07-21T12:05:00.000Z",
    localTime: "2026-07-21 20:05 UTC+08:00",
    activities: [activity()],
  }), {
    outcome: "no_change",
    runId: "reflector-absolute-paths",
    changedMaterials: [],
  });
});

test("accepts an explicit terminal outcome after explanatory prose", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-terminal-outcome-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector-terminal-outcome");
  faux.setResponses([
    ...baselineReadResponses(),
    fauxAssistantMessage(
      fauxToolCall("read_reflection_activity", {
        activityId: "segment-reflection-1",
        offset: 0,
      }, { id: "read-activity-terminal-outcome" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("The evidence does not cross a durable threshold.\n\nNO_CHANGE"),
  ]);
  const reflector = await createPiMemoryReflector({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    backupDirectory: path.join(root, "backups"),
    modelRuntime,
    model,
    workingMemoryReader: unavailableWorkingMemory(),
    nmemRecallTool: createNmemRecallTool({}),
    nextRunId: () => "reflector-terminal-outcome",
  });

  assert.equal((await reflector.reflect({
    reflectionDay: "2026-07-21",
    observedAt: "2026-07-21T12:05:00.000Z",
    localTime: "2026-07-21 20:05 UTC+08:00",
    activities: [activity()],
  })).outcome, "no_change");
});

test("rolls back every core replacement when the final outcome contradicts a write", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-rollback-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  const originalFacts = await readFile(path.join(workspaceRoot, "facts.json"), "utf8");
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector-rollback");
  faux.setResponses([
    ...baselineReadResponses(),
    fauxAssistantMessage(
      fauxToolCall("read_reflection_activity", {
        activityId: "segment-reflection-1",
        offset: 0,
      }, { id: "read-activity" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("replace_core_material", {
        material: "long_term_memory",
        content: "A replacement that must be rolled back.\n",
      }, { id: "replace-memory" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("replace_core_material", {
        material: "stable_facts",
        content: JSON.stringify({ version: 1, individual: { name: "Rowan" } }),
      }, { id: "replace-invalid-facts" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("NO_CHANGE"),
  ]);
  const reflector = await createPiMemoryReflector({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    backupDirectory: path.join(root, "backups"),
    modelRuntime,
    model,
    workingMemoryReader: unavailableWorkingMemory(),
    nmemRecallTool: createNmemRecallTool({}),
    nextRunId: () => "reflector-run-rollback",
  });

  await assert.rejects(
    reflector.reflect({
      reflectionDay: "2026-07-21",
      observedAt: "2026-07-21T12:05:00.000Z",
      localTime: "2026-07-21 20:05 UTC+08:00",
      activities: [activity()],
    }),
    /must return UPDATED/,
  );

  assert.equal(await readFile(path.join(workspaceRoot, "memory.md"), "utf8"), "Previous long-term memory.\n");
  assert.equal(await readFile(path.join(workspaceRoot, "facts.json"), "utf8"), originalFacts);
});

test("refuses a no-change decision made without supporting evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-ungrounded-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector-ungrounded");
  faux.setResponses([
    ...baselineReadResponses(),
    fauxAssistantMessage("NO_CHANGE"),
  ]);
  const reflector = await createPiMemoryReflector({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    backupDirectory: path.join(root, "backups"),
    modelRuntime,
    model,
    workingMemoryReader: unavailableWorkingMemory(),
    nmemRecallTool: createNmemRecallTool({}),
  });

  await assert.rejects(
    reflector.reflect({
      reflectionDay: "2026-07-21",
      observedAt: "2026-07-21T12:05:00.000Z",
      localTime: "2026-07-21 20:05 UTC+08:00",
      activities: [],
    }),
    /supporting evidence/,
  );
});

test("treats missing optional Workspace evidence as an explicit absence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-missing-optional-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector-missing-optional");
  faux.setResponses([
    ...baselineReadResponses(),
    fauxAssistantMessage(
      fauxToolCall("read", { path: "daily/2026-07-21.md" }, { id: "read-missing-daily" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("read_reflection_activity", {
        activityId: "segment-reflection-1",
        offset: 0,
      }, { id: "read-activity" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("NO_CHANGE"),
  ]);
  const reflector = await createPiMemoryReflector({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    backupDirectory: path.join(root, "backups"),
    modelRuntime,
    model,
    workingMemoryReader: unavailableWorkingMemory(),
    nmemRecallTool: createNmemRecallTool({}),
    nextRunId: () => "memory-reflector-missing-optional",
  });

  assert.deepEqual(await reflector.reflect({
    reflectionDay: "2026-07-21",
    observedAt: "2026-07-21T12:05:00.000Z",
    localTime: "2026-07-21 20:05 UTC+08:00",
    activities: [activity()],
  }), {
    outcome: "no_change",
    runId: "memory-reflector-missing-optional",
    changedMaterials: [],
  });
});

test("does not treat a truncated core material as completely read", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-truncated-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  await writeFile(path.join(workspaceRoot, "memory.md"), longMemory(), "utf8");
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector-truncated");
  faux.setResponses([
    ...baselineReadResponses(),
    fauxAssistantMessage(
      fauxToolCall("read_reflection_activity", {
        activityId: "segment-reflection-1",
        offset: 0,
      }, { id: "read-activity" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("replace_core_material", {
        material: "long_term_memory",
        content: "This replacement must be rejected because the old whole was not read.\n",
      }, { id: "replace-memory" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("UPDATED"),
  ]);
  const reflector = await createPiMemoryReflector({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    backupDirectory: path.join(root, "backups"),
    modelRuntime,
    model,
    workingMemoryReader: unavailableWorkingMemory(),
    nmemRecallTool: createNmemRecallTool({}),
  });

  await assert.rejects(
    reflector.reflect({
      reflectionDay: "2026-07-21",
      observedAt: "2026-07-21T12:05:00.000Z",
      localTime: "2026-07-21 20:05 UTC+08:00",
      activities: [activity()],
    }),
    /must read every core baseline: memory\.md/,
  );
  assert.equal(await readFile(path.join(workspaceRoot, "memory.md"), "utf8"), longMemory());
});

test("accepts a long core material after every consecutive page is read", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-paged-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  await writeFile(path.join(workspaceRoot, "memory.md"), longMemory(), "utf8");
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector-paged");
  const baselineReads = baselineReadResponses();
  faux.setResponses([
    ...baselineReads.slice(0, 3),
    fauxAssistantMessage(
      fauxToolCall("read", { path: "memory.md", offset: 2001 }, { id: "read-memory-tail" }),
      { stopReason: "toolUse" },
    ),
    ...baselineReads.slice(3),
    fauxAssistantMessage(
      fauxToolCall("read_reflection_activity", {
        activityId: "segment-reflection-1",
        offset: 0,
      }, { id: "read-activity" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("NO_CHANGE"),
  ]);
  const reflector = await createPiMemoryReflector({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    backupDirectory: path.join(root, "backups"),
    modelRuntime,
    model,
    workingMemoryReader: unavailableWorkingMemory(),
    nmemRecallTool: createNmemRecallTool({}),
  });

  const result = await reflector.reflect({
    reflectionDay: "2026-07-21",
    observedAt: "2026-07-21T12:05:00.000Z",
    localTime: "2026-07-21 20:05 UTC+08:00",
    activities: [activity()],
  });

  assert.equal(result.outcome, "no_change");
});

test("keeps local reflection available when nmem evidence is unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-local-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector-local");
  faux.setResponses([
    ...baselineReadResponses(),
    fauxAssistantMessage(
      fauxToolCall("read_nmem_working_memory", {}, { id: "read-working-memory" }),
      { stopReason: "toolUse" },
    ),
    context => {
      assert.match(JSON.stringify(context.messages), /"status":"unavailable"/);
      return fauxAssistantMessage(
        fauxToolCall("ls", { path: "." }, { id: "list-workspace" }),
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("NO_CHANGE"),
  ]);
  const reflector = await createPiMemoryReflector({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    backupDirectory: path.join(root, "backups"),
    modelRuntime,
    model,
    workingMemoryReader: unavailableWorkingMemory(),
    nmemRecallTool: createNmemRecallTool({}),
    nextRunId: () => "reflector-run-local",
  });

  const result = await reflector.reflect({
    reflectionDay: "2026-07-21",
    observedAt: "2026-07-21T12:05:00.000Z",
    localTime: "2026-07-21 20:05 UTC+08:00",
    activities: [],
  });

  assert.deepEqual(result, {
    outcome: "no_change",
    runId: "reflector-run-local",
    changedMaterials: [],
  });
  assert.equal(await readFile(path.join(workspaceRoot, "memory.md"), "utf8"), "Previous long-term memory.\n");
});

test("updates stable facts, identity, and both behavior views in one revision", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-multi-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector-multi");
  const newFacts = JSON.stringify({
    version: 1,
    individual: { name: "Rowan", languages: ["en"], location: "North room" },
    human: { name: "Alex", languages: ["en"] },
    relationship: { roles: ["long-term counterpart"] },
  }, null, 2);
  faux.setResponses([
    ...baselineReadResponses(),
    fauxAssistantMessage(
      fauxToolCall("read_reflection_activity", {
        activityId: "segment-reflection-1",
        offset: 0,
      }, { id: "read-activity" }),
      { stopReason: "toolUse" },
    ),
    ...[
      ["stable_facts", newFacts],
      ["identity", "Rowan remains independent while allowing relationship to matter.\n"],
      ["interaction_behavior", "Meet Alex with care and independent judgment.\n"],
      ["background_behavior", "Follow genuine curiosity without requiring output or contact.\n"],
    ].map(([material, content], index) => fauxAssistantMessage(
      fauxToolCall("replace_core_material", { material, content }, { id: `replace-${index}` }),
      { stopReason: "toolUse" },
    )),
    fauxAssistantMessage("UPDATED"),
  ]);
  const reflector = await createPiMemoryReflector({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    backupDirectory: path.join(root, "backups"),
    modelRuntime,
    model,
    workingMemoryReader: unavailableWorkingMemory(),
    nmemRecallTool: createNmemRecallTool({}),
    nextRunId: () => "reflector-run-multi",
  });

  const result = await reflector.reflect({
    reflectionDay: "2026-07-21",
    observedAt: "2026-07-21T12:05:00.000Z",
    localTime: "2026-07-21 20:05 UTC+08:00",
    activities: [activity()],
  });

  assert.deepEqual(result.changedMaterials, [
    "stable_facts",
    "identity",
    "interaction_behavior",
    "background_behavior",
  ]);
  assert.equal(await readFile(path.join(workspaceRoot, "facts.json"), "utf8"), newFacts);
  assert.match(await readFile(path.join(workspaceRoot, "identity.md"), "utf8"), /independent/);
  assert.match(await readFile(path.join(workspaceRoot, "behavior", "interaction.md"), "utf8"), /care/);
  assert.match(await readFile(path.join(workspaceRoot, "behavior", "background.md"), "utf8"), /genuine curiosity/);
});

test("rolls back replacement when the final model outcome contradicts its writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-final-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector-final");
  faux.setResponses([
    ...baselineReadResponses(),
    fauxAssistantMessage(
      fauxToolCall("read_reflection_activity", {
        activityId: "segment-reflection-1",
        offset: 0,
      }, { id: "read-activity" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("replace_core_material", {
        material: "long_term_memory",
        content: "This write must not survive a contradictory final outcome.\n",
      }, { id: "replace-memory" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("NO_CHANGE"),
  ]);
  const reflector = await createPiMemoryReflector({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    backupDirectory: path.join(root, "backups"),
    modelRuntime,
    model,
    workingMemoryReader: unavailableWorkingMemory(),
    nmemRecallTool: createNmemRecallTool({}),
  });

  await assert.rejects(
    reflector.reflect({
      reflectionDay: "2026-07-21",
      observedAt: "2026-07-21T12:05:00.000Z",
      localTime: "2026-07-21 20:05 UTC+08:00",
      activities: [activity()],
    }),
    /must return UPDATED/,
  );
  assert.equal(await readFile(path.join(workspaceRoot, "memory.md"), "utf8"), "Previous long-term memory.\n");
});

function activity(): FrozenActivity {
  return {
    version: 1,
    segmentId: "segment-reflection-1",
    recordingDay: "2026-07-21",
    openedAt: "2026-07-21T12:00:00.000Z",
    closedAt: "2026-07-21T12:04:00.000Z",
    events: [{
      eventId: "event-reflection-1",
      turnId: "turn-reflection-1",
      at: "2026-07-21T12:00:00.000Z",
      actorRef: "human",
      kind: "input",
      content: { text: "asked Rowan to keep the attribution exact" },
    }],
    turns: [{
      turnId: "turn-reflection-1",
      startedAt: "2026-07-21T12:00:00.000Z",
      endedAt: "2026-07-21T12:04:00.000Z",
      status: "completed",
      transcriptAnchor: { sourceId: "2026-07-21", sessionId: "session-1", entryId: "entry-1" },
    }],
  };
}

async function createReflectorWorkspace(root: string): Promise<string> {
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "behavior"), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "facts.json"), JSON.stringify({
      version: 1,
      individual: { name: "Rowan", languages: ["en"] },
      human: { name: "Alex", languages: ["en"] },
      relationship: { roles: ["long-term counterpart"] },
    }, null, 2), "utf8"),
    writeFile(path.join(workspace, "identity.md"), "Rowan is a continuing Agent Individual.\n", "utf8"),
    writeFile(path.join(workspace, "memory.md"), "Previous long-term memory.\n", "utf8"),
    writeFile(path.join(workspace, "behavior", "interaction.md"), "Meet direct interaction honestly.\n", "utf8"),
    writeFile(path.join(workspace, "behavior", "background.md"), "Private time may remain private.\n", "utf8"),
    writeFile(path.join(workspace, "attention.md"), "Current attention.\n", "utf8"),
  ]);
  return workspace;
}

function unavailableWorkingMemory(): NmemWorkingMemoryReader {
  return {
    read: async () => ({
      status: "unavailable",
      source: "nmem",
      failedAt: "2026-07-21T12:05:00.000Z",
      reason: "not_configured",
    }),
    close: () => undefined,
  };
}

function baselineReadResponses(root?: string) {
  return [
    "facts.json",
    "identity.md",
    "memory.md",
    "behavior/interaction.md",
    "behavior/background.md",
    "attention.md",
  ].map((file, index) => fauxAssistantMessage(
    fauxToolCall("read", { path: root ? path.join(root, file) : file }, { id: `read-required-${index}` }),
    { stopReason: "toolUse" },
  ));
}

function longMemory(): string {
  return Array.from({ length: 2105 }, (_, index) => `Memory line ${index + 1}`).join("\n");
}

function userPrompt(messages: Array<{ role: string; content: unknown }>): string {
  const message = messages.find(candidate => candidate.role === "user");
  assert.ok(message && Array.isArray(message.content));
  return message.content
    .flatMap(block => block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block
      ? [String(block.text)]
      : [])
    .join("\n");
}

async function createTestPi(root: string, provider: string) {
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(root, "config", "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(root, "config", "models-store.json"),
    allowModelNetwork: false,
  });
  const faux = createFauxCore({ provider, api: provider });
  modelRuntime.registerProvider(provider, {
    name: provider,
    api: faux.api,
    apiKey: "test-key",
    baseUrl: "http://localhost:0",
    streamSimple: faux.streamSimple,
    models: faux.models.map(model => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  });
  const model = modelRuntime.getModel(provider, faux.getModel().id);
  assert.ok(model);
  return { faux, model, modelRuntime };
}
