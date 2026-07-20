import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { createPiAttentionMaintainer } from "../../src/agents/attention-maintainer.js";
import type { FrozenActivity } from "../../src/runtime/index.js";
import { AgentWorkspace } from "../../src/workspace/agent-workspace.js";

test("updates Current Attention from indexed Workspace and Activity evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-attention-maintainer-"));
  const workspaceRoot = await createWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "attention-maintainer");
  faux.setResponses([
    context => {
      assert.deepEqual((context.tools ?? []).map(tool => tool.name).sort(), [
        "grep",
        "ls",
        "read",
        "read_recent_activity",
        "replace_attention",
      ]);
      assert.match(context.systemPrompt ?? "", /"name": "Rowan"/);
      assert.match(context.systemPrompt ?? "", /"name": "Alex"/);
      const prompt = userPrompt(context.messages);
      assert.match(prompt, /attention\.md/);
      assert.match(prompt, /activity-recent/);
      assert.doesNotMatch(prompt, /old attention body/);
      assert.doesNotMatch(prompt, /a disagreement felt safe/);
      return fauxAssistantMessage(
        fauxToolCall("read", { path: "attention.md" }, { id: "read-attention" }),
        { stopReason: "toolUse" },
      );
    },
    context => {
      assert.match(JSON.stringify(context.messages), /old attention body/);
      return fauxAssistantMessage(fauxToolCall("read_recent_activity", {
        activityId: "activity-recent",
        offset: 0,
      }, { id: "read-activity" }), { stopReason: "toolUse" });
    },
    context => {
      assert.match(JSON.stringify(context.messages), /a disagreement felt safe/);
      return fauxAssistantMessage(fauxToolCall("replace_attention", {
        content: "The current line has moved. Disagreement with Alex still feels safe.",
      }, { id: "replace-attention" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("UPDATED"),
  ]);
  const maintainer = await createPiAttentionMaintainer({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    modelRuntime,
    model,
    nextRunId: () => "attention-run-1",
  });

  const result = await maintainer.maintain({
    observedAt: "2026-07-20T08:00:00.000Z",
    localTime: "2026-07-20 16:00 +08:00",
    recentActivities: [frozenActivity()],
  });

  assert.deepEqual(result, {
    outcome: "updated",
    runId: "attention-run-1",
    path: "attention.md",
  });
  assert.equal(
    await readFile(path.join(workspaceRoot, "attention.md"), "utf8"),
    "The current line has moved. Disagreement with Alex still feels safe.\n",
  );
});

test("keeps Current Attention unchanged after grounded inspection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-attention-no-change-"));
  const workspaceRoot = await createWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "attention-no-change");
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("read", { path: "attention.md" }, { id: "read-attention" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("read", { path: "memory.md" }, { id: "read-memory" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("NO_CHANGE"),
  ]);
  const maintainer = await createPiAttentionMaintainer({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    modelRuntime,
    model,
    nextRunId: () => "attention-run-no-change",
  });

  assert.deepEqual(await maintainer.maintain({
    observedAt: "2026-07-20T08:00:00.000Z",
    localTime: "2026-07-20 16:00 +08:00",
    recentActivities: [],
  }), {
    outcome: "no_change",
    runId: "attention-run-no-change",
    path: "attention.md",
  });
  assert.equal(await readFile(path.join(workspaceRoot, "attention.md"), "utf8"), "old attention body\n");
});

test("refuses a decision made without supporting evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-attention-ungrounded-"));
  const workspaceRoot = await createWorkspace(root);
  const { faux, model, modelRuntime } = await createTestPi(root, "attention-ungrounded");
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("read", { path: "attention.md" }, { id: "read-attention" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("NO_CHANGE"),
  ]);
  const maintainer = await createPiAttentionMaintainer({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    modelRuntime,
    model,
  });

  await assert.rejects(maintainer.maintain({
    observedAt: "2026-07-20T08:00:00.000Z",
    localTime: "2026-07-20 16:00 +08:00",
    recentActivities: [],
  }), /inspect supporting evidence/i);
  assert.equal(await readFile(path.join(workspaceRoot, "attention.md"), "utf8"), "old attention body\n");
});

test("restores Current Attention when the provider fails after replacement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-attention-rollback-"));
  const workspaceRoot = await createWorkspace(root);
  const previousAttention = "\nold attention body\n\n";
  await writeFile(path.join(workspaceRoot, "attention.md"), previousAttention, "utf8");
  const { faux, model, modelRuntime } = await createTestPi(root, "attention-rollback");
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("read", { path: "attention.md" }, { id: "read-attention" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("read_recent_activity", { activityId: "activity-recent" }, { id: "read-activity" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("replace_attention", { content: "temporary replacement" }, { id: "replace-attention" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("provider failed after replacement", {
      stopReason: "error",
      errorMessage: "provider failed after replacement",
    }),
  ]);
  const maintainer = await createPiAttentionMaintainer({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    modelRuntime,
    model,
  });

  await assert.rejects(maintainer.maintain({
    observedAt: "2026-07-20T08:00:00.000Z",
    localTime: "2026-07-20 16:00 +08:00",
    recentActivities: [frozenActivity()],
  }), /provider failed after replacement/i);
  assert.equal(await readFile(path.join(workspaceRoot, "attention.md"), "utf8"), previousAttention);
});

function frozenActivity(): FrozenActivity {
  return {
    version: 1,
    segmentId: "activity-recent",
    recordingDay: "2026-07-20",
    openedAt: "2026-07-20T07:00:00.000Z",
    closedAt: "2026-07-20T07:10:00.000Z",
    events: [{
      eventId: "event-human-1",
      at: "2026-07-20T07:04:00.000Z",
      actorRef: "human",
      kind: "input",
      content: { text: "a disagreement felt safe" },
    }],
    transcriptAnchors: [],
  };
}

async function createWorkspace(root: string): Promise<string> {
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "behavior"), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "identity.md"), "Rowan is an Agent Individual.", "utf8"),
    writeFile(path.join(workspace, "memory.md"), "Long-term memory.", "utf8"),
    writeFile(path.join(workspace, "behavior", "interaction.md"), "Interact naturally.", "utf8"),
    writeFile(path.join(workspace, "behavior", "background.md"), "Explore with care.", "utf8"),
    writeFile(path.join(workspace, "attention.md"), "old attention body\n", "utf8"),
    writeFile(path.join(workspace, "facts.json"), JSON.stringify({
      version: 1,
      individual: { name: "Rowan", languages: ["en"] },
      human: { name: "Alex", languages: ["en"] },
    }, null, 2), "utf8"),
  ]);
  return workspace;
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
    models: faux.models.map(candidate => ({
      id: candidate.id,
      name: candidate.name,
      reasoning: candidate.reasoning,
      input: candidate.input,
      cost: candidate.cost,
      contextWindow: candidate.contextWindow,
      maxTokens: candidate.maxTokens,
    })),
  });
  const model = modelRuntime.getModel(provider, faux.getModel().id);
  assert.ok(model);
  return { faux, model, modelRuntime };
}

function userPrompt(messages: unknown[]): string {
  const message = messages.find(candidate => candidate
    && typeof candidate === "object"
    && (candidate as { role?: string }).role === "user") as { content?: unknown } | undefined;
  return JSON.stringify(message?.content ?? "");
}
