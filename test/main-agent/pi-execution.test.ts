import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  defineTool,
  estimateTokens,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { parseContextWindowState } from "../../src/main-agent/context.js";
import { createPiAgentExecution } from "../../src/main-agent/pi-execution.js";
import { AgentWorkspace } from "../../src/workspace/agent-workspace.js";
import type { EffectRequest, JsonValue } from "../../src/runtime/index.js";

function contextWindow(result: { executionState: JsonValue }) {
  const window = parseContextWindowState(result.executionState);
  assert.ok(window);
  return window;
}

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

test("presents core and Workspace skills as one stable catalog without Pi inheritance", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-skills-"));
  const workspaceRoot = await createAgentWorkspaceFixture(root);
  const agentDir = path.join(root, "agent-config");
  const coreSkills = path.join(root, "core-skills");
  const integrationSkills = path.join(root, "integration-skills");
  await Promise.all([
    writeSkill(coreSkills, "zeta-core", "Harness-maintained capability."),
    writeSkill(path.join(workspaceRoot, "skills"), "alpha-workspace", "Individual-maintained capability."),
    writeSkill(integrationSkills, "middle-integration", "Integration-maintained capability."),
    writeSkill(path.join(agentDir, "skills"), "leaked-user", "Must not be inherited."),
    writeSkill(path.join(workspaceRoot, ".pi", "skills"), "leaked-project", "Must not be inherited."),
  ]);
  const { faux, model, modelRuntime } = await createTestPi(root);
  faux.setResponses([
    context => {
      const prompt = context.systemPrompt ?? "";
      assert.match(prompt, /<available_skills>/);
      assert.match(prompt, /<name>alpha-workspace<\/name>/);
      assert.match(prompt, /<name>middle-integration<\/name>/);
      assert.match(prompt, /<name>zeta-core<\/name>/);
      assert.ok(prompt.indexOf("alpha-workspace") < prompt.indexOf("middle-integration"));
      assert.ok(prompt.indexOf("middle-integration") < prompt.indexOf("zeta-core"));
      assert.doesNotMatch(prompt, /leaked-user|leaked-project/);
      return fauxAssistantMessage("skills received");
    },
  ]);
  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir,
    transcriptFile: path.join(root, "transcript", "agent.jsonl"),
    modelRuntime,
    model,
    harnessSystemPrompt: "harness guidance",
    readOnlyTools: [readTool()],
    skillSources: { core: [coreSkills], integrations: [integrationSkills] },
  });
  t.after(() => execution.close());

  await execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [executionInput("input-1", "hello")],
  }, noEffectControl()).result;
  assert.equal(faux.state.callCount, 1);
});

test("removes every skill sharing a name across sources", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-skill-collision-"));
  const workspaceRoot = await createAgentWorkspaceFixture(root);
  const coreSkills = path.join(root, "core-skills");
  await Promise.all([
    writeSkill(coreSkills, "shared-name", "Core version."),
    writeSkill(path.join(workspaceRoot, "skills"), "shared-name", "Workspace version."),
  ]);
  const transcriptFile = path.join(root, "transcript", "agent.jsonl");
  const { faux, model, modelRuntime } = await createTestPi(root);
  faux.setResponses([
    context => {
      const prompt = context.systemPrompt ?? "";
      assert.doesNotMatch(prompt, /<name>shared-name<\/name>/);
      assert.match(prompt, /# Skill Diagnostics/);
      assert.match(prompt, /shared-name/);
      assert.match(prompt, /\"type\": \"collision\"/);
      return fauxAssistantMessage("collision diagnosed");
    },
  ]);
  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent-config"),
    transcriptFile,
    modelRuntime,
    model,
    harnessSystemPrompt: "harness guidance",
    skillSources: { core: [coreSkills], integrations: [] },
  });
  t.after(() => execution.close());

  await execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [executionInput("input-1", "hello")],
  }, noEffectControl()).result;
  assert.equal(faux.state.callCount, 1);
  assert.match(await readFile(transcriptFile, "utf8"), /loom\.skill-diagnostics\.v1/);
});

