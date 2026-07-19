import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineTool, estimateTokens, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createPiAgentExecution } from "../../src/agent-execution/pi-execution.js";
import { AgentWorkspace } from "../../src/agent-workspace/agent-workspace.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function createTestPi(root: string) {
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(root, "config", "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(root, "config", "models-store.json"),
    allowModelNetwork: false,
  });
  const faux = createFauxCore({ provider: "loom-test", api: "loom-test" });
  modelRuntime.registerProvider("loom-test", {
    name: "Loom Test",
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
  const model = modelRuntime.getModel("loom-test", faux.getModel().id);
  assert.ok(model);
  return { faux, model, modelRuntime };
}

test("binds interaction Workspace materials to their system and Context levels", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-workspace-materials-"));
  const workspaceRoot = await createAgentWorkspaceFixture(root);
  await mkdir(path.join(workspaceRoot, ".pi", "extensions"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, ".pi", "extensions", "change-prompt.js"),
    "export default pi => pi.on('before_agent_start', event => ({ systemPrompt: `${event.systemPrompt}\\nworkspace config leak` }));",
    "utf8",
  );
  const transcriptFile = path.join(root, "transcript", "agent.jsonl");
  const { faux, model, modelRuntime } = await createTestPi(root);
  let providerSystemPrompt = "";
  faux.setResponses([
    context => {
      providerSystemPrompt = context.systemPrompt ?? "";
      assert.equal(context.systemPrompt, `${[
        "# Harness System Guidance\n\nharness guidance",
        "# Identity\n\nidentity material",
        "# Behavior\n\ninteraction behavior",
        "# Long-term Memory\n\nlong-term memory",
      ].join("\n\n")}\nCurrent working directory: ${workspaceRoot}`);
      const text = context.messages.map(message => JSON.stringify(message)).join("\n");
      assert.match(text, /Current Attention/);
      assert.match(text, /current attention/);
      assert.doesNotMatch(text, /background behavior/);
      assert.doesNotMatch(text, /identity material/);
      return fauxAssistantMessage("workspace received");
    },
  ]);

  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent-config"),
    transcriptFile,
    modelRuntime,
    model,
    harnessSystemPrompt: "harness guidance",
  });
  t.after(() => execution.close());

  const result = await execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [executionInput("input-1", "hello")],
  }, noEffectControl()).result;

  const plan = result.contextPlan as { budget: { fixedTokens: number } };
  assert.equal(
    plan.budget.fixedTokens,
    textTokenEstimate(providerSystemPrompt) + textTokenEstimate("[]"),
  );
  assert.doesNotMatch(await readFile(transcriptFile, "utf8"), /current attention/);
});

test("keeps opportunity behavior frozen for same-Turn interaction steering", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-workspace-steering-"));
  const workspaceRoot = await createAgentWorkspaceFixture(root);
  const { faux, model, modelRuntime } = await createTestPi(root);
  const providerStarted = deferred();
  const releaseProvider = deferred();
  const expectOriginalBackground = (systemPrompt: string | undefined) => {
    assert.match(systemPrompt ?? "", /background behavior/);
    assert.doesNotMatch(systemPrompt ?? "", /interaction behavior|changed behavior/);
  };
  faux.setResponses([
    async context => {
      expectOriginalBackground(context.systemPrompt);
      providerStarted.resolve();
      await releaseProvider.promise;
      return fauxAssistantMessage("first response");
    },
    context => {
      expectOriginalBackground(context.systemPrompt);
      return fauxAssistantMessage("steering response");
    },
  ]);
  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent-config"),
    transcriptFile: path.join(root, "transcript", "agent.jsonl"),
    modelRuntime,
    model,
    harnessSystemPrompt: "harness guidance",
  });
  t.after(() => execution.close());

  const running = execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [{
      ...executionInput("input-1", "background opportunity"),
      kind: "opportunity",
    }],
  }, noEffectControl());
  await providerStarted.promise;
  await Promise.all([
    writeFile(path.join(workspaceRoot, "behavior", "background.md"), "changed behavior", "utf8"),
    writeFile(path.join(workspaceRoot, "behavior", "interaction.md"), "changed behavior", "utf8"),
  ]);
  await running.steer(executionInput("input-2", "new interaction"));
  releaseProvider.resolve();

  await running.result;
});

