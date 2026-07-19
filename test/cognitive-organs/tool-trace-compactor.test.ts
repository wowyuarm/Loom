import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { createPiToolTraceCompactor } from "../../src/cognitive-organs/tool-trace-compactor.js";

test("compacts tool evidence in an isolated factual Pi run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-tool-trace-organ-"));
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(root, "config", "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(root, "config", "models-store.json"),
    allowModelNetwork: false,
  });
  const faux = createFauxCore({ provider: "loom-compactor-test", api: "loom-compactor-test" });
  modelRuntime.registerProvider("loom-compactor-test", {
    name: "Loom Compactor Test",
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
  const model = modelRuntime.getModel("loom-compactor-test", faux.getModel().id);
  assert.ok(model);
  faux.setResponses([
    context => {
      const systemPrompt = context.systemPrompt ?? "";
      assert.match(systemPrompt, /compress completed tool interactions/i);
      assert.match(systemPrompt, /do not infer.*motivation.*position.*next action/i);
      assert.doesNotMatch(systemPrompt, /# Identity|# Behavior|# Long-term Memory|# Current Attention/);
      assert.doesNotMatch(systemPrompt, /<available_skills>/);
      assert.deepEqual(context.tools, []);
      const input = JSON.stringify(context.messages);
      assert.match(input, /call-1/);
      assert.match(input, /notes\.md/);
      assert.match(input, /source statement/);
      assert.doesNotMatch(input, /tool-result\/v1\/source-1/);
      return fauxAssistantMessage(JSON.stringify({
        results: [{
          toolCallId: "call-1",
          callSummary: "Read notes.md.",
          resultSummary: "The file contained a source statement.",
          confirmedFacts: ["The read returned text."],
          sourceClaims: ["The file states that the source is current."],
          limitations: [],
        }],
      }));
    },
  ]);
  const compactor = await createPiToolTraceCompactor({
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    modelRuntime,
    model,
  });

  const result = await compactor.compact([{
    toolCallId: "call-1",
    toolName: "read",
    callArguments: { path: "notes.md" },
    toolResult: {
      isError: false,
      content: [{ type: "text", text: "source statement" }],
    },
  }]);

  assert.deepEqual(result, [{
    toolCallId: "call-1",
    callSummary: "Read notes.md.",
    resultSummary: "The file contained a source statement.",
    confirmedFacts: ["The read returned text."],
    sourceClaims: ["The file states that the source is current."],
    limitations: [],
  }]);
});

test("rejects a compaction result with fields outside the factual contract", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-tool-trace-invalid-"));
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(root, "config", "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(root, "config", "models-store.json"),
    allowModelNetwork: false,
  });
  const faux = createFauxCore({ provider: "loom-compactor-invalid", api: "loom-compactor-invalid" });
  modelRuntime.registerProvider("loom-compactor-invalid", {
    name: "Loom Compactor Invalid Test",
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
  const model = modelRuntime.getModel("loom-compactor-invalid", faux.getModel().id);
  assert.ok(model);
  faux.setResponses([
    fauxAssistantMessage(JSON.stringify({
      results: [{
        toolCallId: "call-1",
        callSummary: "Read notes.md.",
        resultSummary: "Read text.",
        confirmedFacts: [],
        sourceClaims: [],
        limitations: [],
        recommendation: "Act on the result.",
      }],
    })),
  ]);
  const compactor = await createPiToolTraceCompactor({
    agentDir: path.join(root, "agent"),
    transcriptDirectory: path.join(root, "transcripts"),
    modelRuntime,
    model,
  });

  await assert.rejects(compactor.compact([{
    toolCallId: "call-1",
    toolName: "read",
    callArguments: { path: "notes.md" },
    toolResult: { isError: false, content: [{ type: "text", text: "source statement" }] },
  }]), /unexpected fields/i);
});
