import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { createPiOrientation } from "../../src/agents/orientation.js";
import type { FrozenActivity } from "../../src/runtime/index.js";
import { AgentWorkspace } from "../../src/workspace/agent-workspace.js";

test("forms a grounded Opportunity through an isolated Orientation run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-orientation-"));
  const workspaceRoot = await createWorkspace(root);
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(root, "config", "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(root, "config", "models-store.json"),
    allowModelNetwork: false,
  });
  const provider = registerFaux(modelRuntime, "orientation");
  const activity = frozenActivity();
  provider.faux.setResponses([
    context => {
      assert.deepEqual(context.tools?.map(tool => tool.name).sort(), ["grep", "ls", "read", "read_recent_activity"]);
      assert.match(context.systemPrompt ?? "", /"name": "Rowan"/);
      const messages = JSON.stringify(context.messages);
      assert.match(messages, /activity-recent/);
      assert.match(messages, /attention\.md/);
      assert.match(messages, /continue-private-work/);
      assert.doesNotMatch(messages, /private result body/);
      return fauxAssistantMessage(
        fauxToolCall("read_recent_activity", {
          activityId: "activity-recent",
          offset: 0,
          limit: 1,
        }, { id: "read-recent" }),
        { stopReason: "toolUse" },
      );
    },
    context => {
      assert.match(JSON.stringify(context.messages), /private result body/);
      return fauxAssistantMessage(JSON.stringify({
        outcome: "opportunity",
        narrative: "The unfinished private work has a concrete place to continue.",
        whyNow: "The latest activity stopped after finding the next input.",
        evidence: ["activity-recent contains the completed lookup"],
      }));
    },
  ]);

  const orientation = await createPiOrientation({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "orientation-agent"),
    transcriptDirectory: path.join(root, "transcripts", "orientation"),
    modelRuntime,
    model: provider.model,
    loadActionSpace: async () => ({
      skills: [{ name: "continue-private-work", description: "Continue an existing private line." }],
      mainAgentTools: ["read", "edit", "message"],
      evidenceSources: [],
    }),
    nextRunId: () => "orientation-run-1",
  });

  assert.deepEqual(await orientation.form({
    observedAt: "2026-07-20T06:30:00.000Z",
    localTime: "2026-07-20 14:30 +08:00",
    lastHumanInputAt: "2026-07-20T04:12:00.000Z",
    recentActivities: [activity],
  }), {
    outcome: "opportunity",
    runId: "orientation-run-1",
    narrative: "The unfinished private work has a concrete place to continue.",
    whyNow: "The latest activity stopped after finding the next input.",
    evidence: ["activity-recent contains the completed lookup"],
  });
});

function frozenActivity(): FrozenActivity {
  return {
    version: 1,
    segmentId: "activity-recent",
    recordingDay: "2026-07-20",
    openedAt: "2026-07-20T05:00:00.000Z",
    closedAt: "2026-07-20T05:10:00.000Z",
    events: [{
      eventId: "event-tool-result",
      turnId: "turn-recent",
      at: "2026-07-20T05:08:00.000Z",
      actorRef: "system",
      kind: "tool_result",
      content: { text: "private result body" },
    }],
    turns: [{
      turnId: "turn-recent",
      startedAt: "2026-07-20T05:00:00.000Z",
      endedAt: "2026-07-20T05:10:00.000Z",
      status: "completed",
    }],
  };
}

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
    }, null, 2), "utf8"),
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
