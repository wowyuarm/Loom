import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createScheduler,
  openRuntime,
  type AgentExecution,
  type DeliveryObservation,
  type TurnRequest,
} from "../../src/runtime/index.js";

function messageExecution(): AgentExecution {
  return {
    start(request, control) {
      control.prepareExecutionState(request.executionState ?? { version: 1 });
      control.includeInput(request.inputs[0]!.id);
      control.prepareEffect({
        kind: "message",
        payload: { text: "Still thinking about this." },
        routeRef: "primary",
      });
      return {
        result: Promise.resolve({
          outcome: "completed",
          inputAnchors: request.inputs.map(input => ({
            inputId: input.id,
            transcriptAnchor: {
              sourceId: request.recordingDay,
              sessionId: "after-chat-session",
              entryId: `input-${input.id}`,
            },
          })),
          transcriptAnchor: {
            sourceId: request.recordingDay,
            sessionId: "after-chat-session",
            entryId: `turn-${request.turnId}`,
          },
          executionState: { version: 1, turnId: request.turnId },
          executionRecord: { version: 1 },
        }),
        steer: async input => control.includeInput(input.id),
        abort: async () => {},
      };
    },
  };
}

test("schedules a recoverable continuation only after outbound Delivery is confirmed", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-after-chat-delivered-"));
  let now = new Date("2026-07-22T10:00:00.000Z");
  const runtime = openRuntime({
    root,
    execution: messageExecution(),
    outboundDelivery: {
      deliver: async (): Promise<DeliveryObservation> => ({ status: "delivered", remoteId: "remote-1" }),
    },
    now: () => now,
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "human-1",
    kind: "interaction",
    payload: { text: "keep going" },
  });
  assert.equal((await runtime.advance()).disposition, "turn_completed");
  assert.equal(runtime.status().afterChatContinuation, undefined);

  assert.equal((await runtime.advance()).disposition, "delivery_completed");
  const continuation = runtime.status().afterChatContinuation;
  assert.ok(continuation);
  assert.equal(continuation.status, "pending");
  assert.equal(continuation.sourceBehavior, "interaction");
  assert.equal(continuation.deliveredAt, "2026-07-22T10:00:00.000Z");
  assert.equal(continuation.dueAt, "2026-07-22T10:05:00.000Z");
  assert.equal(continuation.expiresAt, "2026-07-22T10:20:00.000Z");
});

test("upgrades a version 11 Runtime Store before admitting a continuation", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-after-chat-schema-upgrade-"));
  const database = new DatabaseSync(path.join(root, "runtime.db"));
  database.exec(`
    CREATE TABLE inputs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('interaction', 'opportunity')),
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'consumed', 'blocked')),
      active_turn_id TEXT,
      UNIQUE (source, source_id)
    ) STRICT;
    CREATE TABLE turn_inputs (
      turn_id TEXT NOT NULL REFERENCES turns(id),
      input_id TEXT NOT NULL REFERENCES inputs(id),
      position INTEGER NOT NULL CHECK (position > 0),
      inclusion_status TEXT NOT NULL CHECK (inclusion_status IN ('prepared', 'included', 'rejected')),
      included_at TEXT,
      inclusion_anchor_json TEXT,
      PRIMARY KEY (turn_id, input_id),
      UNIQUE (turn_id, position)
    ) STRICT;
    INSERT INTO inputs (
      id, source, source_id, kind, payload_json, occurred_at, accepted_at, status
    ) VALUES (
      'legacy-input', 'legacy-channel', 'legacy-1', 'interaction', '{}',
      '2026-07-22T09:00:00.000Z', '2026-07-22T09:00:00.000Z', 'consumed'
    );
    PRAGMA user_version = 11;
  `);
  database.close();

  let now = new Date("2026-07-22T10:00:00.000Z");
  const runtime = openRuntime({
    root,
    execution: messageExecution(),
    outboundDelivery: {
      deliver: async (): Promise<DeliveryObservation> => ({ status: "delivered", remoteId: "remote-1" }),
    },
    now: () => now,
  });
  t.after(() => runtime.close());
  assert.equal(runtime.status().inputs[0]?.id, "legacy-input");
  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "human-1",
    kind: "interaction",
    payload: { text: "continue" },
  });
  await createScheduler({ runtime }).runOnce(now);
  assert.equal(runtime.status().afterChatContinuation?.status, "pending");

  now = new Date("2026-07-22T10:05:00.000Z");
  await createScheduler({ runtime }).runOnce(now);
  assert.equal(runtime.status().afterChatContinuation?.status, "completed");
});

