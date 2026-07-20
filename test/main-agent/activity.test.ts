import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createMainAgentActivityLifecycle } from "../../src/main-agent/activity.js";
import {
  serializeContextWindowState,
  type ContextWindowState,
} from "../../src/main-agent/context.js";
import { createExpandTool } from "../../src/main-agent/tool-trace.js";
import type { ActivityFreezeRequest } from "../../src/runtime/index.js";

test("freezes verified transcript and Runtime evidence into a successor Context", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-main-agent-activity-"));
  const transcriptFile = path.join(root, "agent.jsonl");
  await writeFile(transcriptFile, transcript(root), "utf8");
  const lifecycle = createMainAgentActivityLifecycle({
    transcriptFile,
    nextWindowId: () => "window-2",
    loadWindowFrozen: async () => [{
      role: "user",
      content: [{ type: "text", text: "Recent Daily Narrative." }],
      timestamp: 0,
    }],
  });

  const result = await lifecycle.freeze(request());

  assert.deepEqual(result.activity.events.map(event => [event.actorRef, event.kind]), [
    ["human", "input"],
    ["individual", "thinking"],
    ["individual", "output"],
    ["individual", "tool_call"],
    ["system", "tool_result"],
    ["individual", "output"],
    ["human", "input"],
    ["system", "system"],
    ["individual", "effect"],
    ["system", "delivery"],
  ]);
  assert.deepEqual(result.activity.transcriptAnchors, [
    { sessionId: "session-1", entryId: "assistant-final" },
  ]);

  const successor = result.successorExecutionState as unknown as ContextWindowState;
  assert.equal(successor.id, "window-2");
  assert.deepEqual(successor.committedTrace, []);
  assert.deepEqual(successor.transcriptAnchor, {
    sessionId: "session-1",
    entryId: "assistant-final",
  });
  assert.equal(successor.frozenSeed.length, 2);
  const bridge = JSON.stringify(successor.frozenSeed);
  assert.match(bridge, /Recent Daily Narrative/);
  assert.match(bridge, /older pending activity/);
  assert.match(bridge, /<recent_activity>/);
  assert.match(bridge, /past activity evidence.*not a new request/);
  assert.match(bridge, /human input.*Please check the plan/);
  assert.match(bridge, /individual output \(not known delivered\).*I will inspect it/);
  assert.match(bridge, /system event.*turn_stopped.*failed/);
  assert.match(bridge, /delivery delivered/);
  assert.doesNotMatch(bridge, /private chain of thought/);
  const bridgeReferences = (successor as ContextWindowState & {
    recentActivityReferences?: string[];
  }).recentActivityReferences;
  assert.equal(bridgeReferences?.length, 1);
  assert.match(bridge, new RegExp(`reference: ${bridgeReferences![0]}`));

  const expansion = await createExpandTool({
    window: successor,
    transcriptFile,
  }).execute(
    "expand-bridge",
    { reference: bridgeReferences![0]!, offset: 0 },
    undefined,
    undefined,
    {} as never,
  );
  assert.match(JSON.stringify(expansion.content), /plan\.md/);
  assert.match(JSON.stringify(expansion.content), /Plan contents/);
});

test("rejects a closing state that is not anchored to the last completed Turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-main-agent-activity-anchor-"));
  const transcriptFile = path.join(root, "agent.jsonl");
  await writeFile(transcriptFile, transcript(root), "utf8");
  const lifecycle = createMainAgentActivityLifecycle({ transcriptFile });
  const invalid = request();
  invalid.executionState = serializeContextWindowState({
    ...(invalid.executionState as unknown as ContextWindowState),
    transcriptAnchor: { sessionId: "session-1", entryId: "tool-result" },
  });

  await assert.rejects(
    lifecycle.freeze(invalid),
    /does not match the last completed Turn/i,
  );
});