test("requires a read tool before running a Turn with accepted skills", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-skill-read-"));
  const workspaceRoot = await createAgentWorkspaceFixture(root);
  await writeSkill(path.join(workspaceRoot, "skills"), "workspace-skill", "Readable capability.");
  const { faux, model, modelRuntime } = await createTestPi(root);
  const included: string[] = [];
  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent-config"),
    transcriptFile: path.join(root, "transcript", "agent.jsonl"),
    modelRuntime,
    model,
    harnessSystemPrompt: "harness guidance",
  });
  t.after(() => execution.close());

  await assert.rejects(execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [executionInput("input-1", "hello")],
  }, {
    ...noEffectControl(),
    includeInput: inputId => included.push(inputId),
  }).result, /accepted skills require an active read tool/i);
  assert.equal(faux.state.callCount, 0);
  assert.deepEqual(included, []);
});

test("refreshes Workspace skills between Turns but freezes them during steering", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-skill-refresh-"));
  const workspaceRoot = await createAgentWorkspaceFixture(root);
  const workspaceSkills = path.join(workspaceRoot, "skills");
  await Promise.all([
    writeSkill(workspaceSkills, "changing", "Description version one."),
    writeSkill(workspaceSkills, "removed", "Present in the first Turn."),
  ]);
  const { faux, model, modelRuntime } = await createTestPi(root);
  const providerStarted = deferred();
  const releaseProvider = deferred();
  const expectFirstCatalog = (systemPrompt: string | undefined) => {
    const prompt = systemPrompt ?? "";
    assert.match(prompt, /Description version one/);
    assert.match(prompt, /<name>removed<\/name>/);
    assert.doesNotMatch(prompt, /Description version two|<name>added<\/name>/);
  };
  faux.setResponses([
    async context => {
      expectFirstCatalog(context.systemPrompt);
      providerStarted.resolve();
      await releaseProvider.promise;
      return fauxAssistantMessage("first response");
    },
    context => {
      expectFirstCatalog(context.systemPrompt);
      return fauxAssistantMessage("steering response");
    },
    context => {
      const prompt = context.systemPrompt ?? "";
      assert.match(prompt, /Description version two/);
      assert.match(prompt, /<name>added<\/name>/);
      assert.doesNotMatch(prompt, /Description version one|<name>removed<\/name>/);
      return fauxAssistantMessage("next Turn response");
    },
  ]);
  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent-config"),
    transcriptFile: path.join(root, "transcript", "agent.jsonl"),
    modelRuntime,
    model,
    harnessSystemPrompt: "harness guidance",
    readOnlyTools: [readTool()],
  });
  t.after(() => execution.close());

  const firstTurn = execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [executionInput("input-1", "hello")],
  }, noEffectControl());
  await providerStarted.promise;
  await Promise.all([
    writeSkill(workspaceSkills, "changing", "Description version two."),
    writeSkill(workspaceSkills, "added", "Added for the next Turn."),
    rm(path.join(workspaceSkills, "removed"), { recursive: true }),
  ]);
  const steering = firstTurn.steer(executionInput("input-2", "follow up"));
  releaseProvider.resolve();
  await Promise.all([steering, firstTurn.result]);

  await execution.start({
    turnId: "turn-2",
    leaseToken: 2,
    inputs: [executionInput("input-3", "new Turn")],
  }, noEffectControl()).result;
  assert.equal(faux.state.callCount, 3);
});