test("reschedules from the latest confirmed outbound and preserves proactive Behavior", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-after-chat-latest-delivery-"));
  let now = new Date("2026-07-22T10:00:00.000Z");
  const execution: AgentExecution = {
    start(request, control) {
      const running = messageExecution().start(request, control);
      control.prepareEffect({
        kind: "message",
        payload: { text: "One more thing." },
        routeRef: "primary",
      });
      return running;
    },
  };
  const runtime = openRuntime({
    root,
    execution,
    outboundDelivery: {
      deliver: async request => ({ status: "delivered", remoteId: `remote-${request.attemptId}` }),
    },
    now: () => now,
  });
  t.after(() => runtime.close());
  await runtime.acceptInput({
    source: "orientation",
    sourceId: "opportunity-1",
    kind: "opportunity",
    payload: { narrative: "Reach out." },
  });
  await runtime.advance();
  await runtime.advance();
  const first = runtime.status().afterChatContinuation;
  assert.equal(first?.sourceBehavior, "background");
  assert.equal(first?.dueAt, "2026-07-22T10:05:00.000Z");

  now = new Date("2026-07-22T10:02:00.000Z");
  await runtime.advance();
  const latest = runtime.status().afterChatContinuation;
  assert.equal(latest?.sourceBehavior, "background");
  assert.notEqual(latest?.id, first?.id);
  assert.equal(latest?.deliveredAt, "2026-07-22T10:02:00.000Z");
  assert.equal(latest?.dueAt, "2026-07-22T10:07:00.000Z");
  assert.equal(latest?.expiresAt, "2026-07-22T10:22:00.000Z");
});

test("atomically cancels a pending continuation when new human Input is accepted", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-after-chat-cancel-"));
  let now = new Date("2026-07-22T10:00:00.000Z");
  const runtime = openRuntime({
    root,
    execution: messageExecution(),
    outboundDelivery: {
      deliver: async (): Promise<DeliveryObservation> => ({ status: "delivered", remoteId: "remote-1" }),
    },
    now: () => now,
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "human-1",
    kind: "interaction",
    payload: { text: "first" },
  });
  await runtime.advance();
  await runtime.advance();
  assert.equal(runtime.status().afterChatContinuation?.status, "pending");

  now = new Date("2026-07-22T10:02:00.000Z");
  assert.equal((await runtime.acceptInput({
    source: "test-channel",
    sourceId: "human-2",
    kind: "interaction",
    payload: { text: "I am back" },
  })).disposition, "accepted");

  const cancelled = runtime.status().afterChatContinuation;
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(cancelled?.endedAt, "2026-07-22T10:02:00.000Z");
  assert.equal(cancelled?.reason, "new_human_input");
});

test("cancels an admitted continuation before its Turn when human Input wins the race", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-after-chat-admission-race-"));
  let now = new Date("2026-07-22T10:00:00.000Z");
  const runtime = openRuntime({
    root,
    execution: messageExecution(),
    outboundDelivery: {
      deliver: async (): Promise<DeliveryObservation> => ({ status: "delivered", remoteId: "remote-1" }),
    },
    now: () => now,
  });
  t.after(() => runtime.close());
  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "human-1",
    kind: "interaction",
    payload: { text: "first" },
  });
  await runtime.advance();
  await runtime.advance();

  now = new Date("2026-07-22T10:05:00.000Z");
  assert.equal((await runtime.runAfterChatContinuation({ observedAt: now })).disposition, "admitted");
  const continuationInputId = runtime.status().afterChatContinuation?.inputId;
  assert.ok(continuationInputId);

  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "human-2",
    kind: "interaction",
    payload: { text: "I am back" },
  });

  assert.equal(runtime.status().afterChatContinuation?.status, "cancelled");
  assert.equal(runtime.status().afterChatContinuation?.reason, "new_human_input");
  assert.equal(runtime.status().inputs.some(input => input.id === continuationInputId), false);
  assert.equal((await runtime.advance()).disposition, "turn_completed");
  assert.equal(runtime.status().turns.at(-1)?.inputIds[0], runtime.status().inputs.at(-1)?.id);
});

