import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openLoomInstance } from "../../src/instance/index.js";
import type { DeliveryAttemptRequest } from "../../src/runtime/index.js";

test("keeps accepted Input pending while blocked and resumes it after model configuration recovers", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  let now = new Date("2026-07-22T10:00:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());
  assert.equal(instance.status().models?.state, "blocked");

  const accepted = await instance.acceptInput({
    source: "test-channel",
    sourceId: "blocked-input",
    kind: "interaction",
    payload: { text: "hello" },
  });

  assert.equal(accepted.disposition, "accepted");
  assert.deepEqual(await instance.runOnce(now), {
    disposition: "deferred",
    reason: "model_runtime_blocked",
  });
  assert.equal(instance.status().models?.state, "blocked");
  assert.equal(instance.status().runtime.inputs[0]?.status, "pending");
  assert.equal(instance.status().runtime.turns.length, 0);

  const provider = await startOpenAiProvider({ text: "Recovered response" });
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl);
  now = new Date("2026-07-22T10:01:00.000Z");

  assert.deepEqual(await instance.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T10:31:00.000Z",
  });
  assert.equal(instance.status().models?.state, "active");
  assert.equal(instance.status().runtime.inputs[0]?.status, "consumed");
  assert.equal(instance.status().runtime.turns[0]?.status, "completed");
});

test("opens recovery state and keeps Input pending when instance YAML is malformed", async t => {
  const root = await createInstanceRoot();
  await writeFile(
    path.join(root, "configuration", "instance.yaml"),
    "version: [private malformed configuration",
    "utf8",
  );
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC" });
  t.after(() => instance.close());

  await instance.acceptInput({
    source: "test-channel",
    sourceId: "malformed-configuration-input",
    kind: "interaction",
    payload: { text: "held safely" },
  });

  assert.equal((await instance.runOnce(new Date("2026-07-22T10:00:00.000Z"))).disposition, "deferred");
  assert.equal(instance.status().models?.state, "blocked");
  assert.equal(instance.status().runtime.inputs[0]?.status, "pending");
});

test("materializes only missing Harness-owned Behavior materials", async t => {
  const root = await createInstanceRoot();
  const interaction = path.join(root, "workspace", "behavior", "interaction.md");
  await mkdir(path.dirname(interaction), { recursive: true });
  await writeFile(interaction, "Existing individual interaction behavior.\n", "utf8");

  const instance = await openLoomInstance({ root });
  t.after(() => instance.close());

  assert.equal(await readFile(interaction, "utf8"), "Existing individual interaction behavior.\n");
  assert.match(
    await readFile(path.join(root, "workspace", "behavior", "background.md"), "utf8"),
    /Background time belongs to the Agent Individual/,
  );
});

test("runs one Main Agent Turn through the assembled Instance", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider({ text: "A private response" });
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl, undefined, "high");
  const now = new Date("2026-07-22T10:00:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());

  assert.equal(instance.status().models?.state, "active");

  await instance.acceptInput({
    source: "test-channel",
    sourceId: "working-input",
    kind: "interaction",
    payload: { text: "hello" },
  });

  assert.deepEqual(await instance.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T10:30:00.000Z",
  });
  assert.equal(provider.requests(), 1);
  assert.equal(provider.bodies()[0]?.reasoning_effort, "high");
  assert.deepEqual(toolNames(provider.bodies()[0]!), [
    "bash",
    "edit",
    "expand_tool_result",
    "find",
    "grep",
    "ls",
    "nmem_recall",
    "read",
    "write",
  ]);
  assert.equal(instance.status().runtime.inputs[0]?.status, "consumed");
  assert.equal(instance.status().runtime.turns[0]?.status, "completed");
});

test("stops before model execution when Individual-owned materials are missing", async t => {
  const root = await createInstanceRoot();
  const provider = await startOpenAiProvider({ text: "must not run" });
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl);
  const now = new Date("2026-07-22T10:00:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());
  await instance.acceptInput({
    source: "test-channel",
    sourceId: "missing-material-input",
    kind: "interaction",
    payload: { text: "hello" },
  });

  await assert.rejects(instance.runOnce(now), /Required Agent Workspace material .* is missing/);

  assert.equal(provider.requests(), 0);
  assert.equal(instance.status().runtime.inputs[0]?.status, "pending");
  assert.equal(instance.status().runtime.turns[0]?.status, "failed");
});

