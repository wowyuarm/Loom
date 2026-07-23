import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
import { AgentWorkspace } from "../../src/workspace/agent-workspace.js";

test("freezes verified transcript and Runtime evidence into a successor Context", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-main-agent-activity-"));
  const { transcriptDirectory, transcriptFile } = await writePrimaryTranscript(root, transcript(root));
  const lifecycle = createMainAgentActivityLifecycle({
    agentWorkspace: new AgentWorkspace(path.join(root, "workspace")),
    transcriptDirectory,
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
  assert.deepEqual(result.activity.events.map(event => event.turnId), [
    "turn-1",
    "turn-1",
    "turn-1",
    "turn-1",
    "turn-1",
    "turn-1",
    "turn-2",
    "turn-2",
    "turn-1",
    "turn-1",
  ]);
  assert.deepEqual(result.activity.turns, [
    {
      turnId: "turn-1",
      startedAt: "2026-07-19T10:00:00.500Z",
      endedAt: "2026-07-19T10:00:05.000Z",
      status: "completed",
      transcriptAnchor: { sourceId: "2026-07-19", sessionId: "session-1", entryId: "assistant-final" },
    },
    {
      turnId: "turn-2",
      startedAt: "2026-07-19T10:00:04.200Z",
      endedAt: "2026-07-19T10:00:05.500Z",
      status: "failed",
    },
  ]);

  const successor = result.successorExecutionState as unknown as ContextWindowState;
  assert.equal(successor.id, "window-2");
  assert.deepEqual(successor.committedTrace, []);
  assert.deepEqual(successor.transcriptAnchor, {
    sourceId: "2026-07-19",
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
    transcriptDirectory,
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

test("keeps a Harness message correction out of Frozen Activity Input", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-main-agent-internal-prompt-"));
  const { transcriptDirectory } = await writePrimaryTranscript(root, transcriptWithInternalPrompt(root));
  const lifecycle = createMainAgentActivityLifecycle({
    agentWorkspace: new AgentWorkspace(path.join(root, "workspace")),
    transcriptDirectory,
    nextWindowId: () => "window-2",
  });
  const closing = request();
  const correctedAnchor = {
    sourceId: "2026-07-19",
    sessionId: "session-1",
    entryId: "message-result",
  };
  closing.executionState = serializeContextWindowState({
    version: 1,
    id: "window-1",
    frozenSeed: [],
    recentActivityReferences: [],
    committedTrace: [],
    transcriptSources: [correctedAnchor],
    transcriptAnchor: correctedAnchor,
  });
  closing.turns[0]!.transcriptAnchor = correctedAnchor;

  const { activity } = await lifecycle.freeze(closing);

  assert.equal(activity.events.filter(event => event.kind === "input").length, 2);
  assert.equal(
    activity.events.filter(event => event.kind === "input" && event.actorRef === "human").length,
    2,
  );
  assert.doesNotMatch(JSON.stringify(activity.events), /message_decision_required/);
  assert.match(JSON.stringify(activity.events), /visible reply/);
});

test("freezes one Activity from committed Turns across daily transcripts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-main-agent-cross-day-"));
  const transcriptDirectory = path.join(root, "transcripts");
  await Promise.all([
    writeTranscriptDay(transcriptDirectory, "2026-07-19", crossDayTranscript(root, "prior")),
    writeTranscriptDay(transcriptDirectory, "2026-07-20", crossDayTranscript(root, "current")),
  ]);
  const lifecycle = createMainAgentActivityLifecycle({
    agentWorkspace: new AgentWorkspace(path.join(root, "workspace")),
    transcriptDirectory,
    nextWindowId: () => "window-after-cross-day",
  });
  const startingAnchor = { sourceId: "2026-07-19", sessionId: "session-prior", entryId: "before-segment" };
  const priorAnchor = { sourceId: "2026-07-19", sessionId: "session-prior", entryId: "prior-final" };
  const currentAnchor = { sourceId: "2026-07-20", sessionId: "session-current", entryId: "current-final" };
  const result = await lifecycle.freeze({
    segment: {
      id: "segment-cross-day",
      openedAt: "2026-07-20T02:59:00.000Z",
      closedAt: "2026-07-20T03:02:00.000Z",
      recordingDay: "2026-07-20",
    },
    recentActivities: [],
    startingExecutionState: serializeContextWindowState({
      version: 1,
      id: "window-cross-day",
      frozenSeed: [],
      recentActivityReferences: [],
      committedTrace: [],
      transcriptSources: [startingAnchor],
      transcriptAnchor: startingAnchor,
    }),
    executionState: serializeContextWindowState({
      version: 1,
      id: "window-cross-day",
      frozenSeed: [],
      recentActivityReferences: [],
      committedTrace: [],
      transcriptSources: [priorAnchor, currentAnchor],
      transcriptAnchor: currentAnchor,
    }),
    inputs: [{
      id: "input-prior",
      kind: "interaction",
      payload: { text: "before boundary" },
      occurredAt: "2026-07-20T02:59:00.000Z",
    }, {
      id: "input-current",
      kind: "interaction",
      payload: { text: "after boundary" },
      occurredAt: "2026-07-20T03:01:00.000Z",
    }],
    turns: [{
      id: "turn-prior",
      inputIds: ["input-prior"],
      status: "completed",
      startedAt: "2026-07-20T02:59:00.000Z",
      endedAt: "2026-07-20T02:59:30.000Z",
      transcriptAnchor: priorAnchor,
      executionRecord: { version: 1 },
    }, {
      id: "turn-current",
      inputIds: ["input-current"],
      status: "completed",
      startedAt: "2026-07-20T03:01:00.000Z",
      endedAt: "2026-07-20T03:01:30.000Z",
      transcriptAnchor: currentAnchor,
      executionRecord: { version: 1 },
    }],
    toolActivities: [],
    effects: [],
    deliveries: [],
  });

  assert.deepEqual(
    result.activity.events.filter(event => event.kind === "input").map(event => event.content),
    [{ text: "before boundary" }, { text: "after boundary" }],
  );
  const successor = result.successorExecutionState as unknown as ContextWindowState;
  assert.deepEqual(successor.transcriptSources, [currentAnchor]);
  assert.equal(successor.recentActivityReferences.length, 1);
  const expanded = await createExpandTool({ window: successor, transcriptDirectory }).execute(
    "expand-prior-day",
    { reference: successor.recentActivityReferences[0]!, offset: 0 },
    undefined,
    undefined,
    {} as never,
  );
  assert.match(JSON.stringify(expanded.content), /prior-day tool result/);
});

test("refreshes Daily Context only when creating a successor window", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-main-agent-daily-successor-"));
  const { transcriptDirectory } = await writePrimaryTranscript(root, transcript(root));
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(path.join(workspaceRoot, "daily"), { recursive: true });
  const dailyFile = path.join(workspaceRoot, "daily", "2026-07-19.md");
  await writeFile(dailyFile, "# 2026-07-19\n\nfirst successor narrative\n", "utf8");
  const lifecycle = createMainAgentActivityLifecycle({
    agentWorkspace: new AgentWorkspace(workspaceRoot),
    transcriptDirectory,
  });

  const first = await lifecycle.freeze(request());
  await writeFile(
    dailyFile,
    "# 2026-07-19\n\nsecond successor narrative\n\n## candidates\n- hidden [attention]\n",
    "utf8",
  );
  const second = await lifecycle.freeze(request());

  assert.match(JSON.stringify(first.successorExecutionState), /first successor narrative/);
  assert.doesNotMatch(JSON.stringify(first.successorExecutionState), /second successor narrative/);
  assert.match(JSON.stringify(second.successorExecutionState), /second successor narrative/);
  assert.doesNotMatch(JSON.stringify(second.successorExecutionState), /hidden|## candidates/);
});

test("rejects a closing state that is not anchored to the last completed Turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-main-agent-activity-anchor-"));
  const { transcriptDirectory } = await writePrimaryTranscript(root, transcript(root));
  const lifecycle = createMainAgentActivityLifecycle({
    agentWorkspace: new AgentWorkspace(path.join(root, "workspace")),
    transcriptDirectory,
  });
  const invalid = request();
  invalid.executionState = serializeContextWindowState({
    ...(invalid.executionState as unknown as ContextWindowState),
    transcriptSources: [{ sourceId: "2026-07-19", sessionId: "session-1", entryId: "tool-result" }],
    transcriptAnchor: { sourceId: "2026-07-19", sessionId: "session-1", entryId: "tool-result" },
  });

  await assert.rejects(
    lifecycle.freeze(invalid),
    /does not match the last completed Turn/i,
  );
});