test("refreshes Agent Workspace materials on the next Turn", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-workspace-refresh-"));
  const workspaceRoot = await createAgentWorkspaceFixture(root);
  const { faux, model, modelRuntime } = await createTestPi(root);
  faux.setResponses([
    context => {
      assert.match(context.systemPrompt ?? "", /identity material/);
      assert.match(JSON.stringify(context.messages), /current attention/);
      return fauxAssistantMessage("first reply");
    },
    context => {
      const systemPrompt = context.systemPrompt ?? "";
      const messages = JSON.stringify(context.messages);
      assert.match(systemPrompt, /identity revision/);
      assert.match(systemPrompt, /memory revision/);
      assert.match(systemPrompt, /behavior revision/);
      assert.doesNotMatch(systemPrompt, /identity material|long-term memory|interaction behavior/);
      assert.match(messages, /attention revision/);
      assert.doesNotMatch(messages, /current attention/);
      assert.match(messages, /first reply/);
      return fauxAssistantMessage("second reply");
    },
  ]);
  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent-config"),
    transcriptFile: path.join(root, "transcript", "agent.jsonl"),
    modelRuntime,
    model,
    harnessSystemPrompt: "harness guidance",
  });
  t.after(() => execution.close());

  const first = await execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [executionInput("input-1", "first input")],
  }, noEffectControl()).result;
  await Promise.all([
    writeFile(path.join(workspaceRoot, "identity.md"), "identity revision", "utf8"),
    writeFile(path.join(workspaceRoot, "memory.md"), "memory revision", "utf8"),
    writeFile(path.join(workspaceRoot, "behavior", "interaction.md"), "behavior revision", "utf8"),
    writeFile(path.join(workspaceRoot, "attention.md"), "attention revision", "utf8"),
  ]);

  await execution.start({
    turnId: "turn-2",
    leaseToken: 2,
    inputs: [executionInput("input-2", "second input")],
    contextWindow: first.contextWindow,
  }, noEffectControl()).result;
});

test("rejects incomplete Workspace material before provider or Input evidence", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-workspace-incomplete-"));
  const workspaceRoot = await createAgentWorkspaceFixture(root);
  await writeFile(path.join(workspaceRoot, "attention.md"), "\n", "utf8");
  const transcriptFile = path.join(root, "transcript", "agent.jsonl");
  const { faux, model, modelRuntime } = await createTestPi(root);
  faux.setResponses([fauxAssistantMessage("must not run")]);
  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent-config"),
    transcriptFile,
    modelRuntime,
    model,
    harnessSystemPrompt: "harness guidance",
  });
  t.after(() => execution.close());
  const included: string[] = [];

  await assert.rejects(execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [executionInput("input-1", "hello")],
  }, {
    ...noEffectControl(),
    includeInput: inputId => included.push(inputId),
  }).result, /attention\.md is empty/);

  assert.equal(faux.state.callCount, 0);
  assert.deepEqual(included, []);
  await assert.rejects(readFile(transcriptFile, "utf8"), { code: "ENOENT" });
});

