import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

import { createPiLifeRecorder } from "../../src/agents/life-recorder.js";
import type { FrozenActivity } from "../../src/runtime/index.js";
import { AgentWorkspace } from "../../src/workspace/agent-workspace.js";

test("grounds a recorder run and writes protected Daily and Episode records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-life-recorder-"));
  const workspaceRoot = await createRecorderWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "life-recorder");
  faux.setResponses([
    context => {
      assert.match(context.systemPrompt ?? "", /"name": "Rowan"/);
      assert.match(context.systemPrompt ?? "", /"name": "Alex"/);
      assert.deepEqual((context.tools ?? []).map(tool => tool.name).sort(), [
        "grep",
        "ls",
        "read",
        "read_activity",
        "record_episode",
        "write_daily",
      ]);
      const prompt = userPrompt(context.messages);
      assert.match(prompt, /daily\/2026-07-19\.md/);
      assert.doesNotMatch(prompt, /asked Rowan to keep the exact attribution/);
      return fauxAssistantMessage(
        fauxToolCall("read_activity", { offset: 0, limit: 20 }, { id: "read-activity" }),
        { stopReason: "toolUse" },
      );
    },
    context => {
      const messages = JSON.stringify(context.messages);
      assert.match(messages, /asked Rowan to keep the exact attribution/);
      assert.match(messages, /"actorRef":"human"/);
      return fauxAssistantMessage(fauxToolCall("write_daily", {
        content: "# 2026-07-19\n\n## 10:00-10:04\nAlex asked Rowan to preserve exact attribution.\n",
      }, { id: "write-daily" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("record_episode", {
      ordinal: 0,
      title: "Alex asked for exact attribution",
      occurredAt: "2026-07-19T10:00:00.000Z",
      importance: 0.82,
      labels: ["calibration"],
      scene: "Alex asked Rowan to keep their actions distinct in future memory.",
      evidenceEventIds: ["event-input-1"],
    }, { id: "record-episode" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Recorded the activity."),
  ]);
  const recorder = await createPiLifeRecorder({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    modelRuntime,
    model,
    nextRunId: () => "run-1",
    now: () => new Date("2026-07-19T10:05:00.000Z"),
  });

  const receipt = await recorder.record(activity());

  assert.deepEqual(receipt, {
    version: 1,
    segmentId: "segment-1",
    runId: "run-1",
    recordedAt: "2026-07-19T10:05:00.000Z",
    daily: { status: "updated", path: "daily/2026-07-19.md" },
    episodes: [{
      id: receipt.episodes[0]?.id,
      path: receipt.episodes[0]?.path,
    }],
  });
  assert.match(await readFile(path.join(workspaceRoot, receipt.daily.path), "utf8"), /Alex asked Rowan/);
  assert.match(await readFile(path.join(workspaceRoot, receipt.episodes[0]!.path), "utf8"), /segment-1/);
  assert.match(await readFile(path.join(workspaceRoot, receipt.episodes[0]!.path), "utf8"), /event-input-1/);
});

test("allows no change when Daily and Episodes do not exist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-life-recorder-missing-"));
  const workspaceRoot = await createRecorderWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "life-recorder-missing");
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("read_activity", { offset: 0 }, { id: "read-activity" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("No durable narrative change."),
  ]);
  const recorder = await createPiLifeRecorder({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    modelRuntime,
    model,
    nextRunId: () => "run-missing",
    now: () => new Date("2026-07-19T10:05:00.000Z"),
  });

  const receipt = await recorder.record(activity());

  assert.equal(receipt.daily.status, "no_change");
  assert.deepEqual(receipt.episodes, []);
  await assert.rejects(access(path.join(workspaceRoot, "daily", "2026-07-19.md")));
  await assert.rejects(access(path.join(workspaceRoot, "episodes")));
});

