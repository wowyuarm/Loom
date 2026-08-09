import assert from "node:assert/strict";
import test from "node:test";

import { RaftActivityProjector, ACTIVITY_QUEUE_LIMIT } from "../../src/channels/raft/raft-activity.js";
import { parseActivityDrainMax } from "../../src/channels/raft/raft-cli-parse.js";
import type { OperationalEvent } from "../../src/operational-events.js";

function runStarted(runId: string, agentName = "main-agent", at = "2026-08-09T00:00:00.000Z"): OperationalEvent {
  return { event: "agent.run.started", at, runId, agentName };
}

function runFinished(runId: string, result: "succeeded" | "failed" | "interrupted" = "succeeded", at = "2026-08-09T00:00:05.000Z", failureCategory?: string): OperationalEvent {
  return {
    event: "agent.run.finished",
    at,
    runId,
    agentName: "main-agent",
    result,
    ...(failureCategory ? { failureCategory } : {}),
  };
}

function toolStarted(toolCallId: string, toolName = "read", at = "2026-08-09T00:00:01.000Z"): OperationalEvent {
  return { event: "agent.tool.started", at, toolCallId, toolName };
}

function toolCompleted(toolCallId: string, status: "ok" | "error" = "ok", durationMs = 100, at = "2026-08-09T00:00:02.000Z"): OperationalEvent {
  return { event: "agent.tool.completed", at, toolCallId, toolName: "read", durationMs, status };
}

function drainHooks(drain: ReturnType<RaftActivityProjector["drain"]>): string[] {
  return drain.events.map(event => event.hookEventName);
}

test("maps a single run with one successful tool to the Idle/Thinking/Working lifecycle", () => {
  const projector = new RaftActivityProjector();
  projector.observe(runStarted("run-1"));
  projector.observe(toolStarted("tool-1", "read"));
  projector.observe(toolCompleted("tool-1", "ok", 250));
  projector.observe(runFinished("run-1"));

  const drain = projector.drain(10);
  assert.deepEqual(drainHooks(drain), ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);
  assert.equal(drain.dropped, 0);

  const [prompt, pre, post, stop] = drain.events as [
    NonNullable<(typeof drain.events)[number]>,
    NonNullable<(typeof drain.events)[number]>,
    NonNullable<(typeof drain.events)[number]>,
    NonNullable<(typeof drain.events)[number]>,
  ];
  assert.equal(prompt.sessionId, "main-agent");
  assert.equal(pre.toolName, "read");
  assert.equal(pre.occurredAt, "2026-08-09T00:00:01.000Z");
  assert.equal(post.status, "ok");
  assert.equal(post.durationMs, 250);
  assert.equal(stop.sessionId, "main-agent");
  assert.equal(stop.occurredAt, "2026-08-09T00:00:05.000Z");
  assert.ok(prompt.eventId);
  assert.ok(stop.eventId);
});

test("maps a failing tool to PostToolUseFailure with a bounded errorClass", () => {
  const projector = new RaftActivityProjector();
  projector.observe(runStarted("run-1"));
  projector.observe(toolStarted("tool-1", "shell"));
  projector.observe(toolCompleted("tool-1", "error", 500));
  projector.observe(runFinished("run-1"));

  const drain = projector.drain(10);
  assert.deepEqual(drainHooks(drain), ["UserPromptSubmit", "PreToolUse", "PostToolUseFailure", "Stop"]);
  const failure = drain.events[2]!;
  assert.equal(failure.errorClass, "tool_error");
  assert.equal(failure.status, "error");
});

test("does not emit Stop while another run or tool is still active", () => {
  const projector = new RaftActivityProjector();
  // Two overlapping runs; the first finishes while the second is still active.
  projector.observe(runStarted("run-1", "main-agent", "2026-08-09T00:00:00.000Z"));
  projector.observe(runStarted("run-2", "memory-reflector", "2026-08-09T00:00:00.500Z"));
  projector.observe(runFinished("run-1", "succeeded", "2026-08-09T00:00:01.000Z"));
  assert.deepEqual(drainHooks(projector.drain(10)), ["UserPromptSubmit", "UserPromptSubmit"]);

  // A tool is still running inside the remaining run.
  projector.observe(toolStarted("tool-1", "read", "2026-08-09T00:00:02.000Z"));
  projector.observe(runFinished("run-2", "succeeded", "2026-08-09T00:00:03.000Z"));
  assert.deepEqual(drainHooks(projector.drain(10)), ["PreToolUse"]);

  // Only after the tool completes does the projection go Idle.
  projector.observe(toolCompleted("tool-1", "ok", 50, "2026-08-09T00:00:04.000Z"));
  assert.deepEqual(drainHooks(projector.drain(10)), ["PostToolUse", "Stop"]);
});