test("excludes unusable skills while exposing and recording their diagnostics", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-skill-diagnostics-"));
  const workspaceRoot = await createAgentWorkspaceFixture(root);
  const skillsRoot = path.join(root, "core-skills");
  await Promise.all([
    writeSkill(skillsRoot, "Invalid_Name", "Invalid name capability."),
    writeSkill(skillsRoot, "manual-only", "Human-invoked capability.", "disable-model-invocation: true\n"),
  ]);
  const transcriptFile = path.join(root, "transcript", "agent.jsonl");
  const { faux, model, modelRuntime } = await createTestPi(root);
  faux.setResponses([
    context => {
      const prompt = context.systemPrompt ?? "";
      assert.doesNotMatch(prompt, /<name>Invalid_Name<\/name>|<name>manual-only<\/name>/);
      assert.match(prompt, /# Skill Diagnostics/);
      assert.match(prompt, /Invalid_Name/);
      assert.match(prompt, /manual-only/);
      return fauxAssistantMessage("diagnostics received");
    },
  ]);
  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent-config"),
    transcriptFile,
    modelRuntime,
    model,
    harnessSystemPrompt: "harness guidance",
    readOnlyTools: [readTool()],
    skillSources: { core: [skillsRoot], integrations: [] },
  });
  t.after(() => execution.close());

  await execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [executionInput("input-1", "hello")],
  }, noEffectControl()).result;

  const transcript = await readTranscript(transcriptFile);
  const diagnostics = transcript.find(entry => entry.customType === "loom.skill-diagnostics.v1");
  assert.equal((diagnostics?.data as { turnId?: string } | undefined)?.turnId, "turn-1");
  assert.match(JSON.stringify(diagnostics?.data), /Invalid_Name/);
  assert.match(JSON.stringify(diagnostics?.data), /manual-only/);
  assert.equal(faux.state.callCount, 1);
});

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
  let providerTools: unknown[] = [];
  faux.setResponses([
    context => {
      providerSystemPrompt = context.systemPrompt ?? "";
      providerTools = context.tools ?? [];
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

  const plan = result.executionRecord as { budget: { fixedTokens: number } };
  assert.equal(
    plan.budget.fixedTokens,
    textTokenEstimate(providerSystemPrompt) + textTokenEstimate(JSON.stringify(providerTools)),
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
      const messages = JSON.stringify(context.messages);
      assert.match(messages, /<proactive_opportunity>/);
      assert.match(messages, /unfinished private line/);
      assert.match(messages, /not a human message/i);
      providerStarted.resolve();
      await releaseProvider.promise;
      return fauxAssistantMessage("first response");
    },
    context => {
      expectOriginalBackground(context.systemPrompt);
      const messages = JSON.stringify(context.messages);
      assert.match(messages, /human message arrived/i);
      assert.match(messages, /new interaction/);
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
      payload: {
        version: 1,
        narrative: "The unfinished private line has a concrete place to continue.",
        observedAt: "2026-07-19T00:00:00.000Z",
        localTime: "2026-07-19 08:00 +08:00",
        lastHumanInputAt: "2026-07-18T22:00:00.000Z",
      },
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

test("records a successful ordinary tool before the provider can continue", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-tool-activity-"));
  const workspaceRoot = await createAgentWorkspaceFixture(root);
  const { faux, model, modelRuntime } = await createTestPi(root);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("read", { path: "attention.md" }, { id: "read-attention" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("tool completed"),
  ]);
  const recorded: unknown[] = [];
  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    agentDir: path.join(root, "agent-config"),
    transcriptFile: path.join(root, "transcript", "agent.jsonl"),
    modelRuntime,
    model,
    harnessSystemPrompt: "harness guidance",
    readOnlyTools: [readTool()],
  });
  t.after(() => execution.close());

  await execution.start({
    turnId: "turn-activity",
    leaseToken: 1,
    inputs: [executionInput("input-activity", "read it")],
  }, {
    ...noEffectControl(),
    recordToolActivity: activity => recorded.push(activity),
  }).result;

  assert.deepEqual(recorded, [{
    toolCallId: "read-attention",
    toolName: "read",
    callArguments: { path: "attention.md" },
    result: {
      content: [{ type: "text", text: "test file" }],
      details: {},
    },
  }]);
});

test("does not record Context expansion as ordinary lived activity", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-context-tool-"));
  const { faux, model, modelRuntime } = await createTestPi(root);
  faux.setResponses([fauxAssistantMessage("no expansion needed")]);
  const recorded: unknown[] = [];
  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(await createAgentWorkspaceFixture(root)),
    agentDir: path.join(root, "agent-config"),
    transcriptFile: path.join(root, "transcript", "agent.jsonl"),
    modelRuntime,
    model,
    harnessSystemPrompt: "harness guidance",
  });
  t.after(() => execution.close());

  await execution.start({
    turnId: "turn-context-tool",
    leaseToken: 1,
    inputs: [executionInput("input-context-tool", "continue")],
  }, {
    ...noEffectControl(),
    recordToolActivity: activity => recorded.push(activity),
  }).result;

  assert.deepEqual(recorded, []);
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
    executionState: first.executionState,
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
    prepareExecutionState: () => {},
    replaceExecutionState: () => {},
    recordToolActivity: () => {},
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
      payload: {
        version: 1,
        narrative: "Continue from the committed activity.",
        observedAt: "2026-07-19T00:01:00.000Z",
        localTime: "2026-07-19 00:01 +00:00",
      },
      occurredAt: "2026-07-19T00:01:00.000Z",
      inclusionPosition: 1,
    }],
  }, {
    includeInput: () => {},
    prepareExecutionState: () => {},
    replaceExecutionState: () => {},
    recordToolActivity: () => {},
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

test("prepares a message Effect through the Main Agent action interface", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-message-send-"));
  const { faux, model, modelRuntime } = await createTestPi(root);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("message", {
      action: "send",
      text: "A message from the Individual.",
    }, { id: "message-send" }), { stopReason: "toolUse" }),
  ]);
  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(await createAgentWorkspaceFixture(root)),
    agentDir: path.join(root, "agent"),
    transcriptFile: path.join(root, "transcript", "agent.jsonl"),
    modelRuntime,
    model,
    harnessSystemPrompt: "You are the primary Agent.",
    defaultInteractionRoute: "primary-route",
  });
  t.after(() => execution.close());
  const effects: EffectRequest[] = [];

  const result = await execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [executionInput("input-1", "hello")],
  }, {
    includeInput: () => {},
    prepareExecutionState: () => {},
    replaceExecutionState: () => {},
    recordToolActivity: () => {},
    prepareEffect: effect => {
      effects.push(effect);
      return { effectId: "effect-1" };
    },
  }).result;

  assert.equal(result.outcome, "completed");
  assert.deepEqual(effects, [{
    kind: "message",
    payload: { text: "A message from the Individual." },
    routeRef: "primary-route",
  }]);
});