test("cancels a failed continuation without deleting its Turn evidence", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-after-chat-failed-cancel-"));
  let now = new Date("2026-07-22T10:00:00.000Z");
  const execution: AgentExecution = {
    start(request, control) {
      if (request.inputs[0]!.kind !== "continuation") return messageExecution().start(request, control);
      control.prepareExecutionState(request.executionState ?? { version: 1 });
      control.includeInput(request.inputs[0]!.id);
      return {
        result: Promise.reject(new Error("provider unavailable")),
        steer: async input => control.includeInput(input.id),
        abort: async () => {},
      };
    },
  };
  const runtime = openRuntime({
    root,
    execution,
    outboundDelivery: {
      deliver: async (): Promise<DeliveryObservation> => ({ status: "delivered", remoteId: "remote-1" }),
    },
    now: () => now,
  });
  t.after(() => runtime.close());
  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "human-1",
    kind: "interaction",
    payload: { text: "begin" },
  });
  await createScheduler({ runtime }).runOnce(now);

  now = new Date("2026-07-22T10:05:00.000Z");
  await assert.rejects(createScheduler({ runtime }).runOnce(now), /provider unavailable/);
  const continuationInput = runtime.status().inputs.find(input => input.kind === "continuation");
  assert.equal(continuationInput?.status, "pending");

  now = new Date("2026-07-22T10:06:00.000Z");
  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "human-2",
    kind: "interaction",
    payload: { text: "I am back" },
  });

  assert.equal(runtime.status().afterChatContinuation?.status, "cancelled");
  assert.equal(runtime.status().afterChatContinuation?.inputId, continuationInput.id);
  assert.equal(
    runtime.status().inputs.find(input => input.id === continuationInput.id)?.status,
    "blocked",
  );
  assert.ok(runtime.status().turns.some(turn => turn.inputIds.includes(continuationInput.id)));
});

test("admits a quiet continuation after restart without advancing Activity time", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-after-chat-restart-"));
  let now = new Date("2026-07-22T10:00:00.000Z");
  const requests: TurnRequest[] = [];
  const execution: AgentExecution = {
    start(request, control) {
      requests.push(structuredClone(request));
      control.prepareExecutionState(request.executionState ?? { version: 1, window: "current" });
      control.includeInput(request.inputs[0]!.id);
      if (request.inputs[0]!.kind === "interaction") {
        control.prepareEffect({ kind: "message", payload: { text: "Delivered" }, routeRef: "primary" });
      }
      return {
        result: Promise.resolve({
          outcome: request.inputs[0]!.kind === "continuation" ? "no_reply" : "completed",
          inputAnchors: request.inputs.map(input => ({
            inputId: input.id,
            transcriptAnchor: {
              sourceId: request.recordingDay,
              sessionId: "after-chat-restart-session",
              entryId: `input-${input.id}`,
            },
          })),
          transcriptAnchor: {
            sourceId: request.recordingDay,
            sessionId: "after-chat-restart-session",
            entryId: `turn-${request.turnId}`,
          },
          executionState: { version: 1, window: "current", turns: requests.length },
          executionRecord: { version: 1 },
        }),
        steer: async input => control.includeInput(input.id),
        abort: async () => {},
      };
    },
  };
  const delivery = {
    deliver: async (): Promise<DeliveryObservation> => ({ status: "delivered", remoteId: "remote-1" }),
  };
  const first = openRuntime({ root, execution, outboundDelivery: delivery, now: () => now });
  await first.acceptInput({
    source: "test-channel",
    sourceId: "human-1",
    kind: "interaction",
    payload: { text: "continue later" },
  });
  assert.deepEqual(await createScheduler({ runtime: first }).runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T10:05:00.000Z",
  });
  const segment = first.status().activeSegment;
  assert.ok(segment);
  first.close();

  now = new Date("2026-07-22T10:05:00.000Z");
  const recovered = openRuntime({ root, execution, outboundDelivery: delivery, now: () => now });
  t.after(() => recovered.close());
  assert.deepEqual(await createScheduler({ runtime: recovered }).runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T10:30:00.000Z",
  });

  const continuation = requests[1];
  assert.equal(continuation?.inputs[0]?.kind, "continuation");
  assert.deepEqual(continuation?.executionState, { version: 1, window: "current", turns: 1 });
  assert.equal(recovered.status().activeSegment?.id, segment.id);
  assert.equal(recovered.status().activeSegment?.lastActivityAt, "2026-07-22T10:00:00.000Z");
  assert.equal(recovered.status().afterChatContinuation?.status, "completed");
});

