import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { createPiLifeRecorder } from "../../src/agents/life-recorder.js";
import { createMainAgentActivityLifecycle } from "../../src/main-agent/activity.js";
import { createPiAgentExecution } from "../../src/main-agent/pi-execution.js";
import { openRuntime } from "../../src/runtime/index.js";
import { AgentWorkspace } from "../../src/workspace/agent-workspace.js";

test("closes interaction Activity while the successor continues and Recorder catches up", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-activity-closure-"));
  const workspaceRoot = await createWorkspace(root);
  const workspace = new AgentWorkspace(workspaceRoot);
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(root, "config", "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(root, "config", "models-store.json"),
    allowModelNetwork: false,
  });
  const main = registerFaux(modelRuntime, "activity-main");
  const recorder = registerFaux(modelRuntime, "activity-recorder");
  main.faux.setResponses([
    fauxAssistantMessage("I kept the first activity distinct."),
    context => {
      const messages = JSON.stringify(context.messages);
      assert.match(messages, /<recent_activity>/);
      assert.match(messages, /first activity/);
      assert.match(messages, /past activity evidence.*not a new request/);
      return fauxAssistantMessage("I can continue from that activity.");
    },
  ]);
  recorder.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("read_activity", { offset: 0 }, { id: "read-activity" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("write_daily", {
        content: "# 2026-07-19\n\n## 10:00-10:05\nAlex and Rowan completed the first activity.\n",
      }, { id: "write-daily" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Recorded the first activity."),
  ]);

  const transcriptFile = path.join(root, "transcripts", "agent.jsonl");
  const execution = await createPiAgentExecution({
    agentWorkspace: workspace,
    agentDir: path.join(root, "main-agent"),
    transcriptFile,
    modelRuntime,
    model: main.model,
    harnessSystemPrompt: "Act as one continuing Agent Individual.",
  });
  const lifeRecorder = await createPiLifeRecorder({
    agentWorkspace: workspace,
    agentDir: path.join(root, "life-recorder-agent"),
    transcriptDirectory: path.join(root, "transcripts", "life-recorder"),
    modelRuntime,
    model: recorder.model,
    nextRunId: () => "recorder-run-1",
    now: () => new Date("2026-07-19T10:06:00.000Z"),
  });
  let now = new Date("2026-07-19T10:00:00.000Z");
  const runtime = openRuntime({
    root: path.join(root, "runtime"),
    execution,
    activityLifecycle: createMainAgentActivityLifecycle({
      transcriptFile,
      nextWindowId: () => "successor-window",
    }),
    activityRecorder: lifeRecorder,
    now: () => now,
  });
  t.after(() => {
    runtime.close();
    execution.close();
  });

  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "input-1",
    kind: "interaction",
    payload: { text: "first activity" },
    occurredAt: "2026-07-19T10:00:00.000Z",
  });
  assert.deepEqual(await runtime.advance(), { disposition: "turn_completed" });
  now = new Date("2026-07-19T10:05:00.000Z");
  const closed = await runtime.closeActivity();
  assert.equal(closed.disposition, "activity_frozen");

  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "input-2",
    kind: "interaction",
    payload: { text: "second activity" },
    occurredAt: "2026-07-19T10:05:30.000Z",
  });
  assert.deepEqual(await runtime.advance(), { disposition: "turn_completed" });
  assert.equal(runtime.status().activities[0]?.status, "pending");

  assert.deepEqual(await runtime.advance(), { disposition: "activity_recorded" });
  assert.equal(runtime.status().activities[0]?.status, "recorded");
  assert.match(
    await readFile(path.join(workspaceRoot, "daily", "2026-07-19.md"), "utf8"),
    /completed the first activity/,
  );
});

async function createWorkspace(root: string): Promise<string> {
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "behavior"), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "identity.md"), "Rowan is an Agent Individual.", "utf8"),
    writeFile(path.join(workspace, "memory.md"), "Rowan has ongoing continuity.", "utf8"),
    writeFile(path.join(workspace, "behavior", "interaction.md"), "Respond naturally.", "utf8"),
    writeFile(path.join(workspace, "behavior", "background.md"), "Explore with care.", "utf8"),
    writeFile(path.join(workspace, "attention.md"), "Current attention is open.", "utf8"),
    writeFile(path.join(workspace, "facts.json"), JSON.stringify({
      version: 1,
      individual: { name: "Rowan", languages: ["en"] },
      human: { name: "Alex", languages: ["en"] },
    }), "utf8"),
  ]);
  return workspace;
}

function registerFaux(modelRuntime: ModelRuntime, provider: string) {
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
  return { faux, model };
}