test("finishes with no_reply without preparing an Effect", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-message-no-reply-"));
  const { faux, model, modelRuntime } = await createTestPi(root);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("message", {
      action: "no_reply",
      reason: "Nothing needs to be sent.",
    }, { id: "message-no-reply" }), { stopReason: "toolUse" }),
  ]);
  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(await createAgentWorkspaceFixture(root)),
    agentDir: path.join(root, "agent"),
    transcriptFile: path.join(root, "transcript", "agent.jsonl"),
    modelRuntime,
    model,
    harnessSystemPrompt: "You are the primary Agent.",
    defaultInteractionRoute: "primary-route",
  });
  t.after(() => execution.close());

  const result = await execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [executionInput("input-1", "hello")],
  }, noEffectControl()).result;

  assert.equal(result.outcome, "no_reply");
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
    prepareExecutionState: () => {},
    replaceExecutionState: () => {},
    recordToolActivity: () => {},
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
    executionState: committed.executionState,
  }, control).result, /provider failure/);

  const recovered = await execution.start({
    turnId: "turn-3",
    leaseToken: 3,
    inputs: [executionInput("input-3", "recovered input")],
    executionState: committed.executionState,
  }, control).result;

  assert.equal(contextWindow(recovered).committedTrace.length, 4);
  assert.deepEqual(contextWindow(recovered).transcriptAnchor, recovered.transcriptAnchor);
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
    prepareExecutionState: () => {},
    replaceExecutionState: () => {},
    recordToolActivity: () => {},
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
    executionState: first.executionState,
  }, control).result;

  assert.deepEqual(contextWindow(first).frozenSeed, [contextMessage("frozen-1")]);
  assert.deepEqual(contextWindow(second).frozenSeed, contextWindow(first).frozenSeed);
  assert.deepEqual(
    contextWindow(second).recentActivityReferences,
    contextWindow(first).recentActivityReferences,
  );
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
    prepareExecutionState: () => {},
    replaceExecutionState: () => {},
    recordToolActivity: () => {},
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

async function writeSkill(parent: string, name: string, description: string, extra = ""): Promise<string> {
  const skillDir = path.join(parent, name);
  await mkdir(skillDir, { recursive: true });
  const skillFile = path.join(skillDir, "SKILL.md");
  await writeFile(
    skillFile,
    `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`,
    "utf8",
  );
  return skillFile;
}

function readTool() {
  return defineTool({
    name: "read",
    label: "Read",
    description: "Read an Agent Workspace file.",
    parameters: Type.Object({ path: Type.String() }),
    execute: async () => ({ content: [{ type: "text" as const, text: "test file" }], details: {} }),
  });
}