test("requires stable facts before calling the recorder model", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-life-recorder-facts-"));
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const { model, modelRuntime } = await createTestPi(root, "life-recorder-identity");
  const recorder = await createPiLifeRecorder({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    modelRuntime,
    model,
  });

  await assert.rejects(recorder.record(activity()), {
    name: "AgentWorkspaceMaterialError",
    message: "Required Agent Workspace material facts.json is missing",
  });
});

test("confines recorder file reads to the Agent Workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-life-recorder-read-boundary-"));
  const workspaceRoot = await createRecorderWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "life-recorder-read-boundary");
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("read_activity", { offset: 0 }, { id: "read-activity" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("read", { path: "/etc/hosts" }, { id: "read-outside" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("The outside read was refused."),
  ]);
  const recorder = await createPiLifeRecorder({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    modelRuntime,
    model,
  });

  await assert.rejects(
    recorder.record(activity()),
    /Life Recorder tool read failed:.*Agent Workspace/i,
  );
});

test("refuses a receipt when the recorder did not read every frozen event", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-life-recorder-partial-"));
  const workspaceRoot = await createRecorderWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "life-recorder-partial");
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("read_activity", { offset: 0, limit: 1 }, { id: "read-first-page" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Stopped before reading the next page."),
  ]);
  const recorder = await createPiLifeRecorder({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    modelRuntime,
    model,
  });
  const frozen = activity();
  frozen.events.push({
    eventId: "event-output-2",
    at: "2026-07-19T10:01:00.000Z",
    actorRef: "individual",
    kind: "output",
    content: { text: "kept the distinction explicit" },
  });

  await assert.rejects(recorder.record(frozen), /did not read all frozen activity events/i);
});

test("rejects an event with an unsupported actor reference before calling the model", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-life-recorder-actor-"));
  const workspaceRoot = await createRecorderWorkspace(root);
  const { model, modelRuntime } = await createTestPi(root, "life-recorder-actor");
  const recorder = await createPiLifeRecorder({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    modelRuntime,
    model,
  });
  const frozen = activity();
  (frozen.events[0] as { actorRef: string }).actorRef = "external:unknown";

  await assert.rejects(recorder.record(frozen), /unsupported actorRef.*external:unknown/i);
});

