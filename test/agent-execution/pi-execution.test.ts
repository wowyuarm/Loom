import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineTool, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createPiAgentExecution } from "../../src/agent-execution/pi-execution.js";

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

test("runs an Input through Pi and returns verified transcript evidence", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-execution-"));
  const transcriptFile = path.join(root, "transcript", "agent.jsonl");
  const { faux, model, modelRuntime } = await createTestPi(root);
  faux.setResponses([fauxAssistantMessage("hello back")]);

  const execution = await createPiAgentExecution({
    cwd: root,
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    systemPrompt: "You are the primary Agent.",
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
    cwd: root,
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    systemPrompt: "You are the primary Agent.",
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

test("rejects an invalid non-empty transcript without changing it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-invalid-transcript-"));
  const transcriptFile = path.join(root, "agent.jsonl");
  const original = `${JSON.stringify({ type: "message", id: "orphan", parentId: null })}\n`;
  await writeFile(transcriptFile, original, "utf8");
  const { model, modelRuntime } = await createTestPi(root);

  await assert.rejects(createPiAgentExecution({
    cwd: root,
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    systemPrompt: "You are the primary Agent.",
  }), /valid pi session/i);
  assert.equal(await readFile(transcriptFile, "utf8"), original);
});

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
    cwd: root,
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    systemPrompt: "You are the primary Agent.",
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
    cwd: root,
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    systemPrompt: "You are the primary Agent.",
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
    cwd: root,
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    systemPrompt: "You are the primary Agent.",
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
    cwd: root,
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    systemPrompt: "You are the primary Agent.",
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