async function readTranscript(transcriptFile: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(transcriptFile, "utf8"))
    .trimEnd()
    .split("\n")
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

function noEffectControl() {
  return {
    includeInput: () => {},
    prepareExecutionState: () => {},
    replaceExecutionState: () => {},
    recordToolActivity: () => {},
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
    prepareExecutionState: () => {},
    replaceExecutionState: () => {},
    recordToolActivity: () => {},
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
    prepareExecutionState: () => {},
    replaceExecutionState: () => {},
    recordToolActivity: () => {},
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
    prepareExecutionState: () => {},
    replaceExecutionState: () => {},
    recordToolActivity: () => {},
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
    prepareExecutionState: () => {},
    replaceExecutionState: () => {},
    recordToolActivity: () => {},
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

test("compacts committed tool traces and expands an authorized original interaction", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-tool-trace-compaction-"));
  const transcriptFile = path.join(root, "transcript", "agent.jsonl");
  const { faux, model, modelRuntime } = await createTestPi(root);
  const originalResult = `found:original question\n${"x".repeat(45_000)}\noriginal end`;
  let compactedReference = "";
  let nextOffset = 0;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("lookup", { query: "original question" }, { id: "call-1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("first turn complete"),
    context => {
      const serialized = JSON.stringify(context.messages);
      assert.doesNotMatch(serialized, /original question/);
      assert.doesNotMatch(serialized, /found:original question/);
      const compacted = context.messages.find(message => message.role === "toolResult");
      assert.ok(compacted && compacted.role === "toolResult");
      const text = compacted.content.find(block => block.type === "text")?.text;
      assert.ok(text);
      const record = JSON.parse(text) as { type?: string; reference?: string };
      assert.equal(record.type, "loom.tool-interaction.compacted");
      assert.ok(record.reference);
      compactedReference = record.reference;
      assert.ok((context.tools ?? []).some(tool => tool.name === "expand_tool_result"));
      return fauxAssistantMessage(fauxToolCall(
        "expand_tool_result",
        { reference: compactedReference, offset: 0 },
        { id: "expand-1" },
      ), { stopReason: "toolUse" });
    },
    context => {
      const expansion = [...context.messages].reverse().find(message =>
        message.role === "toolResult" && message.toolName === "expand_tool_result");
      assert.ok(expansion && expansion.role === "toolResult");
      const text = expansion.content.find(block => block.type === "text")?.text;
      assert.ok(text);
      const page = JSON.parse(text) as {
        type?: string;
        reference?: string;
        offset?: number;
        nextOffset?: number | null;
        content?: string;
      };
      assert.equal(page.type, "loom.tool-interaction.page");
      assert.equal(page.reference, compactedReference);
      assert.equal(page.offset, 0);
      assert.ok(page.nextOffset);
      nextOffset = page.nextOffset;
      assert.match(page.content ?? "", /original question/);
      assert.doesNotMatch(page.content ?? "", /original end/);
      return fauxAssistantMessage(fauxToolCall(
        "expand_tool_result",
        { reference: compactedReference, offset: nextOffset },
        { id: "expand-2" },
      ), { stopReason: "toolUse" });
    },
    context => {
      const expansion = [...context.messages].reverse().find(message =>
        message.role === "toolResult" && message.toolCallId === "expand-2");
      assert.ok(expansion && expansion.role === "toolResult");
      const text = expansion.content.find(block => block.type === "text")?.text;
      assert.ok(text);
      const page = JSON.parse(text) as {
        reference?: string;
        offset?: number;
        nextOffset?: number | null;
        content?: string;
      };
      assert.equal(page.reference, compactedReference);
      assert.equal(page.offset, nextOffset);
      assert.equal(page.nextOffset, null);
      assert.match(page.content ?? "", /original end/);
      return fauxAssistantMessage(fauxToolCall(
        "expand_tool_result",
        { reference: "loom-tool-interaction:v1:eyJndWVzc2VkIjp0cnVlfQ", offset: 0 },
        { id: "expand-guessed" },
      ), { stopReason: "toolUse" });
    },
    context => {
      const rejected = [...context.messages].reverse().find(message =>
        message.role === "toolResult" && message.toolCallId === "expand-guessed");
      assert.ok(rejected && rejected.role === "toolResult");
      assert.equal(rejected.isError, true);
      assert.match(JSON.stringify(rejected.content), /not authorized by the current Context/i);
      return fauxAssistantMessage("expanded evidence received");
    },
    context => {
      const serialized = JSON.stringify(context.messages);
      assert.match(serialized, /loom\.tool-interaction\.expansion-compacted/);
      assert.doesNotMatch(serialized, /original end/);
      return fauxAssistantMessage("mechanical compaction received");
    },
  ]);
  const lookup = defineTool({
    name: "lookup",
    label: "Lookup",
    description: "Return a deterministic test value.",
    parameters: Type.Object({ query: Type.String() }),
    execute: async () => ({
      content: [{ type: "text" as const, text: originalResult }],
      details: {},
    }),
  });
  let compactorCalls = 0;
  const compactor = {
    async compact(inputs: Array<{ toolCallId: string; toolName: string; callArguments: unknown; toolResult: unknown }>) {
      compactorCalls += 1;
      assert.deepEqual(inputs, [{
        toolCallId: "call-1",
        toolName: "lookup",
        callArguments: { query: "original question" },
        toolResult: {
          isError: false,
          content: [{ type: "text", text: originalResult }],
        },
      }]);
      return [{
        toolCallId: "call-1",
        callSummary: "Looked up the supplied question.",
        resultSummary: "The lookup returned a matching value.",
        confirmedFacts: ["The lookup returned text."],
        sourceClaims: [],
        limitations: [],
      }];
    },
  };
  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(await createAgentWorkspaceFixture(root)),
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    harnessSystemPrompt: "You are the primary Agent.",
    readOnlyTools: [lookup],
    toolTraceCompactor: compactor,
    contextBudget: { toolTraceReservation: 1 },
  });
  t.after(() => execution.close());

  const first = await execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [executionInput("input-1", "use the lookup")],
  }, noEffectControl()).result;
  let replacement: unknown;
  const included: string[] = [];
  const second = await execution.start({
    turnId: "turn-2",
    leaseToken: 2,
    inputs: [executionInput("input-2", "inspect the evidence")],
    executionState: first.executionState,
  }, {
    ...noEffectControl(),
    includeInput: inputId => included.push(inputId),
    replaceExecutionState: (expected, next) => {
      assert.deepEqual(expected, first.executionState);
      replacement = next;
    },
    recordToolActivity: () => {},
  }).result;

  assert.ok(replacement);
  assert.deepEqual(included, ["input-2"]);
  assert.equal(contextWindow(second).transcriptAnchor?.entryId, second.transcriptAnchor.entryId);

  const third = await execution.start({
    turnId: "turn-3",
    leaseToken: 3,
    inputs: [executionInput("input-3", "continue after expansion")],
    executionState: second.executionState,
  }, noEffectControl()).result;

  assert.equal(compactorCalls, 1);
  assert.equal(faux.state.callCount, 7);
  assert.match(JSON.stringify(contextWindow(third).committedTrace), /expansion-compacted/);
});