test("drain respects max, reports dropped once, and is at-most-once", () => {
  const projector = new RaftActivityProjector();
  for (let index = 0; index < 5; index += 1) {
    projector.observe(runStarted(`run-${index}`, "main-agent", `2026-08-09T00:00:0${index}.000Z`));
  }

  const partial = projector.drain(2);
  assert.equal(partial.events.length, 2);
  assert.equal(partial.dropped, 0);
  assert.deepEqual(drainHooks(partial), ["UserPromptSubmit", "UserPromptSubmit"]);

  const rest = projector.drain(2);
  assert.equal(rest.events.length, 2);

  const last = projector.drain(2);
  assert.equal(last.events.length, 1);

  const empty = projector.drain(2);
  assert.equal(empty.events.length, 0);
  assert.equal(empty.dropped, 0);
});

test("overflow drops the oldest event and reports dropped on the next drain", () => {
  const projector = new RaftActivityProjector();
  const at = (index: number) => `2026-08-09T00:00:${String(index).padStart(2, "0")}.000Z`;
  for (let index = 0; index < ACTIVITY_QUEUE_LIMIT + 3; index += 1) {
    projector.observe(runStarted(`run-${index}`, "main-agent", at(index)));
  }
  const drain = projector.drain(ACTIVITY_QUEUE_LIMIT + 10);
  assert.equal(drain.events.length, ACTIVITY_QUEUE_LIMIT);
  assert.equal(drain.dropped, 3);
  // The oldest three events were dropped.
  assert.equal(drain.events[0]!.occurredAt, at(3));
  // dropped is reported once, then reset.
  assert.equal(projector.drain(10).dropped, 0);
});

test("emits only the allow-listed activity fields, never private content", () => {
  const projector = new RaftActivityProjector();
  projector.observe(runStarted("run-1"));
  projector.observe(toolStarted("tool-1", "read"));
  projector.observe(toolCompleted("tool-1", "error", 100));
  projector.observe(runFinished("run-1", "failed", "2026-08-09T00:00:06.000Z"));

  const drain = projector.drain(10);
  assert.equal(drain.events.length, 4);
  for (const event of drain.events) {
    const keys = Object.keys(event).sort();
    const allowed = new Set(["hookEventName", "eventId", "sessionId", "toolName", "status", "occurredAt", "durationMs", "errorClass"]);
    for (const key of keys) assert.ok(allowed.has(key), `unexpected activity field: ${key}`);
    assert.equal(JSON.stringify(event).includes("prompt"), false);
    assert.equal(JSON.stringify(event).includes("transcript"), false);
    assert.equal(JSON.stringify(event).includes("workspace"), false);
    assert.equal(JSON.stringify(event).includes("input"), false);
    assert.equal(JSON.stringify(event).includes("output"), false);
  }
});

test("ignores events outside the run/tool lifecycle", () => {
  const projector = new RaftActivityProjector();
  projector.observe({ event: "host.started", at: "2026-08-09T00:00:00.000Z", root: "/tmp/loom" });
  projector.observe({ event: "runtime.transition", at: "2026-08-09T00:00:00.000Z", entityType: "turn", entityId: "t-1", fromState: "running", toState: "succeeded", reason: "done" });
  assert.deepEqual(projector.drain(10).events, []);
});

test("parseActivityDrainMax bounds the requested max", () => {
  assert.equal(parseActivityDrainMax(null), ACTIVITY_QUEUE_LIMIT);
  assert.equal(parseActivityDrainMax("0"), 0);
  assert.equal(parseActivityDrainMax("5"), 5);
  assert.equal(parseActivityDrainMax(String(ACTIVITY_QUEUE_LIMIT + 100)), ACTIVITY_QUEUE_LIMIT);
  assert.equal(parseActivityDrainMax("abc"), 0);
  assert.equal(parseActivityDrainMax("-1"), 0);
  assert.equal(parseActivityDrainMax("1.5"), 0);
});

test("maps a failed run Stop with a bounded errorClass only for real failures", () => {
  const projector = new RaftActivityProjector();
  projector.observe(runStarted("run-1"));
  projector.observe(runFinished("run-1", "failed", "2026-08-09T00:00:05.000Z", "tool_error"));

  const drain = projector.drain(10);
  assert.deepEqual(drainHooks(drain), ["UserPromptSubmit", "Stop"]);
  assert.equal(drain.events[1]?.errorClass, "tool_error");
});

