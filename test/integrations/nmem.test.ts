import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createNmemEpisodeReconciler, createNmemRecallTool } from "../../src/integrations/nmem/index.js";
import type { NmemRecallDetails } from "../../src/integrations/nmem/index.js";
import { openRuntime } from "../../src/runtime/index.js";
import type {
  ActivityLifecycle,
  ActivityRecorder,
  AgentExecution,
  FrozenActivity,
  RunningExecution,
} from "../../src/runtime/index.js";
import { AgentWorkspace } from "../../src/workspace/agent-workspace.js";

test("imports only an Episode authorized by a durable Life Recorder Receipt", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-nmem-episode-"));
  const workspaceRoot = path.join(root, "workspace");
  const runtimeRoot = path.join(root, "runtime");
  const episode = {
    id: "episode-stable-1",
    path: "episodes/2026-07-21/episode-stable-1.md",
    content: [
      "---",
      "version: 1",
      'id: "episode-stable-1"',
      'segmentId: "segment-1"',
      "ordinal: 0",
      'occurredAt: "2026-07-21T09:00:00.000Z"',
      "importance: 0.82",
      'labels: ["shared-plan", "trust"]',
      'evidenceEventIds: ["event-1"]',
      "---",
      "",
      "# A plan became mutual",
      "",
      "The two participants revised the plan together and kept the exact disagreement.",
      "",
    ].join("\n"),
  };
  const orphanPath = path.join(workspaceRoot, "episodes", "2026-07-21", "orphan.md");
  await mkdir(path.dirname(orphanPath), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspaceRoot, episode.path), episode.content, "utf8"),
    writeFile(orphanPath, "# not committed\n", "utf8"),
  ]);

  const runtime = openRuntime({
    root: runtimeRoot,
    execution: completedExecution(),
    activityLifecycle: lifecycle(),
    activityRecorder: recorder(episode),
    nextId: ids("input-1", "turn-1", "segment-1", "activity-attempt-1"),
    now: () => new Date("2026-07-21T09:05:00.000Z"),
  });
  t.after(() => runtime.close());
  await runtime.acceptInput({
    source: "test",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "revisit the plan" },
    occurredAt: "2026-07-21T09:00:00.000Z",
  });
  assert.deepEqual(await runtime.advance(), { disposition: "turn_completed" });
  assert.equal((await runtime.closeActivity()).disposition, "activity_frozen");
  assert.deepEqual(await runtime.advance(), { disposition: "activity_recorded" });

  const requests: Array<{ path: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/capabilities") {
      json(response, 200, { version: "0.10.31", features: { memories: true, search: true } });
      return;
    }
    if (request.url === "/memories" && request.method === "POST") {
      requests.push({ path: request.url, body: await readJson(request) });
      json(response, 200, { memory: { id: episode.id }, created: true });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const reconciler = createNmemEpisodeReconciler({
    runtime,
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    stateRoot: runtimeRoot,
    endpoint: `http://127.0.0.1:${address.port}`,
    now: () => new Date("2026-07-21T09:06:00.000Z"),
  });

  assert.deepEqual(await reconciler.reconcile(), {
    imported: 1,
    current: 0,
    pending: 0,
    blocked: 0,
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    path: "/memories",
    body: {
      id: episode.id,
      title: "A plan became mutual",
      content: "The two participants revised the plan together and kept the exact disagreement.",
      source: "loom-episode",
      importance: 0.82,
      labels: ["shared-plan", "trust"],
      event_start: "2026-07-21",
      temporal_context: "past",
      unit_type: "event",
      metadata: {
        loom_episode_id: episode.id,
        loom_segment_id: "segment-1",
        loom_workspace_path: episode.path,
      },
    },
  });

  assert.deepEqual(await reconciler.reconcile(), {
    imported: 0,
    current: 1,
    pending: 0,
    blocked: 0,
  });
  reconciler.close();
  const recovered = createNmemEpisodeReconciler({
    runtime,
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    stateRoot: runtimeRoot,
    endpoint: `http://127.0.0.1:${address.port}`,
    now: () => new Date("2026-07-21T09:07:00.000Z"),
  });
  t.after(() => recovered.close());
  assert.deepEqual(await recovered.reconcile(), {
    imported: 0,
    current: 1,
    pending: 0,
    blocked: 0,
  });
  assert.equal(requests.length, 1);
});