test("binds message Effects to the configured default Interaction Route", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider({
    tool: {
      name: "message",
      arguments: { action: "send", text: "A visible message" },
    },
  });
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl, "primary-route");
  const now = new Date("2026-07-22T10:00:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());

  await instance.acceptInput({
    source: "test-channel",
    sourceId: "message-input",
    kind: "interaction",
    payload: { text: "say hello" },
  });
  await instance.runOnce(now);

  assert.equal(provider.requests(), 1);
  assert.deepEqual(instance.status().runtime.effects.map(effect => ({
    kind: effect.kind,
    payload: effect.payload,
    routeRef: effect.routeRef,
    status: effect.status,
  })), [{
    kind: "message",
    payload: { text: "A visible message" },
    routeRef: "primary-route",
    status: "pending",
  }]);
});

test("delivers persisted Effects while cold-start model configuration is blocked", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider({
    tool: {
      name: "message",
      arguments: { action: "send", text: "Deliver after restart" },
    },
  });
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl, "primary-route");
  const now = new Date("2026-07-22T10:00:00.000Z");
  const first = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  await first.acceptInput({
    source: "test-channel",
    sourceId: "delivery-input",
    kind: "interaction",
    payload: { text: "send it" },
  });
  await first.runOnce(now);
  assert.equal(first.status().runtime.effects[0]?.status, "pending");
  first.close();

  await writeFile(path.join(root, "configuration", "instance.yaml"), [
    "version: 1",
    "interaction:",
    "  defaultRoute: primary-route",
    "models:",
    "  default:",
    "    - provider: local-test",
    "      model: missing-model",
    "",
  ].join("\n"), "utf8");
  const delivered: DeliveryAttemptRequest[] = [];
  const second = await openLoomInstance({
    root,
    machineTimeZone: "UTC",
    now: () => now,
    outboundDelivery: {
      deliver: async request => {
        delivered.push(request);
        return { status: "delivered", remoteId: "remote-1" };
      },
    },
  });
  t.after(() => second.close());

  await second.runOnce(now);

  assert.equal(second.status().models?.state, "blocked");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.routeRef, "primary-route");
  assert.equal(second.status().runtime.effects[0]?.status, "completed");
  assert.equal(second.status().runtime.deliveries[0]?.status, "delivered");
});

test("freezes idle Activity but defers Life Recorder work while models are blocked", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider(
    { text: "A private response" },
    { tool: { name: "read_activity", arguments: { offset: 0, limit: 200 } } },
    { text: "Recorded." },
  );
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl);
  let now = new Date("2026-07-22T10:00:00.000Z");
  const first = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  await first.acceptInput({
    source: "test-channel",
    sourceId: "pending-recorder-input",
    kind: "interaction",
    payload: { text: "keep this activity" },
  });
  await first.runOnce(now);
  first.close();

  await writeFile(path.join(root, "configuration", "instance.yaml"), [
    "version: 1",
    "models:",
    "  default:",
    "    - provider: local-test",
    "      model: missing-model",
    "",
  ].join("\n"), "utf8");
  now = new Date("2026-07-22T10:30:00.000Z");
  const recovered = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => recovered.close());

  assert.deepEqual(await recovered.runOnce(now), {
    disposition: "deferred",
    reason: "model_runtime_blocked",
  });
  assert.equal(provider.requests(), 1);
  assert.equal(recovered.status().runtime.activeSegment, undefined);
  assert.equal(recovered.status().runtime.activities[0]?.status, "pending");
  assert.equal(recovered.status().runtime.activities[0]?.attempts, 0);

  await writeModelConfiguration(root, provider.baseUrl);

  assert.deepEqual(await recovered.runOnce(now), { disposition: "idle" });
  assert.equal(provider.requests(), 3);
  assert.equal(recovered.status().runtime.activities[0]?.status, "recorded");
});

test("records a closed Activity through a revision-bound Life Recorder", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider(
    { text: "A private response" },
    { tool: { name: "read_activity", arguments: { offset: 0, limit: 200 } } },
    { text: "Recorded." },
  );
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl);
  let now = new Date("2026-07-22T10:00:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());
  await instance.acceptInput({
    source: "test-channel",
    sourceId: "recorded-input",
    kind: "interaction",
    payload: { text: "remember this moment" },
  });
  await instance.runOnce(now);

  now = new Date("2026-07-22T10:30:00.000Z");
  await instance.runOnce(now);

  assert.equal(provider.requests(), 3);
  assert.equal(instance.status().runtime.activeSegment, undefined);
  assert.equal(instance.status().runtime.activities[0]?.status, "recorded");
  assert.equal(instance.status().runtime.activities[0]?.receipt?.segmentId, instance.status().runtime.activities[0]?.id);
});