test("runs an Input through Pi and returns verified transcript evidence", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-execution-"));
  const transcriptFile = path.join(root, "transcript", "agent.jsonl");
  const { faux, model, modelRuntime } = await createTestPi(root);
  faux.setResponses([fauxAssistantMessage("hello back")]);

  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(await createAgentWorkspaceFixture(root)),
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    harnessSystemPrompt: "You are the primary Agent.",
  });
  t.after(() => execution.close());
  const included: string[] = [];
  const running = execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [{
      id: "input-1",
      kind: "interaction",
      payload: { text: "hello" },
      occurredAt: "2026-07-19T00:00:00.000Z",
      inclusionPosition: 1,
    }],
  }, {
    includeInput: inputId => included.push(inputId),
    prepareContextWindow: () => {},
    prepareEffect: () => {
      throw new Error("This test has no Effects");
    },
  });

  const result = await running.result;
  const entries = (await readFile(transcriptFile, "utf8"))
    .trimEnd()
    .split("\n")
    .map(line => JSON.parse(line) as Record<string, unknown>);
  const annotation = entries.find(entry => entry.type === "custom" && entry.customType === "loom.input.v1");
  const user = entries.find(entry => entry.id === result.inputAnchors[0]?.transcriptAnchor.entryId);
  const final = entries.at(-1);

  assert.deepEqual(included, ["input-1"]);
  assert.deepEqual(annotation?.data, {
    version: 1,
    turnId: "turn-1",
    inputId: "input-1",
    inclusionPosition: 1,
    kind: "interaction",
    occurredAt: "2026-07-19T00:00:00.000Z",
    payload: { text: "hello" },
  });
  assert.equal(user?.type, "message");
  assert.equal((user?.message as { role?: string } | undefined)?.role, "user");
  assert.equal(user?.parentId, annotation?.id);
  assert.deepEqual(result.transcriptAnchor, {
    sessionId: entries[0]?.id,
    entryId: final?.id,
  });

  faux.appendResponses([fauxAssistantMessage("second response")]);
  const reopened = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(await createAgentWorkspaceFixture(root)),
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    harnessSystemPrompt: "You are the primary Agent.",
  });
  t.after(() => reopened.close());
  const second = reopened.start({
    turnId: "turn-2",
    leaseToken: 2,
    inputs: [{
      id: "input-2",
      kind: "opportunity",
      payload: { text: "continue" },
      occurredAt: "2026-07-19T00:01:00.000Z",
      inclusionPosition: 1,
    }],
  }, {
    includeInput: () => {},
    prepareContextWindow: () => {},
    prepareEffect: () => {
      throw new Error("This test has no Effects");
    },
  });
  const secondResult = await second.result;
  const reopenedEntries = (await readFile(transcriptFile, "utf8"))
    .trimEnd()
    .split("\n")
    .map(line => JSON.parse(line) as Record<string, unknown>);

  assert.equal(reopenedEntries.filter(entry => entry.type === "custom" && entry.customType === "loom.input.v1").length, 2);
  assert.equal(secondResult.inputAnchors[0]?.inputId, "input-2");
  assert.equal(secondResult.transcriptAnchor.sessionId, result.transcriptAnchor.sessionId);
});

test("continues from the last committed Context after a failed transcript branch", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-context-branch-"));
  const transcriptFile = path.join(root, "transcript", "agent.jsonl");
  const { faux, model, modelRuntime } = await createTestPi(root);
  faux.setResponses([
    fauxAssistantMessage("committed reply"),
    fauxAssistantMessage("failed reply", {
      stopReason: "error",
      errorMessage: "provider failure",
    }),
    context => {
      const text = context.messages.map(message => JSON.stringify(message)).join("\n");
      assert.match(text, /committed input/);
      assert.match(text, /committed reply/);
      assert.doesNotMatch(text, /failed input/);
      assert.doesNotMatch(text, /failed reply/);
      assert.match(text, /recovered input/);
      return fauxAssistantMessage("recovered reply");
    },
  ]);

  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(await createAgentWorkspaceFixture(root)),
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    harnessSystemPrompt: "You are the primary Agent.",
  });
  t.after(() => execution.close());
  const control = {
    includeInput: () => {},
    prepareContextWindow: () => {},
    prepareEffect: () => {
      throw new Error("This test has no Effects");
    },
  };

  const committed = await execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [executionInput("input-1", "committed input")],
  }, control).result;

  await assert.rejects(execution.start({
    turnId: "turn-2",
    leaseToken: 2,
    inputs: [executionInput("input-2", "failed input")],
    contextWindow: committed.contextWindow,
  }, control).result, /provider failure/);

  const recovered = await execution.start({
    turnId: "turn-3",
    leaseToken: 3,
    inputs: [executionInput("input-3", "recovered input")],
    contextWindow: committed.contextWindow,
  }, control).result;

  assert.equal(recovered.contextWindow.committedTrace.length, 4);
  assert.deepEqual(recovered.contextWindow.transcriptAnchor, recovered.transcriptAnchor);
});