test("keeps interrupted and cancelled runs without a failure errorClass", () => {
  const projector = new RaftActivityProjector();
  projector.observe(runStarted("run-1"));
  projector.observe({
    event: "agent.run.finished",
    at: "2026-08-09T00:00:05.000Z",
    runId: "run-1",
    agentName: "main-agent",
    result: "interrupted",
    failureCategory: "cancelled",
  });
  const drain = projector.drain(10);
  assert.deepEqual(drainHooks(drain), ["UserPromptSubmit", "Stop"]);
  assert.equal(drain.events[1]?.errorClass, undefined);

  const second = new RaftActivityProjector();
  second.observe(runStarted("run-2"));
  second.observe(runFinished("run-2", "succeeded", "2026-08-09T00:00:05.000Z"));
  assert.equal(second.drain(10).events[1]?.errorClass, undefined);
});

test("failed run still emits Stop with errorClass when a tool outlives the run", () => {
  const projector = new RaftActivityProjector();
  projector.observe(runStarted("run-1"));
  projector.observe(toolStarted("tool-1", "read"));
  // The run fails while the tool is still active: no Stop yet.
  projector.observe(runFinished("run-1", "failed", "2026-08-09T00:00:03.000Z", "tool_error"));
  assert.deepEqual(drainHooks(projector.drain(10)), ["UserPromptSubmit", "PreToolUse"]);
  // The tool completes last; the trailing Stop carries the failure class.
  projector.observe(toolCompleted("tool-1", "ok", 50, "2026-08-09T00:00:04.000Z"));
  const drain = projector.drain(10);
  assert.deepEqual(drainHooks(drain), ["PostToolUse", "Stop"]);
  assert.equal(drain.events[1]?.errorClass, "tool_error");
});

test("keeps an earlier failed run's errorClass when a newer run interleaves", () => {
  const projector = new RaftActivityProjector();
  // run-1 fails while its tool is still active, then a second run starts and
  // finishes while the first run's tool completes in between. The final Stop
  // must still report the first run's failure class.
  projector.observe(runStarted("run-1"));
  projector.observe(toolStarted("tool-1", "read"));
  projector.observe(runFinished("run-1", "failed", "2026-08-09T00:00:03.000Z", "tool_error"));
  projector.observe(runStarted("run-2", "memory-reflector", "2026-08-09T00:00:03.500Z"));
  projector.observe(toolCompleted("tool-1", "ok", 50, "2026-08-09T00:00:04.000Z"));
  projector.observe(runFinished("run-2", "succeeded", "2026-08-09T00:00:05.000Z"));

  const drain = projector.drain(10);
  assert.deepEqual(drainHooks(drain), [
    "UserPromptSubmit",
    "PreToolUse",
    "UserPromptSubmit",
    "PostToolUse",
    "Stop",
  ]);
  assert.equal(drain.events[4]?.errorClass, "tool_error");
});

test("a later failed run supersedes an earlier held failure class", () => {
  const projector = new RaftActivityProjector();
  projector.observe(runStarted("run-1"));
  projector.observe(toolStarted("tool-1", "read"));
  projector.observe(runFinished("run-1", "failed", "2026-08-09T00:00:03.000Z", "tool_error"));
  projector.observe(runStarted("run-2"));
  projector.observe(runFinished("run-2", "failed", "2026-08-09T00:00:04.000Z", "provider"));
  projector.observe(toolCompleted("tool-1", "ok", 50, "2026-08-09T00:00:05.000Z"));

  const drain = projector.drain(10);
  assert.equal(drain.events.at(-1)?.errorClass, "provider");
});

test("consumed pending failure does not leak into a later independent run", () => {
  const projector = new RaftActivityProjector();
  // First cycle: run fails while its tool is still active; the trailing Stop
  // consumes the held failure class.
  projector.observe(runStarted("run-1"));
  projector.observe(toolStarted("tool-1", "read"));
  projector.observe(runFinished("run-1", "failed", "2026-08-09T00:00:03.000Z", "tool_error"));
  projector.observe(toolCompleted("tool-1", "ok", 50, "2026-08-09T00:00:04.000Z"));
  const first = projector.drain(10);
  assert.deepEqual(drainHooks(first), ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);
  assert.equal(first.events[3]?.errorClass, "tool_error");

  // Second cycle: a clean run must not carry the earlier failure class.
  projector.observe(runStarted("run-2"));
  projector.observe(runFinished("run-2", "succeeded", "2026-08-09T00:00:06.000Z"));
  const second = projector.drain(10);
  assert.deepEqual(drainHooks(second), ["UserPromptSubmit", "Stop"]);
  assert.equal(second.events[1]?.errorClass, undefined);
});