test("rolls back earlier writes when an episode cites evidence outside the frozen activity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-life-recorder-evidence-"));
  const workspaceRoot = await createRecorderWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "life-recorder-evidence");
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("read_activity", { offset: 0 }, { id: "read-activity" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxToolCall("write_daily", {
      content: "# 2026-07-19\n\nThis write must be rolled back.\n",
    }, { id: "write-daily" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("record_episode", {
      ordinal: 0,
      title: "Temporary supported scene",
      occurredAt: "2026-07-19T10:00:00.000Z",
      importance: 0.8,
      labels: ["calibration"],
      scene: "This supported scene must also be rolled back.",
      evidenceEventIds: ["event-input-1"],
    }, { id: "record-supported-episode" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("record_episode", {
      ordinal: 1,
      title: "Unsupported scene",
      occurredAt: "2026-07-19T10:00:00.000Z",
      importance: 0.8,
      labels: ["calibration"],
      scene: "This scene cites evidence that was not part of the activity.",
      evidenceEventIds: ["event-from-another-segment"],
    }, { id: "record-episode" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Could not record the unsupported scene."),
  ]);
  const recorder = await createPiLifeRecorder({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    modelRuntime,
    model,
  });

  await assert.rejects(
    recorder.record(activity()),
    /eventId outside the frozen evidence.*event-from-another-segment/i,
  );
  await assert.rejects(access(path.join(workspaceRoot, "daily", "2026-07-19.md")));
  assert.deepEqual(await readdir(path.join(workspaceRoot, "episodes", "2026-07-19")), []);
});

test("restores all Workspace files when the provider fails after writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-life-recorder-rollback-"));
  const workspaceRoot = await createRecorderWorkspace(root);
  const dailyPath = path.join(workspaceRoot, "daily", "2026-07-19.md");
  await mkdir(path.dirname(dailyPath), { recursive: true });
  await writeFile(dailyPath, "# 2026-07-19\n\nBefore this recorder run.\n", "utf8");
  const { faux, model, modelRuntime } = await createTestPi(root, "life-recorder-rollback");
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("read_activity", { offset: 0 }, { id: "read-activity" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxToolCall("write_daily", {
      content: "# 2026-07-19\n\nChanged during the failed run.\n",
    }, { id: "write-daily" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("record_episode", {
      ordinal: 0,
      title: "Temporary episode",
      occurredAt: "2026-07-19T10:00:00.000Z",
      importance: 0.8,
      labels: ["calibration"],
      scene: "This should be removed when the run fails.",
      evidenceEventIds: ["event-input-1"],
    }, { id: "record-episode" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Recorder provider failed after writes.", {
      stopReason: "error",
      errorMessage: "provider failed after writes",
    }),
  ]);
  const recorder = await createPiLifeRecorder({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    modelRuntime,
    model,
  });

  await assert.rejects(recorder.record(activity()), /provider failed after writes/i);
  assert.equal(await readFile(dailyPath, "utf8"), "# 2026-07-19\n\nBefore this recorder run.\n");
  assert.deepEqual(await readdir(path.join(workspaceRoot, "episodes", "2026-07-19")), []);
});

test("reuses the episode identity when the same segment ordinal is recorded again", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-life-recorder-stable-"));
  const workspaceRoot = await createRecorderWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "life-recorder-stable");
  const episodeCall = () => fauxAssistantMessage(fauxToolCall("record_episode", {
    ordinal: 0,
    title: "Stable episode",
    occurredAt: "2026-07-19T10:00:00.000Z",
    importance: 0.8,
    labels: ["calibration"],
    scene: "The same frozen activity is retried without creating another identity.",
    evidenceEventIds: ["event-input-1"],
  }, { id: nextToolCallId() }), { stopReason: "toolUse" });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read_activity", { offset: 0 }, { id: "read-first" }), { stopReason: "toolUse" }),
    episodeCall(),
    fauxAssistantMessage("First recording complete."),
    fauxAssistantMessage(fauxToolCall("read_activity", { offset: 0 }, { id: "read-retry" }), { stopReason: "toolUse" }),
    episodeCall(),
    fauxAssistantMessage("Retry recording complete."),
  ]);
  let run = 0;
  const recorder = await createPiLifeRecorder({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    modelRuntime,
    model,
    nextRunId: () => `run-stable-${++run}`,
  });

  const first = await recorder.record(activity());
  const retry = await recorder.record(activity());

  assert.equal(retry.episodes[0]?.id, first.episodes[0]?.id);
  assert.equal(retry.episodes[0]?.path, first.episodes[0]?.path);
  assert.deepEqual(await readdir(path.join(workspaceRoot, "episodes", "2026-07-19")), [
    `${first.episodes[0]!.id}.md`,
  ]);
});

function activity(): FrozenActivity {
  return {
    version: 1 as const,
    segmentId: "segment-1",
    recordingDay: "2026-07-19",
    openedAt: "2026-07-19T10:00:00.000Z",
    closedAt: "2026-07-19T10:04:00.000Z",
    events: [{
      eventId: "event-input-1",
      at: "2026-07-19T10:00:00.000Z",
      actorRef: "human",
      kind: "input" as const,
      content: { text: "asked Rowan to keep the exact attribution" },
    }],
    transcriptAnchors: [{ sessionId: "session-1", entryId: "entry-1" }],
  };
}

async function createRecorderWorkspace(root: string): Promise<string> {
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "facts.json"), JSON.stringify({
    version: 1,
    individual: { name: "Rowan", languages: ["en"] },
    human: { name: "Alex", languages: ["en"] },
    relationship: { roles: ["long-term counterpart"] },
  }, null, 2), "utf8");
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

let toolCallSequence = 0;

function nextToolCallId(): string {
  toolCallSequence += 1;
  return `episode-${toolCallSequence}`;
}