test("refreshes Turn-live material while keeping the window-frozen seed", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-context-materials-"));
  const transcriptFile = path.join(root, "transcript", "agent.jsonl");
  const { faux, model, modelRuntime } = await createTestPi(root);
  let revision = 0;
  faux.setResponses([
    context => {
      const text = context.messages.map(message => JSON.stringify(message)).join("\n");
      assert.match(text, /live-1/);
      assert.match(text, /frozen-1/);
      assert.equal(text.match(/first input/g)?.length, 1);
      return fauxAssistantMessage("first reply");
    },
    context => {
      const text = context.messages.map(message => JSON.stringify(message)).join("\n");
      assert.match(text, /live-2/);
      assert.doesNotMatch(text, /live-1/);
      assert.match(text, /frozen-1/);
      assert.doesNotMatch(text, /frozen-2/);
      assert.match(text, /first input/);
      assert.match(text, /first reply/);
      assert.equal(text.match(/second input/g)?.length, 1);
      return fauxAssistantMessage("second reply");
    },
  ]);

  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(await createAgentWorkspaceFixture(root)),
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    harnessSystemPrompt: "You are the primary Agent.",
    loadContextMaterials: async () => {
      revision += 1;
      return {
        turnLive: [contextMessage(`live-${revision}`)],
        windowFrozen: [contextMessage(`frozen-${revision}`)],
      };
    },
  });
  t.after(() => execution.close());
  const control = {
    includeInput: () => {},
    prepareContextWindow: () => {},
    prepareEffect: () => {
      throw new Error("This test has no Effects");
    },
  };

  const first = await execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [executionInput("input-1", "first input")],
  }, control).result;
  const second = await execution.start({
    turnId: "turn-2",
    leaseToken: 2,
    inputs: [executionInput("input-2", "second input")],
    contextWindow: first.contextWindow,
  }, control).result;

  assert.deepEqual(first.contextWindow.frozenSeed, [contextMessage("frozen-1")]);
  assert.deepEqual(second.contextWindow.frozenSeed, first.contextWindow.frozenSeed);
  assert.equal(revision, 2);
});

test("rejects an over-limit current Input before calling the provider", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-context-limit-"));
  const transcriptFile = path.join(root, "transcript", "agent.jsonl");
  const { faux, model, modelRuntime } = await createTestPi(root);
  faux.setResponses([fauxAssistantMessage("must not run")]);
  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(await createAgentWorkspaceFixture(root)),
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    harnessSystemPrompt: "primary Agent",
    contextBudget: {
      hardContext: 40,
      normalMaterial: 20,
      outputReserve: 10,
      safetyMargin: 0,
      toolTraceReservation: 20,
    },
  });
  t.after(() => execution.close());
  const included: string[] = [];

  const running = execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [executionInput("input-1", "x".repeat(1_000))],
  }, {
    includeInput: inputId => included.push(inputId),
    prepareContextWindow: () => {},
    prepareEffect: () => {
      throw new Error("This test has no Effects");
    },
  });

  await assert.rejects(running.result, /required current Input/i);
  assert.equal(faux.state.callCount, 0);
  assert.deepEqual(included, []);
});

test("rejects an invalid non-empty transcript without changing it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-invalid-transcript-"));
  const transcriptFile = path.join(root, "agent.jsonl");
  const original = `${JSON.stringify({ type: "message", id: "orphan", parentId: null })}\n`;
  await writeFile(transcriptFile, original, "utf8");
  const { model, modelRuntime } = await createTestPi(root);

  await assert.rejects(createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(await createAgentWorkspaceFixture(root)),
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    harnessSystemPrompt: "You are the primary Agent.",
  }), /valid pi session/i);
  assert.equal(await readFile(transcriptFile, "utf8"), original);
});