test("keeps raw Context and excludes Input when tool trace compaction fails", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-tool-trace-gate-"));
  const transcriptFile = path.join(root, "transcript", "agent.jsonl");
  const { faux, model, modelRuntime } = await createTestPi(root);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("lookup", { query: "retry evidence" }, { id: "call-1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("first turn complete"),
    context => {
      const serialized = JSON.stringify(context.messages);
      assert.match(serialized, /loom\.tool-interaction\.compacted/);
      assert.match(serialized, /retry after failure/);
      return fauxAssistantMessage("retry complete");
    },
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
  let compactionAttempts = 0;
  const compactor = {
    async compact(inputs: Array<{ toolCallId: string }>) {
      compactionAttempts += 1;
      assert.deepEqual(inputs.map(input => input.toolCallId), ["call-1"]);
      if (compactionAttempts === 1) throw new Error("compactor unavailable");
      return [{
        toolCallId: "call-1",
        callSummary: "Looked up retry evidence.",
        resultSummary: "The lookup returned text.",
        confirmedFacts: ["Text was returned."],
        sourceClaims: [],
        limitations: [],
      }];
    },
  };
  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(await createAgentWorkspaceFixture(root)),
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    harnessSystemPrompt: "You are the primary Agent.",
    readOnlyTools: [lookup],
    toolTraceCompactor: compactor,
    contextBudget: { toolTraceReservation: 1 },
  });
  t.after(() => execution.close());
  const first = await execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [executionInput("input-1", "create retry evidence")],
  }, noEffectControl()).result;
  const failedIncluded: string[] = [];
  const failedReplacements: unknown[] = [];

  await assert.rejects(execution.start({
    turnId: "turn-2",
    leaseToken: 2,
    inputs: [executionInput("input-2", "retry after failure")],
    executionState: first.executionState,
  }, {
    ...noEffectControl(),
    includeInput: inputId => failedIncluded.push(inputId),
    replaceExecutionState: (_expected, replacement) => failedReplacements.push(replacement),
    recordToolActivity: () => {},
  }).result, /compactor unavailable/);

  assert.equal(faux.state.callCount, 2);
  assert.deepEqual(failedIncluded, []);
  assert.deepEqual(failedReplacements, []);
  assert.match(JSON.stringify(contextWindow(first).committedTrace), /retry evidence/);

  const retryIncluded: string[] = [];
  const retry = await execution.start({
    turnId: "turn-3",
    leaseToken: 3,
    inputs: [executionInput("input-2", "retry after failure")],
    executionState: first.executionState,
  }, {
    ...noEffectControl(),
    includeInput: inputId => retryIncluded.push(inputId),
  }).result;

  assert.equal(compactionAttempts, 2);
  assert.equal(faux.state.callCount, 3);
  assert.deepEqual(retryIncluded, ["input-2"]);
  assert.doesNotMatch(JSON.stringify(contextWindow(retry).committedTrace), /found:retry evidence/);
});

