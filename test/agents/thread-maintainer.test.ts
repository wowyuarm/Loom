import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  createPiThreadMaintainer,
  threadObservationsFromActivity,
} from "../../src/agents/thread-maintainer/index.js";
import type { FrozenActivity, JsonValue } from "../../src/runtime/index.js";
import { AgentWorkspace } from "../../src/workspace/agent-workspace.js";

test("keeps Thread history as references and expands an earlier Turn only on request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-thread-history-"));
  const workspaceRoot = await createWorkspace(root);
  const stateFile = path.join(root, "state", "thread-evidence.json");
  const firstActivity = activity("activity-1", "turn-1", "the first private trace");
  const secondActivity = activity("activity-2", "turn-2", "the current private trace");
  const activities = new Map([
    [firstActivity.segmentId, firstActivity],
    [secondActivity.segmentId, secondActivity],
  ]);

  const firstPi = await createTestPi(root, "thread-history-first");
  firstPi.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "index.md" }, { id: "read-index-1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read", { path: "garden/thread.md" }, { id: "read-thread-1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read_thread_activity", { referenceId: "evidence-activity-1-turn-1-thread-garden", offset: 0 }, { id: "read-current-1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("NO_CHANGE"),
  ]);
  const first = await createPiThreadMaintainer({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent-first"),
    transcriptDirectory: path.join(root, "transcripts-first"),
    stateFile,
    modelRuntime: firstPi.modelRuntime,
    model: firstPi.model,
    loadActivity: async activityId => activities.get(activityId),
    nextRunId: () => "thread-run-1",
    nextThreadRef: () => "thread-garden",
  });

  assert.equal((await first.maintain(request(firstActivity, "turn-1"))).outcome, "no_change");

  const secondPi = await createTestPi(root, "thread-history-second");
  secondPi.faux.setResponses([
    context => {
      assert.deepEqual((context.tools ?? []).map(tool => tool.name).sort(), [
        "grep",
        "list_thread_activity",
        "ls",
        "move_thread_path",
        "read",
        "read_thread_activity",
        "write_thread_file",
      ]);
      assert.match(context.systemPrompt ?? "", /"name": "Rowan"/);
      const prompt = userPrompt(context.messages);
      assert.match(prompt, /thread-garden/);
      assert.match(prompt, /activity-2/);
      assert.match(prompt, /garden\/thread\.md/);
      assert.match(prompt, /Prior linked Turns: 1/);
      assert.doesNotMatch(prompt, /the first private trace/);
      return fauxAssistantMessage(fauxToolCall("read", { path: "index.md" }, { id: "read-index-2" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("read", { path: "garden/thread.md" }, { id: "read-thread-2" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read_thread_activity", { referenceId: "evidence-activity-2-turn-2-thread-garden", offset: 0 }, { id: "read-current-2" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("list_thread_activity", { threadRef: "thread-garden", offset: 0 }, { id: "list-history" }), { stopReason: "toolUse" }),
    context => {
      assert.match(JSON.stringify(context.messages), /evidence-activity-1-turn-1-thread-garden/);
      assert.doesNotMatch(JSON.stringify(context.messages), /the first private trace/);
      return fauxAssistantMessage(fauxToolCall("read_thread_activity", {
        referenceId: "evidence-activity-1-turn-1-thread-garden",
        offset: 0,
      }, { id: "read-history" }), { stopReason: "toolUse" });
    },
    context => {
      assert.match(JSON.stringify(context.messages), /the first private trace/);
      return fauxAssistantMessage("NO_CHANGE");
    },
  ]);
  const second = await createPiThreadMaintainer({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent-second"),
    transcriptDirectory: path.join(root, "transcripts-second"),
    stateFile,
    modelRuntime: secondPi.modelRuntime,
    model: secondPi.model,
    loadActivity: async activityId => activities.get(activityId),
    nextRunId: () => "thread-run-2",
  });

  assert.equal((await second.maintain(request(secondActivity, "turn-2"))).outcome, "no_change");
});

test("preserves a substantive movement as a note and rewrites the Thread entrances together", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-thread-structure-"));
  const workspaceRoot = await createWorkspace(root);
  const current = activity("activity-structure", "turn-structure", "the trial changed the live question");
  const { faux, model, modelRuntime } = await createTestPi(root, "thread-structure");
  faux.setResponses([
    context => {
      assert.deepEqual((context.tools ?? []).map(tool => tool.name).sort(), [
        "grep",
        "list_thread_activity",
        "ls",
        "move_thread_path",
        "read",
        "read_thread_activity",
        "write_thread_file",
      ]);
      return fauxAssistantMessage(fauxToolCall("read", { path: "index.md" }, { id: "read-index" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("read", { path: "garden/thread.md" }, { id: "read-thread" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read_thread_activity", {
      referenceId: "evidence-activity-structure-turn-structure-thread-garden",
      offset: 0,
    }, { id: "read-current" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("write_thread_file", {
      path: "garden/2026-07-21-smaller-trial.md",
      content: "# Smaller trial\n\nThe smaller trial changed the live question.\n",
    }, { id: "write-note" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("write_thread_file", {
      path: "garden/thread.md",
      content: "# Garden\n\nThe line now asks what the smaller trial changes.\n\nSource: 2026-07-21-smaller-trial.md\n",
    }, { id: "write-entry" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("write_thread_file", {
      path: "index.md",
      content: "# Threads\n\n- garden: smaller trial is now the live edge\n",
    }, { id: "write-index" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("UPDATED"),
  ]);
  const maintainer = await createPiThreadMaintainer({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    stateFile: path.join(root, "state", "thread-evidence.json"),
    modelRuntime,
    model,
    loadActivity: async activityId => activityId === current.segmentId ? current : undefined,
    nextRunId: () => "thread-run-structure",
    nextThreadRef: () => "thread-garden",
  });

  const result = await maintainer.maintain(request(current, "turn-structure"));

  assert.deepEqual(result, {
    outcome: "updated",
    runId: "thread-run-structure",
    changedPaths: [
      "garden/2026-07-21-smaller-trial.md",
      "garden/thread.md",
      "index.md",
    ],
  });
  assert.match(
    await readFile(path.join(workspaceRoot, "threads", "garden", "2026-07-21-smaller-trial.md"), "utf8"),
    /changed the live question/,
  );
  assert.match(await readFile(path.join(workspaceRoot, "threads", "garden", "thread.md"), "utf8"), /Source:/);
  assert.match(await readFile(path.join(workspaceRoot, "threads", "index.md"), "utf8"), /smaller trial/);
});

test("restores the complete Thread Workspace when the provider fails after writes and moves", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-thread-rollback-"));
  const workspaceRoot = await createWorkspace(root);
  const current = activity("activity-rollback", "turn-rollback", "the source material must survive");
  const originalIndex = await readFile(path.join(workspaceRoot, "threads", "index.md"), "utf8");
  const originalEntry = await readFile(path.join(workspaceRoot, "threads", "garden", "thread.md"), "utf8");
  const { faux, model, modelRuntime } = await createTestPi(root, "thread-rollback");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "index.md" }, { id: "read-index" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read", { path: "garden/thread.md" }, { id: "read-thread" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read_thread_activity", {
      referenceId: "evidence-activity-rollback-turn-rollback-thread-garden",
      offset: 0,
    }, { id: "read-current" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("write_thread_file", {
      path: "garden/temporary.md",
      content: "temporary source\n",
    }, { id: "write-temporary" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("move_thread_path", {
      source: "garden",
      destination: "archive/garden",
    }, { id: "move-garden" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("provider failed after structural changes", {
      stopReason: "error",
      errorMessage: "provider failed after structural changes",
    }),
  ]);
  const maintainer = await createPiThreadMaintainer({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    stateFile: path.join(root, "state", "thread-evidence.json"),
    modelRuntime,
    model,
    loadActivity: async activityId => activityId === current.segmentId ? current : undefined,
    nextThreadRef: () => "thread-garden",
  });

  await assert.rejects(
    maintainer.maintain(request(current, "turn-rollback")),
    /provider failed after structural changes/i,
  );
  assert.equal(await readFile(path.join(workspaceRoot, "threads", "index.md"), "utf8"), originalIndex);
  assert.equal(await readFile(path.join(workspaceRoot, "threads", "garden", "thread.md"), "utf8"), originalEntry);
  await assert.rejects(access(path.join(workspaceRoot, "threads", "garden", "temporary.md")));
  await assert.rejects(access(path.join(workspaceRoot, "threads", "archive", "garden")));
});

test("keeps the same Thread reference after archive and later activity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-thread-archive-history-"));
  const workspaceRoot = await createWorkspace(root);
  const stateFile = path.join(root, "state", "thread-evidence.json");
  const archivedActivity = activity("activity-archive", "turn-archive", "the line reached a natural end");
  const restoredActivity = activity("activity-restored", "turn-restored", "new evidence returned to the archived line");
  const activities = new Map([
    [archivedActivity.segmentId, archivedActivity],
    [restoredActivity.segmentId, restoredActivity],
  ]);
  const firstPi = await createTestPi(root, "thread-archive-first");
  firstPi.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "index.md" }, { id: "read-index-1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read", { path: "garden/thread.md" }, { id: "read-thread-1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read_thread_activity", {
      referenceId: "evidence-activity-archive-turn-archive-thread-garden",
      offset: 0,
    }, { id: "read-current-1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("move_thread_path", {
      source: "garden",
      destination: "archive/garden",
    }, { id: "archive-thread" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("write_thread_file", {
      path: "index.md",
      content: "# Threads\n\n## Archived\n- archive/garden\n",
    }, { id: "write-index" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("UPDATED"),
  ]);
  const first = await createPiThreadMaintainer({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent-first"),
    transcriptDirectory: path.join(root, "transcripts-first"),
    stateFile,
    modelRuntime: firstPi.modelRuntime,
    model: firstPi.model,
    loadActivity: async activityId => activities.get(activityId),
    nextThreadRef: () => "thread-garden",
  });
  assert.equal((await first.maintain(request(archivedActivity, "turn-archive"))).outcome, "updated");

  const secondPi = await createTestPi(root, "thread-archive-second");
  secondPi.faux.setResponses([
    context => {
      const prompt = userPrompt(context.messages);
      assert.match(prompt, /Thread reference: thread-garden/);
      assert.match(prompt, /Current path: archive\/garden/);
      assert.match(prompt, /Prior linked Turns: 1/);
      return fauxAssistantMessage(fauxToolCall("read", { path: "index.md" }, { id: "read-index-2" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("read", { path: "archive/garden/thread.md" }, { id: "read-thread-2" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read_thread_activity", {
      referenceId: "evidence-activity-restored-turn-restored-thread-garden",
      offset: 0,
    }, { id: "read-current-2" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("NO_CHANGE"),
  ]);
  const second = await createPiThreadMaintainer({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent-second"),
    transcriptDirectory: path.join(root, "transcripts-second"),
    stateFile,
    modelRuntime: secondPi.modelRuntime,
    model: secondPi.model,
    loadActivity: async activityId => activities.get(activityId),
  });
  assert.equal((await second.maintain(request(restoredActivity, "turn-restored", "archive/garden"))).outcome, "no_change");
});

test("refuses a structural decision made from only part of the current Turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-thread-partial-current-"));
  const workspaceRoot = await createWorkspace(root);
  const current = activity("activity-partial", "turn-partial", "first event");
  current.events.push({
    eventId: "activity-partial-output",
    turnId: "turn-partial",
    at: "2026-07-21T01:52:00.000Z",
    actorRef: "individual",
    kind: "output",
    content: { text: "second event changes the meaning" },
  });
  const { faux, model, modelRuntime } = await createTestPi(root, "thread-partial-current");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "index.md" }, { id: "read-index" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read", { path: "garden/thread.md" }, { id: "read-thread" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read_thread_activity", {
      referenceId: "evidence-activity-partial-turn-partial-thread-garden",
      offset: 0,
      limit: 1,
    }, { id: "read-first-page" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("NO_CHANGE"),
  ]);
  const maintainer = await createPiThreadMaintainer({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    stateFile: path.join(root, "state", "thread-evidence.json"),
    modelRuntime,
    model,
    loadActivity: async activityId => activityId === current.segmentId ? current : undefined,
    nextThreadRef: () => "thread-garden",
  });

  await assert.rejects(
    maintainer.maintain(request(current, "turn-partial")),
    /did not read all current Turn evidence/i,
  );
});

test("derives Thread observations only from structured Workspace tool evidence", () => {
  const value = activity("activity-observations", "turn-observations", "continue the line");
  value.events.push(
    toolCall("read-thread", "read", { path: "threads/garden/source.md" }),
    toolCall("write-thread", "write", { path: "threads/garden/thread.md", content: "updated" }),
    toolCall("read-related-thread", "read", { path: "threads/forest/thread.md" }),
    toolCall("read-other", "read", { path: "notes/garden.md" }),
    toolCall("bash-thread", "bash", { command: "touch threads/hidden/thread.md" }),
    toolCall("write-index", "write", { path: "threads/index.md", content: "index" }),
  );

  assert.deepEqual(threadObservationsFromActivity(value, "/instance/workspace"), [
    {
      turnId: "turn-observations",
      threadPath: "forest",
      relation: "observed",
      paths: ["forest/thread.md"],
    },
    {
      turnId: "turn-observations",
      threadPath: "garden",
      relation: "changed",
      paths: ["garden/source.md", "garden/thread.md"],
    },
  ]);

  const observedOnly = activity("activity-observed", "turn-observations", "look again");
  observedOnly.events.push(toolCall("read-only", "read", { path: "threads/garden/thread.md" }));
  assert.deepEqual(threadObservationsFromActivity(observedOnly, "/instance/workspace"), []);

  const transcriptShape = activity("activity-transcript", "turn-observations", "write it down");
  transcriptShape.events.push({
    ...toolCall("transcript-write", "write", { path: "threads/garden/thread.md" }),
    content: {
      type: "toolCall",
      id: "transcript-write",
      name: "write",
      arguments: { path: "threads/garden/thread.md" },
    },
  });
  assert.equal(threadObservationsFromActivity(transcriptShape, "/instance/workspace")[0]?.relation, "changed");
});

function request(activityValue: FrozenActivity, turnId: string, threadPath = "garden") {
  return {
    observedAt: activityValue.closedAt,
    localTime: "2026-07-21 10:00 +08:00",
    activity: activityValue,
    observations: [{
      turnId,
      threadPath,
      relation: "changed" as const,
      paths: [`${threadPath}/thread.md`],
    }],
  };
}

function activity(segmentId: string, turnId: string, text: string): FrozenActivity {
  return {
    version: 1,
    segmentId,
    recordingDay: "2026-07-21",
    openedAt: "2026-07-21T01:50:00.000Z",
    closedAt: "2026-07-21T02:00:00.000Z",
    events: [{
      eventId: `${segmentId}-input`,
      turnId,
      at: "2026-07-21T01:51:00.000Z",
      actorRef: "individual",
      kind: "thinking",
      content: { thinking: text },
    }],
    turns: [{
      turnId,
      startedAt: "2026-07-21T01:50:00.000Z",
      endedAt: "2026-07-21T02:00:00.000Z",
      status: "completed",
    }],
  };
}

function toolCall(eventId: string, toolName: string, args: { [key: string]: JsonValue }) {
  return {
    eventId,
    turnId: "turn-observations",
    at: "2026-07-21T01:55:00.000Z",
    actorRef: "individual" as const,
    kind: "tool_call" as const,
    content: { toolCallId: eventId, toolName, arguments: args },
  };
}

async function createWorkspace(root: string): Promise<string> {
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(path.join(workspaceRoot, "threads", "garden"), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspaceRoot, "facts.json"), JSON.stringify({
      version: 1,
      individual: { name: "Rowan", languages: ["en"] },
      human: { name: "Alex", languages: ["en"] },
    }, null, 2), "utf8"),
    writeFile(path.join(workspaceRoot, "threads", "index.md"), "# Threads\n\n- garden\n", "utf8"),
    writeFile(path.join(workspaceRoot, "threads", "garden", "thread.md"), "# Garden\n\nThe living line.\n", "utf8"),
  ]);
  return workspaceRoot;
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
    authPath: path.join(root, "config", `${provider}-auth.json`),
    modelsPath: null,
    modelsStorePath: path.join(root, "config", `${provider}-models.json`),
    allowModelNetwork: false,
  });
  const faux = createFauxCore({ provider, api: provider });
  modelRuntime.registerProvider(provider, {
    name: provider,
    api: faux.api,
    apiKey: "test-key",
    baseUrl: "http://localhost:0",
    streamSimple: faux.streamSimple,
    models: faux.models,
  });
  const model = modelRuntime.getModel(provider, faux.getModel().id);
  assert.ok(model);
  return { faux, model, modelRuntime };
}