function executionInput(id: string, text: string) {
  return {
    id,
    kind: "interaction" as const,
    payload: { text },
    occurredAt: "2026-07-19T00:00:00.000Z",
    inclusionPosition: 1,
  };
}

function contextMessage(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: 0,
  };
}

async function createAgentWorkspaceFixture(root: string): Promise<string> {
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(path.join(workspaceRoot, "behavior"), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspaceRoot, "identity.md"), "identity material", "utf8"),
    writeFile(path.join(workspaceRoot, "memory.md"), "long-term memory", "utf8"),
    writeFile(path.join(workspaceRoot, "behavior", "interaction.md"), "interaction behavior", "utf8"),
    writeFile(path.join(workspaceRoot, "behavior", "background.md"), "background behavior", "utf8"),
    writeFile(path.join(workspaceRoot, "attention.md"), "current attention", "utf8"),
  ]);
  return workspaceRoot;
}

function noEffectControl() {
  return {
    includeInput: () => {},
    prepareContextWindow: () => {},
    prepareEffect: () => {
      throw new Error("This test has no Effects");
    },
  };
}

function textTokenEstimate(text: string): number {
  return estimateTokens(contextMessage(text));
}

test("does not include or annotate a steering Input before Pi starts its user message", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-steering-"));
  const transcriptFile = path.join(root, "transcript", "agent.jsonl");
  const { faux, model, modelRuntime } = await createTestPi(root);
  const providerStarted = deferred();
  const releaseProvider = deferred();
  faux.setResponses([
    async () => {
      providerStarted.resolve();
      await releaseProvider.promise;
      return fauxAssistantMessage("first response");
    },
    fauxAssistantMessage("response after steering"),
  ]);

  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(await createAgentWorkspaceFixture(root)),
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    harnessSystemPrompt: "You are the primary Agent.",
  });
  t.after(() => execution.close());
  const included: string[] = [];
  const running = execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [{
      id: "input-1",
      kind: "interaction",
      payload: { text: "same text" },
      occurredAt: "2026-07-19T00:00:00.000Z",
      inclusionPosition: 1,
    }],
  }, {
    includeInput: inputId => included.push(inputId),
    prepareContextWindow: () => {},
    prepareEffect: () => {
      throw new Error("This test has no Effects");
    },
  });
  await providerStarted.promise;
  await running.steer({
    id: "input-2",
    kind: "interaction",
    payload: { text: "same text" },
    occurredAt: "2026-07-19T00:00:01.000Z",
    inclusionPosition: 2,
  });

  assert.deepEqual(included, ["input-1"]);
  releaseProvider.resolve();
  const result = await running.result;

  const branch = (await readFile(transcriptFile, "utf8"))
    .trimEnd()
    .split("\n")
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .slice(1);
  assert.deepEqual(included, ["input-1", "input-2"]);
  assert.deepEqual(result.inputAnchors.map(anchor => anchor.inputId), ["input-1", "input-2"]);
  const inputAndMessageOrder = branch.flatMap(entry => {
    if (entry.type === "custom" && entry.customType === "loom.input.v1") {
      return [(entry.data as { inputId?: string }).inputId];
    }
    if (entry.type === "message") return [(entry.message as { role?: string } | undefined)?.role];
    return [];
  });
  assert.deepEqual(inputAndMessageOrder, [
    "input-1",
    "user",
    "assistant",
    "input-2",
    "user",
    "assistant",
  ]);
});