test("keeps a model-blocked continuation recoverable until it expires", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-after-chat-expiry-"));
  let now = new Date("2026-07-22T10:00:00.000Z");
  const runtime = openRuntime({
    root,
    execution: messageExecution(),
    outboundDelivery: {
      deliver: async (): Promise<DeliveryObservation> => ({ status: "delivered", remoteId: "remote-1" }),
    },
    now: () => now,
  });
  t.after(() => runtime.close());
  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "human-1",
    kind: "interaction",
    payload: { text: "hold this" },
  });
  await createScheduler({ runtime }).runOnce(now);
  const blocked = createScheduler({ runtime, admitAgentWork: () => false });

  now = new Date("2026-07-22T10:05:00.000Z");
  assert.deepEqual(await blocked.runOnce(now), {
    disposition: "deferred",
    reason: "agent_work_not_admitted",
  });
  assert.equal(runtime.status().afterChatContinuation?.status, "pending");

  now = new Date("2026-07-22T10:20:00.000Z");
  assert.deepEqual(await blocked.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T10:30:00.000Z",
  });
  assert.equal(runtime.status().afterChatContinuation?.status, "expired");
  assert.equal(runtime.status().inputs.filter(input => input.kind === "continuation").length, 0);
});

test("expires a failed continuation before Runtime can retry it after the deadline", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-after-chat-failed-expiry-"));
  let now = new Date("2026-07-22T10:00:00.000Z");
  let continuationAttempts = 0;
  const execution: AgentExecution = {
    start(request, control) {
      control.prepareExecutionState(request.executionState ?? { version: 1 });
      control.includeInput(request.inputs[0]!.id);
      if (request.inputs[0]!.kind === "continuation") {
        continuationAttempts += 1;
        return {
          result: Promise.reject(new Error("provider unavailable")),
          steer: async input => control.includeInput(input.id),
          abort: async () => {},
        };
      }
      control.prepareEffect({ kind: "message", payload: { text: "Delivered" }, routeRef: "primary" });
      return messageExecution().start(request, control);
    },
  };
  const runtime = openRuntime({
    root,
    execution,
    outboundDelivery: {
      deliver: async (): Promise<DeliveryObservation> => ({ status: "delivered", remoteId: "remote-1" }),
    },
    now: () => now,
  });
  t.after(() => runtime.close());
  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "human-1",
    kind: "interaction",
    payload: { text: "begin" },
  });
  await createScheduler({ runtime }).runOnce(now);
  const lastActivityAt = runtime.status().activeSegment?.lastActivityAt;

  now = new Date("2026-07-22T10:05:00.000Z");
  await assert.rejects(createScheduler({ runtime }).runOnce(now), /provider unavailable/);
  assert.equal(continuationAttempts, 1);
  assert.equal(runtime.status().afterChatContinuation?.status, "admitted");
  assert.equal(runtime.status().activeSegment?.lastActivityAt, lastActivityAt);

  now = new Date("2026-07-22T10:20:00.000Z");
  assert.deepEqual(await createScheduler({ runtime }).runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T10:30:00.000Z",
  });
  assert.equal(continuationAttempts, 1);
  assert.equal(runtime.status().afterChatContinuation?.status, "expired");
  assert.equal(
    runtime.status().inputs.find(input => input.kind === "continuation")?.status,
    "blocked",
  );
});

