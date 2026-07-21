import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createNmemThreadReconciler } from "../../src/integrations/nmem/index.js";
import { openRuntime } from "../../src/runtime/index.js";
import type {
  ActivityLifecycle,
  AgentExecution,
  FrozenActivity,
  RunningExecution,
} from "../../src/runtime/index.js";

test("projects one frozen Activity into one attributed nmem conversation Thread", async t => {
  const fixture = await interactionFixture(t);
  const requests: unknown[] = [];
  const reconciler = createNmemThreadReconciler({
    runtime: fixture.runtime,
    stateRoot: fixture.runtimeRoot,
    endpoint: "http://nmem.test",
    fetch: async (input, init) => {
      if (resource(input) === "/capabilities") return capabilities();
      requests.push(JSON.parse(String(init?.body)));
      return createdThread("segment-thread-1");
    },
  });
  t.after(() => reconciler.close());

  assert.deepEqual(await reconciler.reconcile(), {
    imported: 1,
    current: 0,
    pending: 0,
    blocked: 0,
  });
  const payload = requests[0] as {
    thread_id: string;
    participants: string[];
    messages: Array<{ role: string; content: string; metadata: Record<string, unknown> }>;
    metadata: Record<string, unknown>;
  };
  assert.equal(payload.thread_id, "loom-activity-segment-thread-1");
  assert.deepEqual(payload.participants, ["human", "individual"]);
  assert.equal(payload.metadata.loom_segment_id, "segment-thread-1");
  assert.deepEqual(payload.messages.map(message => message.role), ["user", "system", "assistant"]);
  assert.equal(payload.messages[0]?.content, "我们继续把这条线梳理清楚。");
  assert.match(payload.messages[1]?.content ?? "", /read.*threads\/shared-line\.md/i);
  assert.match(payload.messages[1]?.content ?? "", /我找到了上次留下的线索/);
  assert.equal(payload.messages[2]?.content, "我想我们可以从这里继续。");
  assert.equal(payload.messages[0]?.metadata.actor_ref, "human");
  assert.equal(payload.messages[2]?.metadata.actor_ref, "individual");
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_THINKING|RAW_RESULT_SHOULD_NOT_LEAK|未送达文本/);

  assert.deepEqual(await reconciler.reconcile(), {
    imported: 0,
    current: 1,
    pending: 0,
    blocked: 0,
  });
  assert.equal(requests.length, 1);
});

test("recovers a pending Thread projection and accepts an already-created remote Thread", async t => {
  const fixture = await interactionFixture(t);
  let mode: "temporary" | "existing" = "temporary";
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const pathValue = resource(input);
    requests.push(`${init?.method ?? "GET"} ${pathValue}`);
    if (pathValue === "/capabilities") return capabilities();
    if (pathValue === "/threads") {
      return mode === "temporary"
        ? Response.json({ error: "temporarily unavailable" }, { status: 503 })
        : Response.json({ detail: "Thread already exists" }, { status: 422 });
    }
    if (pathValue === "/threads/loom-activity-segment-thread-1") return createdThread("segment-thread-1");
    return Response.json({ error: "not found" }, { status: 404 });
  };
  let now = new Date("2026-07-21T13:10:00.000Z");
  const options = {
    runtime: fixture.runtime,
    stateRoot: fixture.runtimeRoot,
    endpoint: "http://nmem.test",
    fetch,
    now: () => now,
  };

  const failed = createNmemThreadReconciler(options);
  assert.equal((await failed.reconcile()).pending, 1);
  failed.close();

  mode = "existing";
  now = new Date("2026-07-21T13:10:10.000Z");
  const waiting = createNmemThreadReconciler(options);
  assert.equal((await waiting.reconcile()).pending, 1);
  waiting.close();
  assert.deepEqual(requests, ["GET /capabilities", "POST /threads"]);

  now = new Date("2026-07-21T13:10:31.000Z");
  const recovered = createNmemThreadReconciler(options);
  t.after(() => recovered.close());
  assert.equal((await recovered.reconcile()).imported, 1);
  assert.deepEqual(requests, [
    "GET /capabilities",
    "POST /threads",
    "GET /capabilities",
    "POST /threads",
    "GET /threads/loom-activity-segment-thread-1",
  ]);
});

test("projects autonomous private activity without inventing human participation", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-nmem-private-thread-"));
  const runtimeRoot = path.join(root, "runtime");
  const runtime = openRuntime({
    root: runtimeRoot,
    execution: completedExecution(true),
    activityLifecycle: privateActivityLifecycle(),
    nextId: ids("input-private-1", "segment-private-1", "turn-private-1"),
    now: () => new Date("2026-07-21T14:05:00.000Z"),
  });
  t.after(() => runtime.close());
  await runtime.acceptInput({
    source: "orientation",
    sourceId: "opportunity-private-1",
    kind: "opportunity",
    payload: { narrative: "Return to the unfinished private line." },
    occurredAt: "2026-07-21T14:00:00.000Z",
  });
  await runtime.advance();
  assert.equal(runtime.status().activities[0]?.status, "pending");

  let payload: unknown;
  const reconciler = createNmemThreadReconciler({
    runtime,
    stateRoot: runtimeRoot,
    endpoint: "http://nmem.test",
    fetch: async (input, init) => {
      if (resource(input) === "/capabilities") return capabilities();
      payload = JSON.parse(String(init?.body));
      return createdThread("segment-private-1");
    },
  });
  t.after(() => reconciler.close());
  assert.equal((await reconciler.reconcile()).imported, 1);
  const projected = payload as {
    participants: string[];
    messages: Array<{ role: string; content: string }>;
  };
  assert.deepEqual(projected.participants, ["individual"]);
  assert.deepEqual(projected.messages.map(message => message.role), ["system"]);
  assert.match(projected.messages[0]?.content ?? "", /unfinished private line/i);
  assert.match(projected.messages[0]?.content ?? "", /read.*threads\/private-line\.md/i);
});

