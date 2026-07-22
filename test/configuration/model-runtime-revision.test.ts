import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openModelRuntimeRevisions } from "../../src/configuration/index.js";

test("builds one validated Pi runtime revision for every configured model role", async () => {
  const fixture = await createFixture();
  await writeInstanceConfiguration(fixture.instanceFile, {
    defaultProvider: "provider-a",
    defaultModel: "model-a",
    orientationProvider: "provider-b",
    orientationModel: "model-b",
  });
  await writePiModels(fixture.modelsFile, [
    { provider: "provider-a", model: "model-a" },
    { provider: "provider-b", model: "model-b" },
  ]);

  const revisions = openModelRuntimeRevisions({
    configurationFile: fixture.instanceFile,
    authPath: fixture.authFile,
    modelsPath: fixture.modelsFile,
    modelsStorePath: fixture.modelsStoreFile,
    machineTimeZone: "UTC",
    now: () => new Date("2026-07-22T08:00:00.000Z"),
  });

  const status = await revisions.refresh();
  const revision = revisions.current();
  const main = revision.selection("main-interaction");
  const orientation = revision.selection("orientation");

  assert.deepEqual(status, {
    state: "active",
    revisionId: revision.id,
    activatedAt: "2026-07-22T08:00:00.000Z",
  });
  assert.equal(main.candidates[0]?.model.provider, "provider-a");
  assert.equal(main.candidates[0]?.model.id, "model-a");
  assert.equal(main.candidates[0]?.thinkingLevel, "medium");
  assert.equal(orientation.candidates[0]?.model.provider, "provider-b");
  assert.equal(orientation.candidates[0]?.model.id, "model-b");
  assert.equal(orientation.candidates[0]?.thinkingLevel, "high");
  assert.equal(main.modelRuntime, orientation.modelRuntime);
});

test("atomically switches revisions while existing callers keep the previous Pi runtime", async () => {
  const fixture = await createFixture();
  await writePiModels(fixture.modelsFile, [
    { provider: "provider-a", model: "model-a" },
    { provider: "provider-b", model: "model-b" },
  ]);
  await writeInstanceConfiguration(fixture.instanceFile, {
    defaultProvider: "provider-a",
    defaultModel: "model-a",
    orientationProvider: "provider-a",
    orientationModel: "model-a",
  });
  let observedAt = new Date("2026-07-22T08:00:00.000Z");
  const revisions = openModelRuntimeRevisions({
    configurationFile: fixture.instanceFile,
    authPath: fixture.authFile,
    modelsPath: fixture.modelsFile,
    modelsStorePath: fixture.modelsStoreFile,
    machineTimeZone: "UTC",
    now: () => observedAt,
  });
  await revisions.refresh();
  const first = revisions.current();

  await writeInstanceConfiguration(fixture.instanceFile, {
    defaultProvider: "provider-b",
    defaultModel: "model-b",
    orientationProvider: "provider-b",
    orientationModel: "model-b",
  });
  observedAt = new Date("2026-07-22T08:05:00.000Z");
  await revisions.refresh();
  const second = revisions.current();

  assert.notEqual(second.id, first.id);
  assert.equal(first.selection("main-interaction").candidates[0]?.model.id, "model-a");
  assert.equal(second.selection("main-interaction").candidates[0]?.model.id, "model-b");
  assert.deepEqual(revisions.status(), {
    state: "active",
    revisionId: second.id,
    activatedAt: "2026-07-22T08:05:00.000Z",
  });
});

test("keeps the active revision when a changed model policy is invalid", async () => {
  const fixture = await createFixture();
  await writePiModels(fixture.modelsFile, [
    { provider: "provider-a", model: "model-a" },
  ]);
  await writeInstanceConfiguration(fixture.instanceFile, {
    defaultProvider: "provider-a",
    defaultModel: "model-a",
    orientationProvider: "provider-a",
    orientationModel: "model-a",
  });
  let observedAt = new Date("2026-07-22T08:00:00.000Z");
  const revisions = openModelRuntimeRevisions({
    configurationFile: fixture.instanceFile,
    authPath: fixture.authFile,
    modelsPath: fixture.modelsFile,
    modelsStorePath: fixture.modelsStoreFile,
    machineTimeZone: "UTC",
    now: () => observedAt,
  });
  await revisions.refresh();
  const active = revisions.current();

  await writeInstanceConfiguration(fixture.instanceFile, {
    defaultProvider: "provider-a",
    defaultModel: "missing-model",
    orientationProvider: "provider-a",
    orientationModel: "model-a",
  });
  observedAt = new Date("2026-07-22T08:05:00.000Z");
  const degraded = await revisions.refresh();
  observedAt = new Date("2026-07-22T08:10:00.000Z");
  const repeated = await revisions.refresh();

  assert.equal(revisions.current(), active);
  assert.equal(degraded.state, "degraded");
  assert.equal(degraded.revisionId, active.id);
  assert.equal(degraded.failure.kind, "model_not_found");
  assert.equal(degraded.failedAt, "2026-07-22T08:05:00.000Z");
  assert.deepEqual(repeated, degraded);
});