test("preserves only verified tool pairs from a failed Turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-main-agent-failed-tools-"));
  const { transcriptDirectory } = await writePrimaryTranscript(root, transcript(root));
  const lifecycle = createMainAgentActivityLifecycle({
    agentWorkspace: new AgentWorkspace(path.join(root, "workspace")),
    transcriptDirectory,
  });
  const value = request();
  value.turns = [{
    id: "turn-failed",
    inputIds: ["input-1"],
    status: "failed",
    startedAt: "2026-07-19T10:00:00.500Z",
    endedAt: "2026-07-19T10:00:05.000Z",
    error: "provider stopped after tool activity",
  }];
  value.inputs = value.inputs.filter(input => input.id === "input-1");
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
  const { transcriptDirectory } = await writePrimaryTranscript(root, transcript(root));
  const lifecycle = createMainAgentActivityLifecycle({
    agentWorkspace: new AgentWorkspace(path.join(root, "workspace")),
    transcriptDirectory,
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
  const { transcriptDirectory } = await writePrimaryTranscript(root, transcript(root));
  const lifecycle = createMainAgentActivityLifecycle({
    agentWorkspace: new AgentWorkspace(path.join(root, "workspace")),
    transcriptDirectory,
  });
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
    transcriptSources: [{ sourceId: "2026-07-19", sessionId: "session-1", entryId: "before-segment" }],
    transcriptAnchor: { sourceId: "2026-07-19", sessionId: "session-1", entryId: "before-segment" },
  });
  const current = serializeContextWindowState({
    version: 1,
    id: "window-1",
    frozenSeed: [],
    recentActivityReferences: [],
    committedTrace: [],
    transcriptSources: [{ sourceId: "2026-07-19", sessionId: "session-1", entryId: "assistant-final" }],
    transcriptAnchor: { sourceId: "2026-07-19", sessionId: "session-1", entryId: "assistant-final" },
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
        turnId: "turn-older",
        at: "2026-07-19T09:50:00.000Z",
        actorRef: "human",
        kind: "input",
        content: { text: "older pending activity" },
      }],
      turns: [{
        turnId: "turn-older",
        startedAt: "2026-07-19T09:50:00.000Z",
        endedAt: "2026-07-19T09:55:00.000Z",
        status: "completed",
      }],
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
        transcriptAnchor: { sourceId: "2026-07-19", sessionId: "session-1", entryId: "assistant-final" },
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
      turnId: `turn-history-${index}`,
      at: `2026-07-19T09:${minute}:00.000Z`,
      actorRef: "human",
      kind: "input",
      content: { text: `historical activity ${index}` },
    }],
    turns: [{
      turnId: `turn-history-${index}`,
      startedAt: `2026-07-19T09:${minute}:00.000Z`,
      endedAt: `2026-07-19T09:${minute}:30.000Z`,
      status: "completed",
    }],
  };
}

