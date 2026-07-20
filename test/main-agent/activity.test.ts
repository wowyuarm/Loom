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
  assert.equal(successor.frozenSeed.length, 3);
  const bridge = JSON.stringify(successor.frozenSeed);
  assert.match(bridge, /Recent Daily Narrative/);
  assert.match(bridge, /older pending activity/);
  assert.match(bridge, /<recent_activity>/);
  assert.match(bridge, /past evidence, not a new request/);
  assert.match(bridge, /human input.*Please check the plan/);
  assert.match(bridge, /individual output \(not known delivered\).*I will inspect it/);
  assert.match(bridge, /system event.*turn_stopped.*failed/);
  assert.match(bridge, /delivery delivered/);
  assert.doesNotMatch(bridge, /private chain of thought/);
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

function request(): ActivityFreezeRequest {
  const starting = serializeContextWindowState({
    version: 1,
    id: "window-1",
    frozenSeed: [],
    committedTrace: [],
    transcriptAnchor: { sessionId: "session-1", entryId: "before-segment" },
  });
  const current = serializeContextWindowState({
    version: 1,
    id: "window-1",
    frozenSeed: [],
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
    pendingActivities: [{
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
