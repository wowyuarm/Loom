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
    "behavior/interactivity.md",
    "behavior/proactivity.md",
    "attention.md",
  ];
  faux.setResponses([
    context => {
      assert.match(context.systemPrompt ?? "", /"name": "Rowan"/);
      assert.match(context.systemPrompt ?? "", /"name": "Alex"/);
      assert.match(context.systemPrompt ?? "", /memory\.md is first the short core that is present on every Main Agent Turn/);
      assert.match(context.systemPrompt ?? "", /lasting understanding the Individual should naturally carry without deciding to look anything up/);
      assert.match(context.systemPrompt ?? "", /must not become merely a directory of links/);
      assert.match(context.systemPrompt ?? "", /Only after serving that always-carried core/);
      assert.match(context.systemPrompt ?? "", /Memory and Threads are parallel forms of continuity/);
      assert.match(context.systemPrompt ?? "", /Threads and other private material show the Individual's own continuing relationships/);
      assert.match(context.systemPrompt ?? "", /read that Thread's current entry and only the notes needed/);
      assert.match(context.systemPrompt ?? "", /produced an understanding that will still matter after the current line changes or goes quiet/);
      assert.match(context.systemPrompt ?? "", /lasting understanding itself, not a themed archive of source material/);
      assert.match(context.systemPrompt ?? "", /Do not organize a unit as a dated sequence of events/);
      assert.match(context.systemPrompt ?? "", /This does not require abstracting away every lived scene/);
      assert.match(context.systemPrompt ?? "", /lose the relationship's texture/);
      assert.match(context.systemPrompt ?? "", /Remove repeated examples that only prove the same conclusion/);
      assert.match(context.systemPrompt ?? "", /if the draft is mainly a chronology or list of examples/);
      assert.match(context.systemPrompt ?? "", /naturally carry it into every Turn without choosing to retrieve anything/);
      assert.match(context.systemPrompt ?? "", /keep a concise form in memory\.md even when a richer unit exists/);
      assert.match(context.systemPrompt ?? "", /When memory\.md is at least about 16 KiB/);
      assert.match(context.systemPrompt ?? "", /absence of a memory\/ directory is not evidence/);
      assert.match(context.systemPrompt ?? "", /Do not promote maintenance, migration, deployment, validation, or tool-setup history directly into memory\.md/);
      assert.match(context.systemPrompt ?? "", /may become a Memory unit organized around what is now understood/);
      assert.match(context.systemPrompt ?? "", /Keep an unfolding timeline, receipts, file lists, and completion evidence in Daily or the relevant Thread note/);
      assert.match(context.systemPrompt ?? "", /whole-document selection, not append-only accumulation/);
      assert.match(context.systemPrompt ?? "", /Write prose that can be understood on one reading/);
      assert.deepEqual((context.tools ?? []).map(tool => tool.name).sort(), [
        "delete_memory_entry",
        "finish",
        "grep",
        "ls",
        "nmem_recall",
        "read",
        "read_nmem_working_memory",
        "read_reflection_activity",
        "replace_core_material",
        "write_memory_entry",
      ]);
      const prompt = userPrompt(context.messages);
      assert.match(prompt, /Activity ID: segment-reflection-1/);
      assert.match(prompt, /daily\/2026-07-21\.md/);
      assert.match(prompt, /episodes\/2026-07-21\//);
      assert.match(prompt, /Current memory\.md size: \d+ bytes \(no size-triggered review; size is a signal, not a correctness limit\)/);
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
    fauxAssistantMessage(fauxToolCall("finish", {}, { id: "finish" }), { stopReason: "toolUse" }),
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
  assert.deepEqual(await reflector.reflect({
    reflectionDay: "2026-07-21",
    observedAt: "2026-07-21T12:05:00.000Z",
    localTime: "2026-07-21 20:05 UTC+08:00",
    activities: [activity()],
  }), result);
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
    fauxAssistantMessage(fauxToolCall("finish", {}, { id: "finish" }), { stopReason: "toolUse" }),
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
    fauxAssistantMessage(fauxToolCall("finish", {}, { id: "finish" }), { stopReason: "toolUse" }),
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
    fauxAssistantMessage(fauxToolCall("finish", {}, { id: "finish" }), { stopReason: "toolUse" }),
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

test("commits grounded replacements regardless of final model wording", async () => {
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
        content: "A grounded replacement that must be kept.\n",
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
    fauxAssistantMessage(fauxToolCall("finish", {}, { id: "finish" }), { stopReason: "toolUse" }),
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

  const result = await reflector.reflect({
    reflectionDay: "2026-07-21",
    observedAt: "2026-07-21T12:05:00.000Z",
    localTime: "2026-07-21 20:05 UTC+08:00",
    activities: [activity()],
  });

  assert.equal(result.outcome, "updated");
  assert.equal(await readFile(path.join(workspaceRoot, "memory.md"), "utf8"), "A grounded replacement that must be kept.\n");
  assert.equal(await readFile(path.join(workspaceRoot, "facts.json"), "utf8"), originalFacts);
});

test("rejects an early finish and gathers supporting evidence in the same session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-ungrounded-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector-ungrounded");
  faux.setResponses([
    ...baselineReadResponses(),
    fauxAssistantMessage(fauxToolCall("finish", {}, { id: "finish-too-early" }), { stopReason: "toolUse" }),
    context => {
      assert.match(JSON.stringify(context.messages), /supporting evidence/);
      return fauxAssistantMessage(fauxToolCall("ls", { path: "." }, { id: "list-supporting" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("finish", {}, { id: "finish-corrected" }), { stopReason: "toolUse" }),
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

  assert.equal((await reflector.reflect({
      reflectionDay: "2026-07-21",
      observedAt: "2026-07-21T12:05:00.000Z",
      localTime: "2026-07-21 20:05 UTC+08:00",
      activities: [],
    })).outcome, "no_change");
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
    fauxAssistantMessage(fauxToolCall("finish", {}, { id: "finish" }), { stopReason: "toolUse" }),
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

test("rejects a write after a truncated baseline and accepts it after the remaining page", async () => {
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
    context => {
      assert.match(JSON.stringify(context.messages), /must read every core baseline: memory\.md/);
      return fauxAssistantMessage(
        fauxToolCall("read", { path: "memory.md", offset: 2001 }, { id: "read-memory-tail-after-rejection" }),
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage(
      fauxToolCall("replace_core_material", {
        material: "long_term_memory",
        content: "This replacement is now grounded in the complete old material.\n",
      }, { id: "replace-memory-corrected" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxToolCall("finish", {}, { id: "finish-corrected" }), { stopReason: "toolUse" }),
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

  assert.equal((await reflector.reflect({
      reflectionDay: "2026-07-21",
      observedAt: "2026-07-21T12:05:00.000Z",
      localTime: "2026-07-21 20:05 UTC+08:00",
      activities: [activity()],
    })).outcome, "updated");
  assert.equal(
    await readFile(path.join(workspaceRoot, "memory.md"), "utf8"),
    "This replacement is now grounded in the complete old material.\n",
  );
});

test("accepts a long core material after every consecutive page is read", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-paged-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  await writeFile(path.join(workspaceRoot, "memory.md"), longMemory(), "utf8");
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector-paged");
  const baselineReads = baselineReadResponses();
  faux.setResponses([
    context => {
      assert.match(userPrompt(context.messages), /Current memory\.md size: \d+ bytes \(active layering review required; size is a signal, not a correctness limit\)/);
      return baselineReads[0]!;
    },
    ...baselineReads.slice(1, 3),
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
    fauxAssistantMessage(fauxToolCall("finish", {}, { id: "finish" }), { stopReason: "toolUse" }),
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
    fauxAssistantMessage(fauxToolCall("finish", {}, { id: "finish-nmem" }), { stopReason: "toolUse" }),
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
      ["interactivity_behavior", "Meet Alex with care and independent judgment.\n"],
      ["proactivity_behavior", "Follow genuine curiosity without requiring output or contact.\n"],
    ].map(([material, content], index) => fauxAssistantMessage(
      fauxToolCall("replace_core_material", { material, content }, { id: `replace-${index}` }),
      { stopReason: "toolUse" },
    )),
    fauxAssistantMessage(fauxToolCall("finish", {}, { id: "finish-multi" }), { stopReason: "toolUse" }),
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
    "interactivity_behavior",
    "proactivity_behavior",
  ]);
  assert.equal(await readFile(path.join(workspaceRoot, "facts.json"), "utf8"), newFacts);
  assert.match(await readFile(path.join(workspaceRoot, "identity.md"), "utf8"), /independent/);
  assert.match(await readFile(path.join(workspaceRoot, "behavior", "interactivity.md"), "utf8"), /care/);
  assert.match(await readFile(path.join(workspaceRoot, "behavior", "proactivity.md"), "utf8"), /genuine curiosity/);
});

test("derives an update from durable replacements instead of final model wording", async () => {
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
        content: "This grounded replacement survives natural final wording.\n",
      }, { id: "replace-memory" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxToolCall("finish", {}, { id: "finish-wording" }), { stopReason: "toolUse" }),
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

  assert.equal((await reflector.reflect({
    reflectionDay: "2026-07-21",
    observedAt: "2026-07-21T12:05:00.000Z",
    localTime: "2026-07-21 20:05 UTC+08:00",
    activities: [activity()],
  })).outcome, "updated");
  assert.equal(
    await readFile(path.join(workspaceRoot, "memory.md"), "utf8"),
    "This grounded replacement survives natural final wording.\n",
  );
});

test("omits nmem tools and guidance when the Integration is not enabled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-local-only-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector-local-only");
  faux.setResponses([
    context => {
      assert.doesNotMatch(context.systemPrompt ?? "", /nmem/i);
      assert.doesNotMatch(userPrompt(context.messages), /nmem/i);
      assert.deepEqual((context.tools ?? []).map(tool => tool.name).sort(), [
        "delete_memory_entry",
        "finish",
        "grep",
        "ls",
        "read",
        "read_reflection_activity",
        "replace_core_material",
        "write_memory_entry",
      ]);
      return baselineReadResponses()[0]!;
    },
    ...baselineReadResponses().slice(1),
    fauxAssistantMessage(
      fauxToolCall("read_reflection_activity", {
        activityId: "segment-reflection-1",
        offset: 0,
      }, { id: "read-activity" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxToolCall("finish", {}, { id: "finish-omitted" }), { stopReason: "toolUse" }),
  ]);
  const reflector = await createPiMemoryReflector({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    backupDirectory: path.join(root, "backups"),
    modelRuntime,
    model,
  });

  const result = await reflector.reflect({
    reflectionDay: "2026-07-21",
    observedAt: "2026-07-21T12:05:00.000Z",
    localTime: "2026-07-21 20:05 UTC+08:00",
    activities: [activity()],
  });

  assert.equal(result.outcome, "no_change");
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
    writeFile(path.join(workspace, "behavior", "interactivity.md"), "Meet direct interaction honestly.\n", "utf8"),
    writeFile(path.join(workspace, "behavior", "proactivity.md"), "Private time may remain private.\n", "utf8"),
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
    "behavior/interactivity.md",
    "behavior/proactivity.md",
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

test("writes a layered memory entry after reading it completely", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-entry-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  await mkdir(path.join(workspaceRoot, "memory"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "memory", "greenhouse.md"), "Old greenhouse notes.\n", "utf8");
  await writeFile(path.join(workspaceRoot, "memory.md"), "Previous long-term memory.\n\n- [Greenhouse](memory/greenhouse.md): durable greenhouse understanding.\n", "utf8");
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector-entry");
  faux.setResponses([
    ...baselineReadResponses(),
    fauxAssistantMessage(
      fauxToolCall("read", { path: "memory/greenhouse.md" }, { id: "read-entry" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("write_memory_entry", {
        path: "memory/greenhouse.md",
        content: "Greenhouse: humidity sensor logs stay in threads/greenhouse/; current working theory is moisture condensation.\n",
      }, { id: "write-entry" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxToolCall("finish", {}, { id: "finish" }), { stopReason: "toolUse" }),
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
    nextRunId: () => "reflector-run-entry",
  });

  const result = await reflector.reflect({
    reflectionDay: "2026-07-21",
    observedAt: "2026-07-21T12:05:00.000Z",
    localTime: "2026-07-21 20:05 UTC+08:00",
    activities: [activity()],
  });

  assert.deepEqual(result, {
    outcome: "updated",
    runId: "reflector-run-entry",
    changedMaterials: [],
    changedMemoryFiles: ["memory/greenhouse.md"],
  });
  assert.match(
    await readFile(path.join(workspaceRoot, "memory", "greenhouse.md"), "utf8"),
    /moisture condensation/,
  );
});

test("creates a new layered memory entry only with a complete memory.md index update", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-entry-create-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector-entry-create");
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
      fauxToolCall("read", { path: "memory/relationship.md" }, { id: "establish-missing-entry" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("write_memory_entry", {
        path: "memory/relationship.md",
        content: "Alex values Rowan's own judgment, including disagreement that stays specific.\n",
      }, { id: "write-new-entry" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("replace_core_material", {
        material: "long_term_memory",
        content: "Rowan can disagree without treating disagreement as distance.\n\n## Detailed memory\n- [Relationship with Alex](memory/relationship.md): how disagreement and trust changed together.\n",
      }, { id: "index-new-entry" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxToolCall("finish", {}, { id: "finish" }), { stopReason: "toolUse" }),
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
    nextRunId: () => "reflector-run-entry-create",
  });

  assert.deepEqual(await reflector.reflect({
    reflectionDay: "2026-07-21",
    observedAt: "2026-07-21T12:05:00.000Z",
    localTime: "2026-07-21 20:05 UTC+08:00",
    activities: [activity()],
  }), {
    outcome: "updated",
    runId: "reflector-run-entry-create",
    changedMaterials: ["long_term_memory"],
    changedMemoryFiles: ["memory/relationship.md"],
  });
  assert.match(await readFile(path.join(workspaceRoot, "memory.md"), "utf8"), /memory\/relationship\.md/);
  assert.match(await readFile(path.join(workspaceRoot, "memory", "relationship.md"), "utf8"), /own judgment/);
});

test("refuses to write a layered memory entry that was not read completely", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-unread-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  await mkdir(path.join(workspaceRoot, "memory"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "memory", "greenhouse.md"), "Old greenhouse notes.\n", "utf8");
  await writeFile(path.join(workspaceRoot, "memory.md"), "Previous long-term memory.\n\n- [Greenhouse](memory/greenhouse.md): durable greenhouse understanding.\n", "utf8");
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector-unread");
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
      fauxToolCall("write_memory_entry", {
        path: "memory/greenhouse.md",
        content: "Written without reading first.\n",
      }, { id: "write-unread" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxToolCall("finish", {}, { id: "finish" }), { stopReason: "toolUse" }),
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
    nextRunId: () => "reflector-run-unread",
  });

  const result = await reflector.reflect({
    reflectionDay: "2026-07-21",
    observedAt: "2026-07-21T12:05:00.000Z",
    localTime: "2026-07-21 20:05 UTC+08:00",
    activities: [activity()],
  });

  assert.equal(result.outcome, "no_change");
  assert.equal(
    await readFile(path.join(workspaceRoot, "memory", "greenhouse.md"), "utf8"),
    "Old greenhouse notes.\n",
  );
});

test("deletes a layered memory entry after reading it completely", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-delete-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  await mkdir(path.join(workspaceRoot, "memory"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "memory", "merged.md"), "Now folded into memory.md.\n", "utf8");
  await writeFile(path.join(workspaceRoot, "memory.md"), "Previous long-term memory.\n\n- [Merged](memory/merged.md): older detail.\n", "utf8");
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector-delete");
  faux.setResponses([
    ...baselineReadResponses(),
    fauxAssistantMessage(
      fauxToolCall("read", { path: "memory/merged.md" }, { id: "read-merged" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("delete_memory_entry", { path: "memory/merged.md" }, { id: "delete-merged" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("replace_core_material", {
        material: "long_term_memory",
        content: "Previous long-term memory. The useful part of the merged entry is now included here.\n",
      }, { id: "replace-memory-index" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxToolCall("finish", {}, { id: "finish" }), { stopReason: "toolUse" }),
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
    nextRunId: () => "reflector-run-delete",
  });

  const result = await reflector.reflect({
    reflectionDay: "2026-07-21",
    observedAt: "2026-07-21T12:05:00.000Z",
    localTime: "2026-07-21 20:05 UTC+08:00",
    activities: [activity()],
  });

  assert.deepEqual(result, {
    outcome: "updated",
    runId: "reflector-run-delete",
    changedMaterials: ["long_term_memory"],
    changedMemoryFiles: ["memory/merged.md"],
  });
  await assert.rejects(
    readFile(path.join(workspaceRoot, "memory", "merged.md")),
    /ENOENT/,
  );
});

test("rejects memory entry paths outside the single-level memory/ shape", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-memory-reflector-path-"));
  const workspaceRoot = await createReflectorWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "memory-reflector-path");
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
      fauxToolCall("write_memory_entry", {
        path: "memory/../identity.md",
        content: "attempted escape\n",
      }, { id: "write-escape" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxToolCall("finish", {}, { id: "finish" }), { stopReason: "toolUse" }),
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
    nextRunId: () => "reflector-run-path",
  });

  const result = await reflector.reflect({
    reflectionDay: "2026-07-21",
    observedAt: "2026-07-21T12:05:00.000Z",
    localTime: "2026-07-21 20:05 UTC+08:00",
    activities: [activity()],
  });

  assert.equal(result.outcome, "no_change");
  assert.equal(
    await readFile(path.join(workspaceRoot, "identity.md"), "utf8"),
    "Rowan is a continuing Agent Individual.\n",
  );
});