async function interactionFixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "loom-nmem-thread-"));
  const runtimeRoot = path.join(root, "runtime");
  const runtime = openRuntime({
    root: runtimeRoot,
    execution: completedExecution(),
    activityLifecycle: interactionActivityLifecycle(),
    nextId: ids("input-thread-1", "segment-thread-1", "turn-thread-1"),
    now: () => new Date("2026-07-21T13:05:00.000Z"),
  });
  t.after(() => runtime.close());
  await runtime.acceptInput({
    source: "test",
    sourceId: "message-thread-1",
    kind: "interaction",
    payload: { text: "我们继续把这条线梳理清楚。" },
    occurredAt: "2026-07-21T13:00:00.000Z",
  });
  await runtime.advance();
  assert.equal((await runtime.closeActivity()).disposition, "activity_frozen");
  assert.equal(runtime.status().activities[0]?.status, "pending");
  return { runtime, runtimeRoot };
}

function completedExecution(withTool = false): AgentExecution {
  return {
    start(request, control): RunningExecution {
      for (const input of request.inputs) control.includeInput(input.id);
      control.prepareExecutionState({ version: 1, windowId: "window-1" });
      if (withTool) {
        control.recordToolActivity({
          toolCallId: "tool-private-1",
          toolName: "read",
          callArguments: { path: "threads/private-line.md" },
          result: { content: "raw private source" },
        });
      }
      return {
        result: Promise.resolve({
          outcome: "completed",
          inputAnchors: request.inputs.map(input => ({
            inputId: input.id,
            transcriptAnchor: { sessionId: "session-1", entryId: `entry-${input.id}` },
          })),
          transcriptAnchor: { sessionId: "session-1", entryId: "entry-final" },
          executionState: { version: 1, windowId: "window-1" },
          executionRecord: { messages: [] },
        }),
        steer: async () => {},
        abort: async () => {},
      };
    },
  };
}

function interactionActivityLifecycle(): ActivityLifecycle {
  return lifecycle(request => {
    const turnId = request.turns[0]!.id;
    return [
      event("human-input", turnId, "13:00:00", "human", "input", { text: "我们继续把这条线梳理清楚。" }),
      event("thinking", turnId, "13:00:01", "individual", "thinking", { thinking: "PRIVATE_THINKING" }),
      event("tool-call", turnId, "13:00:02", "individual", "tool_call", {
        name: "read",
        arguments: { path: "threads/shared-line.md" },
      }),
      event("tool-result", turnId, "13:00:03", "system", "tool_result", {
        toolName: "read",
        isError: false,
        content: "RAW_RESULT_SHOULD_NOT_LEAK",
      }),
      event("private-output", turnId, "13:00:04", "individual", "output", {
        type: "text",
        text: "我找到了上次留下的线索。",
      }),
      event("effect-delivered", turnId, "13:00:05", "individual", "effect", {
        effectId: "effect-delivered",
        kind: "message",
        payload: { text: "我想我们可以从这里继续。" },
        status: "completed",
      }),
      event("delivery-delivered", turnId, "13:00:06", "system", "delivery", {
        deliveryId: "delivery-1",
        effectId: "effect-delivered",
        status: "delivered",
      }),
      event("effect-unknown", turnId, "13:00:07", "individual", "effect", {
        effectId: "effect-unknown",
        kind: "message",
        payload: { text: "未送达文本" },
        status: "reconciliation_required",
      }),
      event("delivery-unknown", turnId, "13:00:08", "system", "delivery", {
        deliveryId: "delivery-2",
        effectId: "effect-unknown",
        status: "unknown",
      }),
    ];
  });
}

function privateActivityLifecycle(): ActivityLifecycle {
  return lifecycle(request => {
    const turnId = request.turns[0]!.id;
    return [
      event("private-context", turnId, "14:00:00", "system", "input", request.inputs[0]!.payload),
      event("private-tool", turnId, "14:00:01", "individual", "tool_call", {
        toolName: "read",
        callArguments: { path: "threads/private-line.md" },
      }),
      event("private-note", turnId, "14:00:02", "individual", "output", {
        type: "text",
        text: "The private line remains worth carrying.",
      }),
    ];
  });
}

function lifecycle(
  events: (request: Parameters<ActivityLifecycle["freeze"]>[0]) => FrozenActivity["events"],
): ActivityLifecycle {
  return {
    freeze: async request => ({
      activity: {
        version: 1,
        segmentId: request.segment.id,
        recordingDay: request.segment.recordingDay,
        openedAt: request.segment.openedAt,
        closedAt: request.segment.closedAt,
        events: events(request),
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

function event(
  id: string,
  turnId: string,
  time: string,
  actorRef: FrozenActivity["events"][number]["actorRef"],
  kind: FrozenActivity["events"][number]["kind"],
  content: FrozenActivity["events"][number]["content"],
): FrozenActivity["events"][number] {
  return {
    eventId: `event-${id}`,
    turnId,
    at: `2026-07-21T${time}.000Z`,
    actorRef,
    kind,
    content,
  };
}

function capabilities(): Response {
  return Response.json({ version: "0.10.31", features: { threads: true } });
}

function createdThread(segmentId: string): Response {
  return Response.json({
    thread: { thread_id: `loom-activity-${segmentId}` },
    messages: [],
  });
}

function resource(input: string | URL | Request): string {
  return new URL(String(input)).pathname;
}

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}