test("preserves only verified tool pairs from a failed Turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-main-agent-failed-tools-"));
  const transcriptFile = path.join(root, "agent.jsonl");
  await writeFile(transcriptFile, transcript(root), "utf8");
  const lifecycle = createMainAgentActivityLifecycle({ transcriptFile });
  const value = request();
  value.turns = [{
    id: "turn-failed",
    inputIds: ["input-1"],
    status: "failed",
    startedAt: "2026-07-19T10:00:00.500Z",
    endedAt: "2026-07-19T10:00:05.000Z",
    error: "provider stopped after tool activity",
  }];
  value.executionState = value.startingExecutionState!;
  value.toolActivities = [{
    turnId: "turn-failed",
    toolCallId: "tool-complete",
    toolName: "edit",
    callArguments: { path: "threads/private.md" },
    result: { content: [{ type: "text", text: "changed" }] },
    completedAt: "2026-07-19T10:00:04.000Z",
  }];
  value.effects = [];
  value.deliveries = [];

  const { activity } = await lifecycle.freeze(value);
  const toolEvents = activity.events.filter(event => event.kind === "tool_call" || event.kind === "tool_result");

  assert.equal(toolEvents.length, 2);
  assert.equal(toolEvents[0]?.eventId, "tool-call:turn-failed:tool-complete");
  assert.equal(toolEvents[1]?.eventId, "tool-result:turn-failed:tool-complete");
  assert.match(JSON.stringify(toolEvents), /threads\/private\.md/);
  assert.match(JSON.stringify(toolEvents), /changed/);
  assert.equal(activity.events.filter(event => event.kind === "thinking" || event.kind === "output").length, 0);
  assert.equal(activity.events.at(-1)?.kind, "system");
});

test("fixes the latest four Activities into one chronological recent bridge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-main-agent-activity-recent-"));
  const transcriptFile = path.join(root, "agent.jsonl");
  await writeFile(transcriptFile, transcript(root), "utf8");
  const lifecycle = createMainAgentActivityLifecycle({
    transcriptFile,
    nextWindowId: () => "window-2",
  });
  const closing = request();
  closing.recentActivities = [
    historicalActivity(0),
    historicalActivity(1),
    historicalActivity(2),
    historicalActivity(3),
    historicalActivity(4),
  ];

  const result = await lifecycle.freeze(closing);
  const successor = result.successorExecutionState as unknown as ContextWindowState;
  const bridge = JSON.stringify(successor.frozenSeed);

  assert.equal(successor.frozenSeed.length, 1);
  assert.doesNotMatch(bridge, /historical activity 0/);
  assert.doesNotMatch(bridge, /historical activity 1/);
  const positions = [2, 3, 4].map(index => bridge.indexOf(`historical activity ${index}`));
  assert.ok(positions.every(position => position >= 0));
  assert.ok(positions[0]! < positions[1]! && positions[1]! < positions[2]!);
  assert.ok(positions[2]! < bridge.indexOf("Please check the plan"));
});

test("bounds recent bridge previews without splitting tool interactions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-main-agent-activity-bounded-"));
  const transcriptFile = path.join(root, "agent.jsonl");
  await writeFile(transcriptFile, transcript(root), "utf8");
  const lifecycle = createMainAgentActivityLifecycle({ transcriptFile });
  const closing = request();
  closing.recentActivities = [denseBridgeActivity()];

  const result = await lifecycle.freeze(closing);
  const successor = result.successorExecutionState as unknown as ContextWindowState;
  const bridge = JSON.stringify(successor.frozenSeed);

  assert.match(bridge, /human input remains complete .*human-tail/);
  assert.match(bridge, /individual output.*output-head/);
  assert.doesNotMatch(bridge, /output-tail/);
  assert.doesNotMatch(bridge, /system-tail/);
  assert.doesNotMatch(bridge, /orphan-tool-call/);

  let includedPairs = 0;
  for (let index = 0; index < 12; index += 1) {
    const hasCall = bridge.includes(`tool-call-${index}`);
    const hasResult = bridge.includes(`tool-result-${index}`);
    assert.equal(hasCall, hasResult, `tool pair ${index} must be kept or dropped together`);
    if (hasCall) includedPairs += 1;
  }
  assert.ok(includedPairs > 0);
  assert.ok(includedPairs < 12);
  assert.equal(
    (bridge.match(/reference: loom-tool-interaction/g) ?? []).length,
    successor.recentActivityReferences.length,
  );
});