test("retains a failed Episode import and retries it after restart and backoff", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-nmem-retry-"));
  const episode = {
    id: "episode-retry-1",
    path: "episodes/2026-07-21/episode-retry-1.md",
    content: [
      "---",
      "version: 1",
      'id: "episode-retry-1"',
      'segmentId: "segment-retry"',
      "ordinal: 0",
      'occurredAt: "2026-07-21T10:00:00.000Z"',
      "importance: 0.7",
      'labels: ["repair"]',
      'evidenceEventIds: ["event-retry"]',
      "---",
      "",
      "# A retry kept its identity",
      "",
      "The local scene remained available while the external service recovered.",
      "",
    ].join("\n"),
  };
  const fixture = await recordedRuntimeFixture(root, episode);
  t.after(() => fixture.runtime.close());
  let memoryAttempts = 0;
  let capabilityAttempts = 0;
  let fail = true;
  const server = createServer(async (request, response) => {
    if (request.url === "/capabilities") {
      capabilityAttempts++;
      json(response, 200, { version: "0.10.31", features: { memories: true, search: true } });
      return;
    }
    if (request.url === "/memories" && request.method === "POST") {
      memoryAttempts++;
      await readJson(request);
      if (fail) {
        json(response, 503, { error: "temporarily unavailable" });
      } else {
        json(response, 200, { memory: { id: episode.id }, action: "created" });
      }
      return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let now = new Date("2026-07-21T10:06:00.000Z");
  const options = {
    runtime: fixture.runtime,
    agentWorkspace: new AgentWorkspace(fixture.workspaceRoot),
    stateRoot: fixture.runtimeRoot,
    endpoint: `http://127.0.0.1:${address.port}`,
    now: () => now,
  };
  const first = createNmemEpisodeReconciler(options);

  assert.deepEqual(await first.reconcile(), {
    imported: 0,
    current: 0,
    pending: 1,
    blocked: 0,
  });
  assert.deepEqual(await first.reconcile(), {
    imported: 0,
    current: 0,
    pending: 1,
    blocked: 0,
  });
  assert.equal(memoryAttempts, 1);
  assert.equal(capabilityAttempts, 1);
  first.close();

  fail = false;
  now = new Date("2026-07-21T10:06:31.000Z");
  const recovered = createNmemEpisodeReconciler(options);
  t.after(() => recovered.close());
  assert.deepEqual(await recovered.reconcile(), {
    imported: 1,
    current: 0,
    pending: 0,
    blocked: 0,
  });
  assert.equal(memoryAttempts, 2);
  assert.equal(capabilityAttempts, 2);
});

test("does no external work while nmem is unconfigured and imports after configuration", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-nmem-unconfigured-"));
  const episode = {
    id: "episode-config-1",
    path: "episodes/2026-07-21/episode-config-1.md",
    content: [
      "---",
      "version: 1",
      'id: "episode-config-1"',
      'segmentId: "segment-config"',
      "ordinal: 0",
      'occurredAt: "2026-07-21T11:00:00+08:00"',
      "importance: 0.65",
      "labels: []",
      'evidenceEventIds: ["event-config"]',
      "---",
      "",
      "# Configuration arrived later",
      "",
      "The local Episode existed before the external Integration was configured.",
      "",
    ].join("\n"),
  };
  const fixture = await recordedRuntimeFixture(root, episode);
  t.after(() => fixture.runtime.close());
  const unconfigured = createNmemEpisodeReconciler({
    runtime: fixture.runtime,
    agentWorkspace: new AgentWorkspace(fixture.workspaceRoot),
    stateRoot: fixture.runtimeRoot,
  });
  assert.deepEqual(await unconfigured.reconcile(), {
    imported: 0,
    current: 0,
    pending: 0,
    blocked: 1,
  });
  unconfigured.close();

  let requestBody: unknown;
  const server = createServer(async (request, response) => {
    if (request.url === "/capabilities") {
      json(response, 200, { version: "0.10.31", features: { memories: true } });
      return;
    }
    if (request.url === "/memories") {
      requestBody = await readJson(request);
      json(response, 200, { memory: { id: episode.id } });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const configured = createNmemEpisodeReconciler({
    runtime: fixture.runtime,
    agentWorkspace: new AgentWorkspace(fixture.workspaceRoot),
    stateRoot: fixture.runtimeRoot,
    endpoint: `http://127.0.0.1:${address.port}`,
  });
  t.after(() => configured.close());

  assert.equal((await configured.reconcile()).imported, 1);
  assert.equal((requestBody as { event_start?: unknown }).event_start, "2026-07-21");
});

test("reports a missing committed Episode without interrupting local continuity", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-nmem-missing-"));
  const episode = {
    id: "episode-missing-1",
    path: "episodes/2026-07-21/episode-missing-1.md",
    content: [
      "---",
      'id: "episode-missing-1"',
      'segmentId: "segment-missing"',
      'occurredAt: "2026-07-21T11:30:00.000Z"',
      "importance: 0.6",
      "labels: []",
      "---",
      "# Missing later",
      "The file is removed after its Receipt is committed.",
    ].join("\n"),
  };
  const fixture = await recordedRuntimeFixture(root, episode);
  t.after(() => fixture.runtime.close());
  await rm(path.join(fixture.workspaceRoot, episode.path));
  const reconciler = createNmemEpisodeReconciler({
    runtime: fixture.runtime,
    agentWorkspace: new AgentWorkspace(fixture.workspaceRoot),
    stateRoot: fixture.runtimeRoot,
  });
  t.after(() => reconciler.close());

  assert.deepEqual(await reconciler.reconcile(), {
    imported: 0,
    current: 0,
    pending: 0,
    blocked: 1,
  });
  assert.equal(fixture.runtime.status().activities[0]?.status, "recorded");
});

test("does not follow a committed Episode path outside the Agent Workspace", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-nmem-symlink-"));
  const episode = {
    id: "episode-symlink-1",
    path: "episodes/2026-07-21/episode-symlink-1.md",
    content: [
      "---",
      'id: "episode-symlink-1"',
      'segmentId: "segment-symlink"',
      'occurredAt: "2026-07-21T12:00:00.000Z"',
      "importance: 0.6",
      "labels: []",
      "---",
      "# Original",
      "This was originally inside the Workspace.",
    ].join("\n"),
  };
  const fixture = await recordedRuntimeFixture(root, episode);
  t.after(() => fixture.runtime.close());
  const episodeFile = path.join(fixture.workspaceRoot, episode.path);
  const outside = path.join(root, "outside-episode.md");
  await Promise.all([rm(episodeFile), writeFile(outside, episode.content, "utf8")]);
  await symlink(outside, episodeFile);
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    json(response, 200, { version: "0.10.31", features: { memories: true } });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const reconciler = createNmemEpisodeReconciler({
    runtime: fixture.runtime,
    agentWorkspace: new AgentWorkspace(fixture.workspaceRoot),
    stateRoot: fixture.runtimeRoot,
    endpoint: `http://127.0.0.1:${address.port}`,
  });
  t.after(() => reconciler.close());

  assert.equal((await reconciler.reconcile()).blocked, 1);
  assert.equal(requests, 0);
});

test("returns bounded nmem Memory evidence through explicit recall", async t => {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/capabilities") {
      json(response, 200, { version: "0.10.31", features: { memories: true, search: true } });
      return;
    }
    if (request.url === "/memories/search" && request.method === "POST") {
      requests.push(await readJson(request));
      json(response, 200, [{
        memory: {
          id: "memory-1",
          title: "A repaired misunderstanding",
          content: "They corrected who had made the decision and preserved the correction.",
          source: "loom-episode",
          created_at: "2026-07-18T12:00:00.000Z",
          event_start: "2026-07-18",
          unit_type: "event",
          metadata: { loom_episode_id: "episode-1" },
        },
        similarity_score: 0.91,
        relevance_reason: "Directly concerns the corrected attribution.",
        related_entities: [],
      }]);
      return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const tool = createNmemRecallTool({ endpoint: `http://127.0.0.1:${address.port}` });

  const result = await tool.execute("recall-1", {
    query: "who made that decision",
    limit: 4,
  }, undefined, undefined, undefined as never);

  assert.deepEqual(requests, [{
    query: "who made that decision",
    limit: 4,
    include_entities: false,
    mode: "fast",
  }]);
  assert.deepEqual(result.details, {
    type: "loom.nmem-recall",
    version: 1,
    status: "available",
    query: "who made that decision",
    results: [{
      reference: "nmem:memory:memory-1",
      title: "A repaired misunderstanding",
      content: "They corrected who had made the decision and preserved the correction.",
      relevance: 0.91,
      relevanceReason: "Directly concerns the corrected attribution.",
      source: "loom-episode",
      eventDate: "2026-07-18",
      recordedAt: "2026-07-18T12:00:00.000Z",
      unitType: "event",
      metadata: { loom_episode_id: "episode-1" },
    }],
  });
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /external historical evidence/i);
});

test("keeps recall failure-soft when nmem is absent or degraded", async t => {
  const unconfigured = createNmemRecallTool({});
  const absent = await executeRecall(unconfigured, "older context");
  assert.deepEqual(absent.details, {
    type: "loom.nmem-recall",
    version: 1,
    status: "unavailable",
    query: "older context",
    results: [],
    reason: "not_configured",
  });

  let mode: "empty" | "timeout" | "auth" | "incompatible" = "empty";
  const server = createServer(async (request, response) => {
    if (mode === "timeout") return;
    if (mode === "auth") {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.url === "/capabilities") {
      json(response, 200, mode === "incompatible"
        ? { version: "unknown", features: {} }
        : { version: "0.10.31", features: { memories: true, search: true } });
      return;
    }
    if (request.url === "/memories/search") {
      json(response, 200, []);
      return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const tool = createNmemRecallTool({
    endpoint: `http://127.0.0.1:${address.port}`,
    timeoutMs: 20,
  });

  const empty = await executeRecall(tool, "nothing matches");
  assert.equal(empty.details.status, "available");
  assert.deepEqual(empty.details.results, []);

  for (const [failureMode, reason] of [
    ["timeout", "temporary"],
    ["auth", "authentication"],
    ["incompatible", "incompatible"],
  ] as const) {
    mode = failureMode;
    const degraded = await executeRecall(tool, `failure ${failureMode}`);
    assert.equal(degraded.details.status, "unavailable");
    assert.equal(degraded.details.reason, reason);
    assert.deepEqual(degraded.details.results, []);
    assert.match(
      degraded.content[0]?.type === "text" ? degraded.content[0].text : "",
      /continue the current turn/i,
    );
  }
});

test("bounds content returned by recall and marks truncation", async () => {
  const longContent = "x".repeat(5_000);
  const tool = createNmemRecallTool({
    endpoint: "http://nmem.test",
    fetch: async input => {
      const resource = String(input);
      if (resource.endsWith("/capabilities")) {
        return Response.json({ features: { memories: true, search: true } });
      }
      return Response.json([{
        memory: {
          id: "memory-long",
          content: longContent,
          metadata: { useful: "kept", nested: { ignored: true } },
        },
        similarity_score: 0.8,
        related_entities: [],
      }]);
    },
  });

  const result = await executeRecall(tool, "large old memory");
  assert.equal(result.details.results[0]?.content.length, 4_000);
  assert.equal(result.details.results[0]?.contentTruncated, true);
  assert.deepEqual(result.details.results[0]?.metadata, { useful: "kept" });
});

function completedExecution(): AgentExecution {
  return {
    start(request, control): RunningExecution {
      for (const input of request.inputs) control.includeInput(input.id);
      control.prepareExecutionState({ version: 1, windowId: "window-1" });
      return {
        result: Promise.resolve({
          outcome: "completed",
          inputAnchors: request.inputs.map(input => ({
            inputId: input.id,
            transcriptAnchor: { sourceId: "2026-07-19", sessionId: "session-1", entryId: `entry-${input.id}` },
          })),
          transcriptAnchor: { sourceId: "2026-07-19", sessionId: "session-1", entryId: "entry-final" },
          executionState: { version: 1, windowId: "window-1" },
          executionRecord: { messages: [] },
        }),
        steer: async () => {},
        abort: async () => {},
      };
    },
  };
}

function lifecycle(): ActivityLifecycle {
  return {
    freeze: async request => ({
      activity: {
        version: 1,
        segmentId: request.segment.id,
        recordingDay: request.segment.recordingDay,
        openedAt: request.segment.openedAt,
        closedAt: request.segment.closedAt,
        events: [],
        turns: request.turns.map(turn => ({
          turnId: turn.id,
          startedAt: turn.startedAt,
          endedAt: turn.endedAt,
          status: turn.status,
          ...(turn.transcriptAnchor ? { transcriptAnchor: turn.transcriptAnchor } : {}),
        })),
      },
      successorExecutionState: { version: 1, windowId: "window-2" },
    }),
  };
}

function recorder(episode: { id: string; path: string }): ActivityRecorder {
  return {
    record: async (activity: FrozenActivity) => ({
      version: 1,
      segmentId: activity.segmentId,
      runId: "recorder-run-1",
      recordedAt: "2026-07-21T09:05:00.000Z",
      daily: { status: "no_change", path: "daily/2026-07-21.md" },
      episodes: [{ id: episode.id, path: episode.path }],
    }),
  };
}

async function recordedRuntimeFixture(
  root: string,
  episode: { id: string; path: string; content: string },
) {
  const workspaceRoot = path.join(root, "workspace");
  const runtimeRoot = path.join(root, "runtime");
  const episodeFile = path.join(workspaceRoot, episode.path);
  await mkdir(path.dirname(episodeFile), { recursive: true });
  await writeFile(episodeFile, episode.content, "utf8");
  const runtime = openRuntime({
    root: runtimeRoot,
    execution: completedExecution(),
    activityLifecycle: lifecycle(),
    activityRecorder: recorder(episode),
    nextId: ids("input-retry", "turn-retry", "segment-retry", "activity-attempt-retry"),
    now: () => new Date("2026-07-21T10:05:00.000Z"),
  });
  await runtime.acceptInput({
    source: "test",
    sourceId: "message-retry",
    kind: "interaction",
    payload: { text: "record a retryable episode" },
    occurredAt: "2026-07-21T10:00:00.000Z",
  });
  assert.deepEqual(await runtime.advance(), { disposition: "turn_completed" });
  assert.equal((await runtime.closeActivity()).disposition, "activity_frozen");
  assert.deepEqual(await runtime.advance(), { disposition: "activity_recorded" });
  return { runtime, workspaceRoot, runtimeRoot };
}

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function executeRecall(tool: ReturnType<typeof createNmemRecallTool>, query: string) {
  const result = await tool.execute("recall-test", { query }, undefined, undefined, undefined as never);
  return result as typeof result & { details: NmemRecallDetails };
}