test("blocks cold start when a configured provider has no authentication", async () => {
  const fixture = await createFixture();
  await writeInstanceConfiguration(fixture.instanceFile, {
    defaultProvider: "provider-a",
    defaultModel: "model-a",
    orientationProvider: "provider-a",
    orientationModel: "model-a",
  });
  await writePiModels(fixture.modelsFile, [
    { provider: "provider-a", model: "model-a", authenticated: false },
  ]);
  const revisions = openModelRuntimeRevisions({
    configurationFile: fixture.instanceFile,
    authPath: fixture.authFile,
    modelsPath: fixture.modelsFile,
    modelsStorePath: fixture.modelsStoreFile,
    machineTimeZone: "UTC",
    now: () => new Date("2026-07-22T08:00:00.000Z"),
  });

  const status = await revisions.refresh();

  assert.equal(status.state, "blocked");
  assert.equal(status.failure.kind, "authentication_missing");
  assert.throws(() => revisions.current(), /Model Runtime Revision is blocked/);
});

test("classifies an invalid Pi models file without exposing its contents", async () => {
  const fixture = await createFixture();
  await writeInstanceConfiguration(fixture.instanceFile, {
    defaultProvider: "provider-a",
    defaultModel: "model-a",
    orientationProvider: "provider-a",
    orientationModel: "model-a",
  });
  await writeFile(fixture.modelsFile, "{ private malformed content", "utf8");
  const revisions = openModelRuntimeRevisions({
    configurationFile: fixture.instanceFile,
    authPath: fixture.authFile,
    modelsPath: fixture.modelsFile,
    modelsStorePath: fixture.modelsStoreFile,
    machineTimeZone: "UTC",
    now: () => new Date("2026-07-22T08:00:00.000Z"),
  });

  const status = await revisions.refresh();

  assert.equal(status.state, "blocked");
  assert.deepEqual(status.failure, {
    kind: "pi_configuration",
    message: "Pi model configuration could not establish a valid runtime",
  });
  assert.doesNotMatch(status.failure.message, /private malformed content/);
});

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "loom-model-revision-"));
  const configurationRoot = path.join(root, "configuration");
  await mkdir(configurationRoot, { recursive: true });
  return {
    instanceFile: path.join(configurationRoot, "instance.yaml"),
    authFile: path.join(configurationRoot, "auth.json"),
    modelsFile: path.join(configurationRoot, "models.json"),
    modelsStoreFile: path.join(configurationRoot, "models-store.json"),
  };
}

async function writeInstanceConfiguration(
  file: string,
  models: {
    defaultProvider: string;
    defaultModel: string;
    orientationProvider: string;
    orientationModel: string;
  },
): Promise<void> {
  await writeFile(file, [
    "version: 1",
    "models:",
    "  default:",
    `    - provider: ${models.defaultProvider}`,
    `      model: ${models.defaultModel}`,
    "      thinkingLevel: medium",
    "  orientation:",
    `    - provider: ${models.orientationProvider}`,
    `      model: ${models.orientationModel}`,
    "      thinkingLevel: high",
    "",
  ].join("\n"), "utf8");
}

async function writePiModels(
  file: string,
  models: Array<{ provider: string; model: string; authenticated?: boolean }>,
): Promise<void> {
  await writeFile(file, JSON.stringify({
    providers: Object.fromEntries(models.map(({ provider, model, authenticated = true }) => [provider, {
      name: provider,
      baseUrl: "http://localhost:1/v1",
      ...(authenticated ? { apiKey: "test-key" } : {}),
      api: "openai-completions",
      models: [{
        id: model,
        name: model,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000,
        maxTokens: 4_000,
      }],
    }])),
  }, null, 2), "utf8");
}