function request(): ActivityFreezeRequest {
  const starting = serializeContextWindowState({
    version: 1,
    id: "window-1",
    frozenSeed: [],
    recentActivityReferences: [],
    committedTrace: [],
    transcriptAnchor: { sessionId: "session-1", entryId: "before-segment" },
  });
  const current = serializeContextWindowState({
    version: 1,
    id: "window-1",
    frozenSeed: [],
    recentActivityReferences: [],
    committedTrace: [],
    transcriptAnchor: { sessionId: "session-1", entryId: "assistant-final" },
  });
  return {
    segment: {
      id: "segment-1",
      openedAt: "2026-07-19T10:00:00.000Z",
      closedAt: "2026-07-19T10:04:00.000Z",
      recordingDay: "2026-07-19",
    },
    recentActivities: [{
      version: 1,
      segmentId: "segment-0",
      recordingDay: "2026-07-19",
      openedAt: "2026-07-19T09:50:00.000Z",
      closedAt: "2026-07-19T09:55:00.000Z",
      events: [{
        eventId: "input:older",
        at: "2026-07-19T09:50:00.000Z",
        actorRef: "human",
        kind: "input",
        content: { text: "older pending activity" },
      }],
      transcriptAnchors: [],
    }],
    startingExecutionState: starting,
    executionState: current,
    inputs: [
      {
        id: "input-1",
        kind: "interaction",
        payload: { text: "Please check the plan." },
        occurredAt: "2026-07-19T10:00:00.000Z",
      },
      {
        id: "input-2",
        kind: "interaction",
        payload: { text: "One more detail." },
        occurredAt: "2026-07-19T10:00:04.200Z",
      },
    ],
    turns: [
      {
        id: "turn-1",
        inputIds: ["input-1"],
        status: "completed",
        startedAt: "2026-07-19T10:00:00.500Z",
        endedAt: "2026-07-19T10:00:05.000Z",
        transcriptAnchor: { sessionId: "session-1", entryId: "assistant-final" },
        executionRecord: { version: 1 },
      },
      {
        id: "turn-2",
        inputIds: ["input-2"],
        status: "failed",
        startedAt: "2026-07-19T10:00:04.200Z",
        endedAt: "2026-07-19T10:00:05.500Z",
        error: "provider failed after accepting input",
      },
    ],
    toolActivities: [],
    effects: [{
      id: "effect-1",
      turnId: "turn-1",
      kind: "message",
      payload: { text: "The plan is sound." },
      routeRef: "primary",
      createdAt: "2026-07-19T10:00:06.000Z",
      endedAt: "2026-07-19T10:00:07.000Z",
      status: "completed",
    }],
    deliveries: [{
      id: "delivery-1",
      effectId: "effect-1",
      attempt: 1,
      status: "delivered",
      startedAt: "2026-07-19T10:00:06.500Z",
      endedAt: "2026-07-19T10:00:07.000Z",
      remoteId: "remote-1",
    }],
  };
}

function historicalActivity(index: number): ActivityFreezeRequest["recentActivities"][number] {
  const minute = String(50 + index).padStart(2, "0");
  return {
    version: 1,
    segmentId: `segment-history-${index}`,
    recordingDay: "2026-07-19",
    openedAt: `2026-07-19T09:${minute}:00.000Z`,
    closedAt: `2026-07-19T09:${minute}:30.000Z`,
    events: [{
      eventId: `input:history-${index}`,
      at: `2026-07-19T09:${minute}:00.000Z`,
      actorRef: "human",
      kind: "input",
      content: { text: `historical activity ${index}` },
    }],
    transcriptAnchors: [],
  };
}