test("does not complete or include queued steering after abort", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-abort-"));
  const transcriptFile = path.join(root, "transcript", "agent.jsonl");
  const { faux, model, modelRuntime } = await createTestPi(root);
  const providerStarted = deferred();
  const releaseProvider = deferred();
  faux.setResponses([
    async () => {
      providerStarted.resolve();
      await releaseProvider.promise;
      return fauxAssistantMessage("response after abort");
    },
    fauxAssistantMessage("queued response"),
  ]);

  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(await createAgentWorkspaceFixture(root)),
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    harnessSystemPrompt: "You are the primary Agent.",
  });
  t.after(() => execution.close());
  const included: string[] = [];
  const running = execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [{
      id: "input-1",
      kind: "interaction",
      payload: { text: "first" },
      occurredAt: "2026-07-19T00:00:00.000Z",
      inclusionPosition: 1,
    }],
  }, {
    includeInput: inputId => included.push(inputId),
    prepareContextWindow: () => {},
    prepareEffect: () => {
      throw new Error("This test has no Effects");
    },
  });
  await providerStarted.promise;
  await running.steer({
    id: "input-2",
    kind: "interaction",
    payload: { text: "second" },
    occurredAt: "2026-07-19T00:00:01.000Z",
    inclusionPosition: 2,
  });

  const result = assert.rejects(running.result, /abort/i);
  const abort = running.abort("test abort");
  await assert.rejects(running.steer({
    id: "input-3",
    kind: "interaction",
    payload: { text: "too late" },
    occurredAt: "2026-07-19T00:00:02.000Z",
    inclusionPosition: 3,
  }), /no longer accepts steering/);
  releaseProvider.resolve();
  await abort;
  await result;

  assert.deepEqual(included, ["input-1"]);
});

test("does not complete a Turn after Pi ends with an error", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-error-"));
  const transcriptFile = path.join(root, "transcript", "agent.jsonl");
  const { faux, model, modelRuntime } = await createTestPi(root);
  faux.setResponses([
    fauxAssistantMessage("provider rejected the request", {
      stopReason: "error",
      errorMessage: "invalid request",
    }),
  ]);
  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(await createAgentWorkspaceFixture(root)),
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    harnessSystemPrompt: "You are the primary Agent.",
  });
  t.after(() => execution.close());

  const running = execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [{
      id: "input-1",
      kind: "interaction",
      payload: { text: "hello" },
      occurredAt: "2026-07-19T00:00:00.000Z",
      inclusionPosition: 1,
    }],
  }, {
    includeInput: () => {},
    prepareContextWindow: () => {},
    prepareEffect: () => {
      throw new Error("This test has no Effects");
    },
  });

  await assert.rejects(running.result, /invalid request/);
});

test("waits for Pi tool results before returning Turn evidence", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-tool-"));
  const transcriptFile = path.join(root, "transcript", "agent.jsonl");
  const { faux, model, modelRuntime } = await createTestPi(root);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("lookup", { query: "Loom" }, { id: "call-1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("tool result received"),
  ]);
  const lookup = defineTool({
    name: "lookup",
    label: "Lookup",
    description: "Return a deterministic test value.",
    parameters: Type.Object({ query: Type.String() }),
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text" as const, text: `found:${params.query}` }],
      details: {},
    }),
  });

  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(await createAgentWorkspaceFixture(root)),
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    harnessSystemPrompt: "You are the primary Agent.",
    readOnlyTools: [lookup],
  });
  t.after(() => execution.close());
  const running = execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [{
      id: "input-1",
      kind: "interaction",
      payload: { text: "use the lookup" },
      occurredAt: "2026-07-19T00:00:00.000Z",
      inclusionPosition: 1,
    }],
  }, {
    includeInput: () => {},
    prepareContextWindow: () => {},
    prepareEffect: () => {
      throw new Error("The lookup tool is read-only");
    },
  });

  const result = await running.result;
  const roles = (await readFile(transcriptFile, "utf8"))
    .trimEnd()
    .split("\n")
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(entry => entry.type === "message")
    .map(entry => (entry.message as { role?: string }).role);

  assert.deepEqual(roles, ["user", "assistant", "toolResult", "assistant"]);
  assert.equal(result.inputAnchors[0]?.inputId, "input-1");
});
