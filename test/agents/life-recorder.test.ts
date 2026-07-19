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

import { createPiLifeRecorder, type FrozenActivity } from "../../src/agents/life-recorder.js";
import { AgentWorkspace } from "../../src/workspace/agent-workspace.js";

test("records attributed activity into Daily and a stable Workspace episode", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-life-recorder-"));
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "identity.md"), "# Identity\nName: Rowan\n", "utf8");
  await writeFile(path.join(workspaceRoot, "memory.md"), "Alex is Rowan's long-term counterpart.\n", "utf8");
  const { faux, model, modelRuntime } = await createTestPi(root, "life-recorder");
  faux.setResponses([
    context => {
      assert.match(context.systemPrompt ?? "", /first-hand recorder/i);
      assert.match(context.systemPrompt ?? "", /actorRef/);
      assert.match(context.systemPrompt ?? "", /natural names.*neutral term only/is);
      assert.match(context.systemPrompt ?? "", /ordinals from zero.*chronological episode order/is);
      assert.doesNotMatch(context.systemPrompt ?? "", /Xi|曦|禹|Weixin|Asia\/Shanghai/);
      assert.deepEqual((context.tools ?? []).map(tool => tool.name).sort(), [
        "read_activity",
        "record_episode",
        "write_daily",
      ]);
      const prompt = JSON.stringify(context.messages);
      assert.match(prompt, /Name: Rowan/);
      assert.match(prompt, /Alex is Rowan's long-term counterpart/);
      assert.match(prompt, /external:alex/);
      assert.match(prompt, /Alex/);
      assert.doesNotMatch(prompt, /asked Rowan to keep the exact attribution/);
      return fauxAssistantMessage(
        fauxToolCall("read_activity", { offset: 0, limit: 20 }, { id: "read-activity" }),
        { stopReason: "toolUse" },
      );
    },
    context => {
      const messages = JSON.stringify(context.messages);
      assert.match(messages, /asked Rowan to keep the exact attribution/);
      assert.match(messages, /"actorRef":"external:alex"/);
      return fauxAssistantMessage(fauxToolCall("write_daily", {
        content: "# 2026-07-19\n\n## Summary\nAlex asked Rowan to preserve exact attribution.\n",
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

test("does not block when optional recorder materials do not exist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-life-recorder-missing-"));
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "identity.md"), "# Identity\nName: Rowan\n", "utf8");
  const { faux, model, modelRuntime } = await createTestPi(root, "life-recorder-missing");
  faux.setResponses([
    context => {
      const userMessage = context.messages.find(message => message.role === "user");
      assert.ok(userMessage && Array.isArray(userMessage.content));
      const prompt = userMessage.content
        .flatMap(block => block.type === "text" ? [block.text] : [])
        .join("\n");
      assert.match(prompt, /"longTermMemory":"missing"/);
      assert.match(prompt, /"daily":"missing"/);
      assert.match(prompt, /"episodes":"missing"/);
      return fauxAssistantMessage(
        fauxToolCall("read_activity", { offset: 0 }, { id: "read-activity" }),
        { stopReason: "toolUse" },
      );
    },
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

test("requires Identity before calling the recorder model", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-life-recorder-identity-"));
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
    message: "Required Agent Workspace material identity.md is missing",
  });
});

test("refuses a receipt when the recorder did not read every frozen event", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-life-recorder-partial-"));
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "identity.md"), "# Identity\nName: Rowan\n", "utf8");
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
    actorRef: "self",
    kind: "output",
    content: { text: "kept the distinction explicit" },
  });

  await assert.rejects(recorder.record(frozen), /did not read all frozen activity events/i);
});

test("rejects an event whose actorRef is not declared before calling the model", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-life-recorder-actor-"));
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "identity.md"), "# Identity\nName: Rowan\n", "utf8");
  const { model, modelRuntime } = await createTestPi(root, "life-recorder-actor");
  const recorder = await createPiLifeRecorder({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    modelRuntime,
    model,
  });
  const frozen = activity();
  frozen.events[0]!.actorRef = "external:unknown";

  await assert.rejects(recorder.record(frozen), /unknown actorRef.*external:unknown/i);
});

test("rolls back earlier writes when an episode cites evidence outside the frozen activity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-life-recorder-evidence-"));
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "identity.md"), "# Identity\nName: Rowan\n", "utf8");
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
  const workspaceRoot = path.join(root, "workspace");
  const dailyPath = path.join(workspaceRoot, "daily", "2026-07-19.md");
  await mkdir(path.dirname(dailyPath), { recursive: true });
  await writeFile(path.join(workspaceRoot, "identity.md"), "# Identity\nName: Rowan\n", "utf8");
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

test("rolls back a Daily write when the Pi run is aborted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-life-recorder-aborted-"));
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "identity.md"), "# Identity\nName: Rowan\n", "utf8");
  const { faux, model, modelRuntime } = await createTestPi(root, "life-recorder-aborted");
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("read_activity", { offset: 0 }, { id: "read-activity" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxToolCall("write_daily", {
      content: "# 2026-07-19\n\nThis write must be rolled back.\n",
    }, { id: "write-daily" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Recorder run aborted.", {
      stopReason: "aborted",
      errorMessage: "recorder run aborted",
    }),
  ]);
  const recorder = await createPiLifeRecorder({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    modelRuntime,
    model,
  });

  await assert.rejects(recorder.record(activity()), /recorder run aborted/i);
  await assert.rejects(access(path.join(workspaceRoot, "daily", "2026-07-19.md")));
});

test("reuses the episode identity when the same segment ordinal is recorded again", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-life-recorder-stable-"));
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "identity.md"), "# Identity\nName: Rowan\n", "utf8");
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

test("rejects a tool call that fails parameter validation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-life-recorder-params-"));
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "identity.md"), "# Identity\nName: Rowan\n", "utf8");
  const { faux, model, modelRuntime } = await createTestPi(root, "life-recorder-params");
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("read_activity", { offset: 0 }, { id: "read-activity" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxToolCall("record_episode", {
      ordinal: 0,
      title: "Invalid episode",
      occurredAt: "2026-07-19T10:00:00.000Z",
      importance: 2,
      labels: ["calibration"],
      scene: "This call must not produce an episode.",
      evidenceEventIds: ["event-input-1"],
    }, { id: "record-episode" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Could not record the invalid episode."),
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
    error => error instanceof Error
      && /record_episode/i.test(error.message)
      && /importance/i.test(error.message),
  );
  await assert.rejects(access(path.join(workspaceRoot, "episodes")));
});

function activity(): FrozenActivity {
  return {
    version: 1 as const,
    segmentId: "segment-1",
    recordingDay: "2026-07-19",
    openedAt: "2026-07-19T10:00:00.000Z",
    closedAt: "2026-07-19T10:04:00.000Z",
    actors: [
      { actorRef: "self", kind: "individual" as const },
      {
        actorRef: "external:alex",
        kind: "external" as const,
        observedLabel: "Alex",
        relationshipContext: "long-term counterpart",
      },
    ],
    events: [{
      eventId: "event-input-1",
      at: "2026-07-19T10:00:00.000Z",
      actorRef: "external:alex",
      kind: "input" as const,
      content: { text: "asked Rowan to keep the exact attribution" },
    }],
    transcriptAnchors: [{ sessionId: "session-1", entryId: "entry-1" }],
  };
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