function denseBridgeActivity(): ActivityFreezeRequest["recentActivities"][number] {
  const events: ActivityFreezeRequest["recentActivities"][number]["events"] = [{
    eventId: "input:dense",
    turnId: "turn-dense",
    at: "2026-07-19T09:40:00.000Z",
    actorRef: "human",
    kind: "input",
    content: { text: `human input remains complete ${"h".repeat(260)} human-tail` },
  }, {
    eventId: "transcript:output-dense",
    turnId: "turn-dense",
    at: "2026-07-19T09:40:01.000Z",
    actorRef: "individual",
    kind: "output",
    content: { type: "text", text: `output-head ${"o".repeat(260)} output-tail` },
  }, {
    eventId: "turn:stopped-dense",
    turnId: "turn-dense",
    at: "2026-07-19T09:40:02.000Z",
    actorRef: "system",
    kind: "system",
    content: { type: "turn_stopped", error: `system-head ${"s".repeat(260)} system-tail` },
  }];
  for (let index = 0; index < 12; index += 1) {
    events.push({
      eventId: `transcript:call-${index}`,
      turnId: "turn-dense",
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
      turnId: "turn-dense",
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
    turnId: "turn-dense",
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
    turns: [{
      turnId: "turn-dense",
      startedAt: "2026-07-19T09:40:00.000Z",
      endedAt: "2026-07-19T09:45:00.000Z",
      status: "completed",
      transcriptAnchor: { sourceId: "2026-07-19", sessionId: "session-dense", entryId: "dense-end" },
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

function transcriptWithInternalPrompt(root: string): string {
  const records = transcript(root)
    .trimEnd()
    .split("\n")
    .map(line => JSON.parse(line) as Record<string, unknown>);
  records.push(
    {
      type: "custom",
      customType: "loom.internal-prompt.v1",
      data: { version: 1, turnId: "turn-1", purpose: "message-decision-correction" },
      id: "internal-prompt",
      parentId: "assistant-final",
      timestamp: "2026-07-19T10:00:05.000Z",
    },
    {
      type: "message",
      id: "internal-user",
      parentId: "internal-prompt",
      timestamp: "2026-07-19T10:00:05.100Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "<message_decision_required>" }],
        timestamp: 6,
      },
    },
    {
      type: "message",
      id: "message-call",
      parentId: "internal-user",
      timestamp: "2026-07-19T10:00:06.000Z",
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "message-1",
          name: "message",
          arguments: { action: "send", text: "visible reply" },
        }],
        stopReason: "toolUse",
        timestamp: 7,
      },
    },
    {
      type: "message",
      id: "message-result",
      parentId: "message-call",
      timestamp: "2026-07-19T10:00:07.000Z",
      message: {
        role: "toolResult",
        toolCallId: "message-1",
        toolName: "message",
        content: [{ type: "text", text: "Effect accepted." }],
        isError: false,
        timestamp: 8,
      },
    },
  );
  return `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
}

async function writePrimaryTranscript(root: string, content: string): Promise<{
  transcriptDirectory: string;
  transcriptFile: string;
}> {
  const transcriptDirectory = path.join(root, "transcripts");
  const transcriptFile = path.join(transcriptDirectory, "2026-07-19", "agent.jsonl");
  await mkdir(path.dirname(transcriptFile), { recursive: true });
  await writeFile(transcriptFile, content, "utf8");
  return { transcriptDirectory, transcriptFile };
}

async function writeTranscriptDay(
  transcriptDirectory: string,
  sourceId: string,
  content: string,
): Promise<void> {
  const transcriptFile = path.join(transcriptDirectory, sourceId, "agent.jsonl");
  await mkdir(path.dirname(transcriptFile), { recursive: true });
  await writeFile(transcriptFile, content, "utf8");
}

function crossDayTranscript(root: string, day: "prior" | "current"): string {
  const sessionId = `session-${day}`;
  const records: unknown[] = [{
    type: "session", version: 3, id: sessionId, timestamp: "2026-07-20T02:00:00.000Z", cwd: root,
  }];
  if (day === "prior") {
    records.push(
      { type: "message", id: "before-segment", parentId: null, timestamp: "2026-07-20T02:58:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "before" }] } },
      { type: "custom", customType: "loom.input.v1", data: { version: 1, turnId: "turn-prior", inputId: "input-prior", inclusionPosition: 1, kind: "interaction", occurredAt: "2026-07-20T02:59:00.000Z", payload: { text: "before boundary" } }, id: "prior-annotation", parentId: "before-segment", timestamp: "2026-07-20T02:59:01.000Z" },
      { type: "message", id: "prior-user", parentId: "prior-annotation", timestamp: "2026-07-20T02:59:02.000Z", message: { role: "user", content: [{ type: "text", text: "before boundary" }] } },
      { type: "message", id: "prior-call", parentId: "prior-user", timestamp: "2026-07-20T02:59:03.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "prior-tool", name: "read", arguments: { path: "prior.md" } }], stopReason: "toolUse" } },
      { type: "message", id: "prior-result", parentId: "prior-call", timestamp: "2026-07-20T02:59:04.000Z", message: { role: "toolResult", toolCallId: "prior-tool", toolName: "read", isError: false, content: [{ type: "text", text: "prior-day tool result" }] } },
      { type: "message", id: "prior-final", parentId: "prior-result", timestamp: "2026-07-20T02:59:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "prior complete" }] } },
    );
  } else {
    records.push(
      { type: "custom", customType: "loom.input.v1", data: { version: 1, turnId: "turn-current", inputId: "input-current", inclusionPosition: 1, kind: "interaction", occurredAt: "2026-07-20T03:01:00.000Z", payload: { text: "after boundary" } }, id: "current-annotation", parentId: null, timestamp: "2026-07-20T03:01:01.000Z" },
      { type: "message", id: "current-user", parentId: "current-annotation", timestamp: "2026-07-20T03:01:02.000Z", message: { role: "user", content: [{ type: "text", text: "after boundary" }] } },
      { type: "message", id: "current-final", parentId: "current-user", timestamp: "2026-07-20T03:01:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "current complete" }] } },
    );
  }
  return [...records.map(record => JSON.stringify(record)), ""].join("\n");
}