test("forms a proactive opening through a revision-bound Orientation", async t => {
  const root = await createInstanceRoot();
  await writeIndividualMaterials(root);
  const provider = await startOpenAiProvider(
    { tool: { name: "read", arguments: { path: "attention.md" } } },
    { text: JSON.stringify({
      outcome: "none",
      whyNow: "Nothing currently warrants an opening.",
      evidence: ["attention.md contains one quiet curiosity"],
    }) },
  );
  t.after(() => provider.close());
  await writeModelConfiguration(root, provider.baseUrl);
  const now = new Date("2026-07-22T10:00:00.000Z");
  const instance = await openLoomInstance({ root, machineTimeZone: "UTC", now: () => now });
  t.after(() => instance.close());

  const result = await instance.formOpportunity();

  assert.equal(result.disposition, "none");
  assert.equal(provider.requests(), 2);
  assert.equal(instance.status().runtime.inputs.length, 0);
});

async function createInstanceRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "loom-instance-"));
  await mkdir(path.join(root, "configuration", "pi"), { recursive: true });
  return root;
}

async function writeIndividualMaterials(root: string): Promise<void> {
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "behavior"), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "facts.json"), JSON.stringify({
      version: 1,
      individual: { name: "Rowan", languages: ["en"] },
      human: { name: "Alex", languages: ["en"] },
    }), "utf8"),
    writeFile(path.join(workspace, "identity.md"), "Rowan is a continuing AI Individual.\n", "utf8"),
    writeFile(path.join(workspace, "memory.md"), "Rowan and Alex are getting to know each other.\n", "utf8"),
    writeFile(path.join(workspace, "attention.md"), "Rowan is curious about Alex's garden.\n", "utf8"),
  ]);
}

async function writeModelConfiguration(
  root: string,
  baseUrl: string,
  defaultRoute?: string,
  thinkingLevel = "medium",
): Promise<void> {
  const configurationRoot = path.join(root, "configuration");
  await writeFile(path.join(configurationRoot, "instance.yaml"), [
    "version: 1",
    ...(defaultRoute ? ["interaction:", `  defaultRoute: ${defaultRoute}`] : []),
    "models:",
    "  default:",
    "    - provider: local-test",
    "      model: local-model",
    `      thinkingLevel: ${thinkingLevel}`,
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(configurationRoot, "pi", "models.json"), JSON.stringify({
    providers: {
      "local-test": {
        name: "Local Test",
        baseUrl,
        apiKey: "test-key",
        api: "openai-completions",
        models: [{
          id: "local-model",
          name: "Local Model",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 262_144,
          maxTokens: 16_384,
        }],
      },
    },
  }), "utf8");
}

type ProviderResponse =
  | { text: string }
  | { tool: { name: string; arguments: Record<string, unknown> } };

async function startOpenAiProvider(...providerResponses: ProviderResponse[]): Promise<{
  baseUrl: string;
  requests(): number;
  bodies(): Array<Record<string, unknown>>;
  close(): void;
}> {
  let requestCount = 0;
  const requestBodies: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      const providerResponse = providerResponses[requestCount] ?? providerResponses.at(-1);
      assert.ok(providerResponse);
      requestCount += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
      });
      const delta = "text" in providerResponse
        ? { role: "assistant", content: providerResponse.text }
        : {
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: "call-1",
              type: "function",
              function: {
                name: providerResponse.tool.name,
                arguments: JSON.stringify(providerResponse.tool.arguments),
              },
            }],
          };
      response.write(`data: ${JSON.stringify({
        id: "completion-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "local-model",
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "completion-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "local-model",
        choices: [{
          index: 0,
          delta: {},
          finish_reason: "text" in providerResponse ? "stop" : "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests: () => requestCount,
    bodies: () => structuredClone(requestBodies),
    close: () => server.close(),
  };
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function toolNames(body: Record<string, unknown>): string[] {
  const tools = body.tools;
  assert.ok(Array.isArray(tools));
  return tools.map(tool => {
    assert.ok(tool && typeof tool === "object" && "function" in tool);
    const definition = (tool as { function: unknown }).function;
    assert.ok(definition && typeof definition === "object" && "name" in definition);
    return String((definition as { name: unknown }).name);
  }).sort();
}