function denseBridgeActivity(): ActivityFreezeRequest["recentActivities"][number] {
  const events: ActivityFreezeRequest["recentActivities"][number]["events"] = [{
    eventId: "input:dense",
    at: "2026-07-19T09:40:00.000Z",
    actorRef: "human",
    kind: "input",
    content: { text: `human input remains complete ${"h".repeat(260)} human-tail` },
  }, {
    eventId: "transcript:output-dense",
    at: "2026-07-19T09:40:01.000Z",
    actorRef: "individual",
    kind: "output",
    content: { type: "text", text: `output-head ${"o".repeat(260)} output-tail` },
  }, {
    eventId: "turn:stopped-dense",
    at: "2026-07-19T09:40:02.000Z",
    actorRef: "system",
    kind: "system",
    content: { type: "turn_stopped", error: `system-head ${"s".repeat(260)} system-tail` },
  }];
  for (let index = 0; index < 12; index += 1) {
    events.push({
      eventId: `transcript:call-${index}`,
      at: `2026-07-19T09:41:${String(index * 2).padStart(2, "0")}.000Z`,
      actorRef: "individual",
      kind: "tool_call",
      content: {
        type: "toolCall",
        id: `pair-${index}`,
        name: "lookup",
        arguments: { query: `tool-call-${index} ${"a".repeat(300)}` },
      },
    }, {
      eventId: `transcript:result-${index}`,
      at: `2026-07-19T09:41:${String(index * 2 + 1).padStart(2, "0")}.000Z`,
      actorRef: "system",
      kind: "tool_result",
      content: {
        toolCallId: `pair-${index}`,
        toolName: "lookup",
        isError: false,
        content: [{ type: "text", text: `tool-result-${index} ${"r".repeat(300)}` }],
      },
    });
  }
  events.push({
    eventId: "transcript:orphan-call",
    at: "2026-07-19T09:42:00.000Z",
    actorRef: "individual",
    kind: "tool_call",
    content: {
      type: "toolCall",
      id: "orphan",
      name: "lookup",
      arguments: { query: "orphan-tool-call" },
    },
  });
  return {
    version: 1,
    segmentId: "segment-dense",
    recordingDay: "2026-07-19",
    openedAt: "2026-07-19T09:40:00.000Z",
    closedAt: "2026-07-19T09:45:00.000Z",
    events,
    transcriptAnchors: [{ sessionId: "session-dense", entryId: "dense-end" }],
  };
}

function transcript(root: string): string {
  return [
    { type: "session", version: 3, id: "session-1", timestamp: "2026-07-19T09:00:00.000Z", cwd: root },
    {
      type: "message",
      id: "before-segment",
      parentId: null,
      timestamp: "2026-07-19T09:59:59.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Earlier activity." }], timestamp: 1 },
    },
    {
      type: "custom",
      customType: "loom.input.v1",
      data: {
        version: 1,
        turnId: "turn-1",
        inputId: "input-1",
        inclusionPosition: 1,
        kind: "interaction",
        occurredAt: "2026-07-19T10:00:00.000Z",
        payload: { text: "Please check the plan." },
      },
      id: "annotation-1",
      parentId: "before-segment",
      timestamp: "2026-07-19T10:00:01.000Z",
    },
    {
      type: "message",
      id: "user-1",
      parentId: "annotation-1",
      timestamp: "2026-07-19T10:00:01.100Z",
      message: { role: "user", content: [{ type: "text", text: "Please check the plan." }], timestamp: 2 },
    },
    {
      type: "message",
      id: "assistant-tool",
      parentId: "user-1",
      timestamp: "2026-07-19T10:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private chain of thought" },
          { type: "text", text: "I will inspect it." },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "plan.md" } },
        ],
        stopReason: "toolUse",
        timestamp: 3,
      },
    },
    {
      type: "message",
      id: "tool-result",
      parentId: "assistant-tool",
      timestamp: "2026-07-19T10:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "Plan contents" }],
        isError: false,
        timestamp: 4,
      },
    },
    {
      type: "message",
      id: "assistant-final",
      parentId: "tool-result",
      timestamp: "2026-07-19T10:00:04.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "The plan looks sound." }], timestamp: 5 },
    },
    "",
  ].map(record => typeof record === "string" ? record : JSON.stringify(record)).join("\n");
}