test("does not expose successful tool trace batches when another batch fails", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-pi-tool-trace-batches-"));
  const transcriptFile = path.join(root, "transcript", "agent.jsonl");
  const { faux, model, modelRuntime } = await createTestPi(root);
  const calls = Array.from({ length: 11 }, (_, index) =>
    fauxToolCall("lookup", { query: `query-${index + 1}` }, { id: `call-${index + 1}` }));
  faux.setResponses([
    fauxAssistantMessage(calls, { stopReason: "toolUse" }),
    fauxAssistantMessage("batch source complete"),
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
  const batchSizes: number[] = [];
  const compactor = {
    async compact(inputs: Array<{ toolCallId: string }>) {
      batchSizes.push(inputs.length);
      if (inputs.length === 1) throw new Error("final batch failed");
      return inputs.map(input => ({
        toolCallId: input.toolCallId,
        callSummary: `Called ${input.toolCallId}.`,
        resultSummary: `Received ${input.toolCallId}.`,
        confirmedFacts: [],
        sourceClaims: [],
        limitations: [],
      }));
    },
  };
  const execution = await createPiAgentExecution({
    agentWorkspace: new AgentWorkspace(await createAgentWorkspaceFixture(root)),
    agentDir: path.join(root, "agent"),
    transcriptFile,
    modelRuntime,
    model,
    harnessSystemPrompt: "You are the primary Agent.",
    readOnlyTools: [lookup],
    toolTraceCompactor: compactor,
    contextBudget: { toolTraceReservation: 1 },
  });
  t.after(() => execution.close());
  const first = await execution.start({
    turnId: "turn-1",
    leaseToken: 1,
    inputs: [executionInput("input-1", "create batched evidence")],
  }, noEffectControl()).result;
  const included: string[] = [];
  const replacements: unknown[] = [];

  await assert.rejects(execution.start({
    turnId: "turn-2",
    leaseToken: 2,
    inputs: [executionInput("input-2", "continue after batches")],
    executionState: first.executionState,
  }, {
    ...noEffectControl(),
    includeInput: inputId => included.push(inputId),
    replaceExecutionState: (_expected, replacement) => replacements.push(replacement),
    recordToolActivity: () => {},
  }).result, /final batch failed/);

  assert.deepEqual(batchSizes.sort((left, right) => left - right), [1, 10]);
  assert.equal(faux.state.callCount, 2);
  assert.deepEqual(included, []);
  assert.deepEqual(replacements, []);
});