test("settles a failed continuation once its outbound Effect covers the Input", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-after-chat-failed-after-effect-"));
  let now = new Date("2026-07-22T10:00:00.000Z");
  let continuationAttempts = 0;
  const execution: AgentExecution = {
    start(request, control) {
      if (request.inputs[0]!.kind !== "continuation") return messageExecution().start(request, control);
      continuationAttempts += 1;
      control.prepareExecutionState(request.executionState ?? { version: 1 });
      control.includeInput(request.inputs[0]!.id);
      control.prepareEffect({ kind: "message", payload: { text: "A late thought" }, routeRef: "primary" });
      return {
        result: Promise.reject(new Error("provider failed after send")),
        steer: async input => control.includeInput(input.id),
        abort: async () => {},
      };
    },
  };
  const runtime = openRuntime({
    root,
    execution,
    outboundDelivery: {
      deliver: async request => ({ status: "delivered", remoteId: `remote-${request.attemptId}` }),
    },
    now: () => now,
  });
  t.after(() => runtime.close());
  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "human-1",
    kind: "interaction",
    payload: { text: "begin" },
  });
  await createScheduler({ runtime }).runOnce(now);

  now = new Date("2026-07-22T10:05:00.000Z");
  await assert.rejects(createScheduler({ runtime }).runOnce(now), /provider failed after send/);
  assert.equal(continuationAttempts, 1);
  assert.equal(runtime.status().inputs.find(input => input.kind === "continuation")?.status, "consumed");
  assert.equal(runtime.status().afterChatContinuation?.status, "completed");

  await createScheduler({ runtime }).runOnce(now);
  assert.equal(continuationAttempts, 1);
  assert.equal(runtime.status().deliveries.length, 2);
  assert.equal(runtime.status().afterChatContinuation?.sourceDeliveryId, runtime.status().deliveries[0]?.id);
});

for (const observation of [
  { status: "not_sent", error: "route unavailable" },
  { status: "unknown", error: "connection lost" },
] as const) {
  test(`does not schedule a continuation for ${observation.status} Delivery`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), `loom-after-chat-${observation.status}-`));
    const now = new Date("2026-07-22T10:00:00.000Z");
    const runtime = openRuntime({
      root,
      execution: messageExecution(),
      outboundDelivery: { deliver: async () => observation },
      now: () => now,
    });
    t.after(() => runtime.close());
    await runtime.acceptInput({
      source: "test-channel",
      sourceId: "human-1",
      kind: "interaction",
      payload: { text: "send" },
    });
    await runtime.advance();
    await runtime.advance();

    assert.equal(runtime.status().afterChatContinuation, undefined);
  });
}

test("does not chain another continuation from its own delivered outbound", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-after-chat-no-chain-"));
  let now = new Date("2026-07-22T10:00:00.000Z");
  const runtime = openRuntime({
    root,
    execution: messageExecution(),
    outboundDelivery: {
      deliver: async request => ({ status: "delivered", remoteId: `remote-${request.attemptId}` }),
    },
    now: () => now,
  });
  t.after(() => runtime.close());
  const scheduler = createScheduler({ runtime });
  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "human-1",
    kind: "interaction",
    payload: { text: "begin" },
  });
  await scheduler.runOnce(now);
  const sourceDeliveryId = runtime.status().afterChatContinuation?.sourceDeliveryId;

  now = new Date("2026-07-22T10:05:00.000Z");
  assert.deepEqual(await scheduler.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-22T10:35:00.000Z",
  });
  assert.equal(runtime.status().effects.length, 2);
  assert.equal(runtime.status().deliveries.length, 2);
  assert.equal(runtime.status().afterChatContinuation?.status, "completed");
  assert.equal(runtime.status().afterChatContinuation?.sourceDeliveryId, sourceDeliveryId);
  assert.equal(runtime.status().activeSegment?.lastActivityAt, "2026-07-22T10:05:00.000Z");
});
