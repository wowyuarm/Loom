import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createTimePolicy } from "../../src/configuration/index.js";

import {
  createScheduler,
  openRuntime,
  type ActivityLifecycle,
  type ActivityRecorder,
  type AgentExecution,
  type AttentionMaintenance,
  type MemoryReflection,
  type ThreadMaintenance,
} from "../../src/runtime/index.js";

function attentionMaintainer(
  requests: Array<{ observedAt: string; activityIds: string[] }>,
  failure?: Error,
): AttentionMaintenance {
  return {
    async maintain(request) {
      requests.push({
        observedAt: request.observedAt,
        activityIds: request.recentActivities.map(activity => activity.segmentId),
      });
      if (failure) throw failure;
      return { outcome: "no_change", runId: `attention-${requests.length}`, path: "attention.md" };
    },
  };
}

function memoryReflector(
  requests: Array<{ day: string; activityIds: string[]; eventTurnIds: string[] }>,
  failure?: Error,
): MemoryReflection {
  return {
    async reflect(request) {
      requests.push({
        day: request.reflectionDay,
        activityIds: request.activities.map(activity => activity.segmentId),
        eventTurnIds: request.activities.flatMap(activity => activity.events.map(event => event.turnId)),
      });
      if (failure) throw failure;
      return { outcome: "no_change", runId: `reflection-${requests.length}`, changedMaterials: [] };
    },
  };
}

const completingExecution: AgentExecution = {
  start(request, control) {
    control.prepareExecutionState(request.executionState ?? { version: 1 });
    control.includeInput(request.inputs[0]!.id);
    return {
      result: Promise.resolve({
        outcome: "completed",
        inputAnchors: request.inputs.map(input => ({
          inputId: input.id,
          transcriptAnchor: {
            sourceId: request.recordingDay,
            sessionId: "scheduler-session",
            entryId: `input-${input.id}`,
          },
        })),
        transcriptAnchor: {
          sourceId: request.recordingDay,
          sessionId: "scheduler-session",
          entryId: `turn-${request.turnId}`,
        },
        executionState: { version: 1, turnId: request.turnId },
        executionRecord: { version: 1, turnId: request.turnId },
      }),
      steer: async input => control.includeInput(input.id),
      abort: async () => {},
    };
  },
};

const effectExecution: AgentExecution = {
  start(request, control) {
    const running = completingExecution.start(request, control);
    control.prepareEffect({
      kind: "message",
      payload: { text: "hello" },
      routeRef: "default",
    });
    return running;
  },
};

const activityLifecycle: ActivityLifecycle = {
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
    successorExecutionState: { version: 1, successorOf: request.segment.id },
  }),
};

function recorder(recorded: string[]): ActivityRecorder {
  return {
    record: async activity => {
      recorded.push(activity.segmentId);
      return {
        version: 1,
        segmentId: activity.segmentId,
        runId: `record-${activity.segmentId}`,
        recordedAt: activity.closedAt,
        daily: { status: "no_change", path: `daily/${activity.recordingDay}.md` },
        episodes: [],
      };
    },
  };
}

function failingRecorder(attempted: string[]): ActivityRecorder {
  return {
    record: async activity => {
      attempted.push(activity.segmentId);
      throw new Error("recorder unavailable");
    },
  };
}

test("backs off after a confirmed not-sent Delivery", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-delivery-not-sent-"));
  const now = new Date("2026-07-21T08:00:00.000Z");
  const runtime = openRuntime({
    root,
    execution: effectExecution,
    outboundDelivery: { deliver: async () => ({ status: "not_sent", error: "route unavailable" }) },
    now: () => now,
  });
  try {
    await runtime.acceptInput({ source: "test", sourceId: "not-sent", kind: "interaction", payload: {} });

    assert.deepEqual(await createScheduler({ runtime }).runOnce(now), {
      disposition: "deferred",
      reason: "delivery_not_sent",
      nextRunAt: "2026-07-21T08:01:00.000Z",
    });
  } finally {
    runtime.close();
  }
});

test("keeps a Delivery retry time across Runtime restart", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-delivery-restart-"));
  let now = new Date("2026-07-21T08:00:00.000Z");
  const first = openRuntime({
    root,
    execution: effectExecution,
    outboundDelivery: { deliver: async () => ({ status: "not_sent", error: "route unavailable" }) },
    now: () => now,
  });
  await first.acceptInput({ source: "test", sourceId: "not-sent-restart", kind: "interaction", payload: {} });
  await createScheduler({ runtime: first }).runOnce(now);
  first.close();

  let deliveryCalls = 0;
  const recovered = openRuntime({
    root,
    outboundDelivery: {
      deliver: async () => {
        deliveryCalls += 1;
        return { status: "delivered", remoteId: "remote-retry" };
      },
    },
    now: () => now,
  });
  t.after(() => recovered.close());
  const scheduler = createScheduler({ runtime: recovered });

  now = new Date("2026-07-21T08:00:30.000Z");
  assert.deepEqual(await scheduler.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-21T08:01:00.000Z",
  });
  assert.equal(deliveryCalls, 0);

  now = new Date("2026-07-21T08:01:00.000Z");
  await scheduler.runOnce(now);
  assert.equal(deliveryCalls, 1);
  assert.equal(recovered.status().effects[0]?.status, "completed");
  assert.equal(recovered.status().deliveries.length, 2);
});

test("increases the Delivery retry delay after each confirmed not-sent result", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-delivery-backoff-"));
  let now = new Date("2026-07-21T08:00:00.000Z");
  const runtime = openRuntime({
    root,
    execution: effectExecution,
    outboundDelivery: { deliver: async () => ({ status: "not_sent", error: "route unavailable" }) },
    now: () => now,
  });
  t.after(() => runtime.close());
  await runtime.acceptInput({ source: "test", sourceId: "not-sent-backoff", kind: "interaction", payload: {} });
  const scheduler = createScheduler({ runtime });

  assert.deepEqual(await scheduler.runOnce(now), {
    disposition: "deferred",
    reason: "delivery_not_sent",
    nextRunAt: "2026-07-21T08:01:00.000Z",
  });

  now = new Date("2026-07-21T08:01:00.000Z");
  assert.deepEqual(await scheduler.runOnce(now), {
    disposition: "deferred",
    reason: "delivery_not_sent",
    nextRunAt: "2026-07-21T08:03:00.000Z",
  });
  assert.equal(runtime.status().deliveries.length, 2);
});

test("caps the Delivery retry delay at one hour", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-delivery-backoff-cap-"));
  let now = new Date("2026-07-21T08:00:00.000Z");
  const runtime = openRuntime({
    root,
    execution: effectExecution,
    outboundDelivery: { deliver: async () => ({ status: "not_sent", error: "route unavailable" }) },
    now: () => now,
  });
  t.after(() => runtime.close());
  await runtime.acceptInput({ source: "test", sourceId: "not-sent-cap", kind: "interaction", payload: {} });
  const scheduler = createScheduler({ runtime });
  const attempts = [
    ["2026-07-21T08:00:00.000Z", "2026-07-21T08:01:00.000Z"],
    ["2026-07-21T08:01:00.000Z", "2026-07-21T08:03:00.000Z"],
    ["2026-07-21T08:03:00.000Z", "2026-07-21T08:07:00.000Z"],
    ["2026-07-21T08:07:00.000Z", "2026-07-21T08:15:00.000Z"],
    ["2026-07-21T08:15:00.000Z", "2026-07-21T08:31:00.000Z"],
    ["2026-07-21T08:31:00.000Z", "2026-07-21T09:03:00.000Z"],
    ["2026-07-21T09:03:00.000Z", "2026-07-21T10:03:00.000Z"],
  ] as const;

  for (const [attemptedAt, expectedRetryAt] of attempts) {
    now = new Date(attemptedAt);
    const result = await scheduler.runOnce(now);
    assert.equal(result.disposition, "deferred");
    assert.equal("nextRunAt" in result ? result.nextRunAt : undefined, expectedRetryAt);
  }
  assert.equal(runtime.status().deliveries.length, 7);
});

test("upgrades a version 12 Runtime Store before scheduling Delivery retry", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-delivery-schema-upgrade-"));
  const seed = openRuntime({ root });
  seed.close();
  const database = new DatabaseSync(path.join(root, "runtime.db"));
  database.exec(`
    ALTER TABLE effects DROP COLUMN next_delivery_after;
    PRAGMA user_version = 12;
  `);
  database.close();

  const now = new Date("2026-07-21T08:00:00.000Z");
  const runtime = openRuntime({
    root,
    execution: effectExecution,
    outboundDelivery: { deliver: async () => ({ status: "not_sent", error: "route unavailable" }) },
    now: () => now,
  });
  t.after(() => runtime.close());
  await runtime.acceptInput({ source: "test", sourceId: "not-sent-upgrade", kind: "interaction", payload: {} });

  assert.deepEqual(await createScheduler({ runtime }).runOnce(now), {
    disposition: "deferred",
    reason: "delivery_not_sent",
    nextRunAt: "2026-07-21T08:01:00.000Z",
  });
});

test("waits for explicit reconciliation after an unknown Delivery", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-delivery-unknown-"));
  const now = new Date("2026-07-21T08:00:00.000Z");
  const runtime = openRuntime({
    root,
    execution: effectExecution,
    outboundDelivery: { deliver: async () => ({ status: "unknown", error: "connection lost" }) },
    now: () => now,
  });
  try {
    await runtime.acceptInput({ source: "test", sourceId: "unknown", kind: "interaction", payload: {} });

    assert.deepEqual(await createScheduler({ runtime }).runOnce(now), {
      disposition: "deferred",
      reason: "delivery_requires_reconciliation",
    });
  } finally {
    runtime.close();
  }
});

test("guards Activity closure with the latest committed Segment activity", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-runtime-"));
  let now = new Date("2026-07-21T10:00:00.000Z");
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle,
    now: () => now,
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "first",
    kind: "interaction",
    payload: { text: "first" },
  });
  assert.equal((await runtime.advance()).disposition, "turn_completed");
  assert.equal(runtime.status().activeSegment?.lastActivityAt, "2026-07-21T10:00:00.000Z");

  now = new Date("2026-07-21T10:20:00.000Z");
  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "second",
    kind: "interaction",
    payload: { text: "second" },
  });
  assert.equal((await runtime.advance()).disposition, "turn_completed");
  assert.equal(runtime.status().activeSegment?.lastActivityAt, "2026-07-21T10:20:00.000Z");

  assert.deepEqual(
    await runtime.closeActivity({ inactiveBefore: "2026-07-21T10:10:00.000Z" }),
    {
      disposition: "not_due",
      openedAt: "2026-07-21T10:00:00.000Z",
      lastActivityAt: "2026-07-21T10:20:00.000Z",
    },
  );
  assert.ok(runtime.status().activeSegment);
});

test("advances Runtime work and closes Activity only after the idle interval", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-lifecycle-"));
  let now = new Date("2026-07-21T11:00:00.000Z");
  const recorded: string[] = [];
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle,
    activityRecorder: recorder(recorded),
    now: () => now,
  });
  const scheduler = createScheduler({ runtime, activityIdleMs: 30 * 60 * 1_000 });
  t.after(() => runtime.close());

  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "scheduled-input",
    kind: "interaction",
    payload: { text: "continue" },
  });

  assert.deepEqual(await scheduler.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-21T11:30:00.000Z",
  });
  assert.equal(runtime.status().turns[0]?.status, "completed");

  now = new Date("2026-07-21T11:29:59.999Z");
  assert.equal((await scheduler.runOnce(now)).disposition, "waiting");
  assert.ok(runtime.status().activeSegment);

  now = new Date("2026-07-21T11:30:00.000Z");
  assert.deepEqual(await scheduler.runOnce(now), { disposition: "idle" });
  assert.equal(runtime.status().activeSegment, undefined);
  const activityId = runtime.status().activities[0]?.id;
  assert.ok(activityId);
  assert.deepEqual(recorded, [activityId]);
  assert.equal(runtime.status().activities[0]?.status, "recorded");
});

test("soft-splits a continuously active Segment at its maximum age", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-soft-split-"));
  let now = new Date("2026-07-21T10:00:00.000Z");
  const recorded: string[] = [];
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle,
    activityRecorder: recorder(recorded),
    now: () => now,
  });
  const scheduler = createScheduler({
    runtime,
    activityIdleMs: 30 * 60_000,
    activityMaxMs: 2 * 60 * 60_000,
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({ source: "test", sourceId: "first", kind: "interaction", payload: {} });
  await scheduler.runOnce(now);
  for (const [sourceId, at] of [
    ["second", "2026-07-21T10:25:00.000Z"],
    ["third", "2026-07-21T10:50:00.000Z"],
    ["fourth", "2026-07-21T11:15:00.000Z"],
    ["fifth", "2026-07-21T11:40:00.000Z"],
  ] as const) {
    now = new Date(at);
    await runtime.acceptInput({ source: "test", sourceId, kind: "interaction", payload: {} });
    await scheduler.runOnce(now);
  }

  now = new Date("2026-07-21T11:40:00.001Z");
  assert.deepEqual(await scheduler.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-21T12:00:00.000Z",
  });

  now = new Date("2026-07-21T12:00:00.000Z");
  assert.deepEqual(await scheduler.runOnce(now), { disposition: "idle" });
  assert.equal(runtime.status().activeSegment, undefined);
  assert.equal(runtime.status().activities.length, 1);
  assert.deepEqual(recorded, [runtime.status().activities[0]!.id]);
});

test("does not soft-split a Segment opened after the observed cutoff", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-soft-split-guard-"));
  let now = new Date("2026-07-21T12:00:00.000Z");
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle,
    now: () => now,
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({ source: "test", sourceId: "new-segment", kind: "interaction", payload: {} });
  await runtime.advance();

  assert.deepEqual(await runtime.closeActivity({
    openedBefore: "2026-07-21T11:59:59.999Z",
  }), {
    disposition: "not_due",
    openedAt: "2026-07-21T12:00:00.000Z",
    lastActivityAt: "2026-07-21T12:00:00.000Z",
  });
  assert.ok(runtime.status().activeSegment);
});

test("schedules Attention maintenance with a durable successful Activity cursor", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-attention-"));
  let now = new Date("2026-07-21T11:00:00.000Z");
  const requests: Array<{ observedAt: string; activityIds: string[] }> = [];
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle,
    activityRecorder: recorder([]),
    attentionMaintenance: attentionMaintainer(requests),
    now: () => now,
  });
  const scheduler = createScheduler({
    runtime,
    activityIdleMs: 30 * 60 * 1_000,
    attentionMaintenance: { intervalMs: 60 * 60 * 1_000 },
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "attention-evidence",
    kind: "interaction",
    payload: { text: "carry this" },
  });
  await scheduler.runOnce(now);
  now = new Date("2026-07-21T11:30:00.000Z");
  await scheduler.runOnce(now);
  const activityId = runtime.status().activities[0]!.id;

  now = new Date("2026-07-21T12:00:00.000Z");
  assert.deepEqual(await scheduler.runOnce(now), {
    disposition: "waiting",
    nextRunAt: "2026-07-21T13:00:00.000Z",
  });
  assert.deepEqual(requests, [{
    observedAt: "2026-07-21T12:00:00.000Z",
    activityIds: [activityId],
  }]);
  assert.deepEqual(runtime.status().attentionMaintenance?.pendingActivityIds, []);
});

test("retries the same frozen Attention evidence window after failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-attention-retry-"));
  const requests: Array<{ observedAt: string; activityIds: string[] }> = [];
  let now = new Date("2026-07-21T08:00:00.000Z");
  const failing = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle,
    activityRecorder: recorder([]),
    attentionMaintenance: attentionMaintainer(requests, new Error("attention unavailable")),
    now: () => now,
  });
  const firstScheduler = createScheduler({
    runtime: failing,
    activityIdleMs: 1,
    attentionMaintenance: { intervalMs: 60_000, retryDelayMs: 30_000 },
  });
  await failing.acceptInput({ source: "test", sourceId: "first", kind: "interaction", payload: {} });
  await firstScheduler.runOnce(now);
  now = new Date("2026-07-21T08:00:00.001Z");
  await firstScheduler.runOnce(now);
  const firstActivity = failing.status().activities[0]!.id;
  now = new Date("2026-07-21T08:01:00.000Z");
  assert.deepEqual(await firstScheduler.runOnce(now), {
    disposition: "deferred",
    reason: "attention_maintenance_failed",
    nextRunAt: "2026-07-21T08:01:30.000Z",
  });

  await failing.acceptInput({ source: "test", sourceId: "second", kind: "interaction", payload: {} });
  await firstScheduler.runOnce(now);
  now = new Date("2026-07-21T08:01:00.001Z");
  await firstScheduler.runOnce(now);
  const secondActivity = failing.status().activities[1]!.id;
  failing.close();

  now = new Date("2026-07-21T08:01:30.000Z");
  const recovered = openRuntime({
    root,
    attentionMaintenance: attentionMaintainer(requests),
    now: () => now,
  });
  try {
    const retryScheduler = createScheduler({
      runtime: recovered,
      attentionMaintenance: { intervalMs: 60_000, retryDelayMs: 30_000 },
    });
    await retryScheduler.runOnce(now);
    assert.deepEqual(requests.map(request => request.activityIds), [
      [firstActivity],
      [firstActivity],
    ]);
    assert.deepEqual(recovered.status().attentionMaintenance?.pendingActivityIds, [secondActivity]);
  } finally {
    recovered.close();
  }
});

test("reflects one complete logical day and slices a cross-day Activity by Turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-reflection-"));
  let now = new Date("2026-07-22T02:50:00.000Z");
  const requests: Array<{ day: string; activityIds: string[]; eventTurnIds: string[] }> = [];
  const lifecycle: ActivityLifecycle = {
    freeze: async request => ({
      activity: {
        version: 1,
        segmentId: request.segment.id,
        recordingDay: request.segment.recordingDay,
        openedAt: request.segment.openedAt,
        closedAt: request.segment.closedAt,
        events: request.turns.map(turn => ({
          eventId: `event-${turn.id}`,
          turnId: turn.id,
          at: turn.endedAt,
          actorRef: "individual",
          kind: "output",
          content: { text: turn.id },
        })),
        turns: request.turns.map(turn => ({
          turnId: turn.id,
          startedAt: turn.startedAt,
          endedAt: turn.endedAt,
          status: turn.status,
          ...(turn.transcriptAnchor ? { transcriptAnchor: turn.transcriptAnchor } : {}),
        })),
      },
      successorExecutionState: { version: 1 },
    }),
  };
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: completingExecution,
    activityLifecycle: lifecycle,
    activityRecorder: recorder([]),
    memoryReflection: memoryReflector(requests),
    now: () => now,
  });
  const scheduler = createScheduler({
    runtime,
    activityIdleMs: 1,
    memoryReflection: { delayMs: 15 * 60_000 },
  });
  try {
    await runtime.acceptInput({ source: "test", sourceId: "before", kind: "interaction", payload: {} });
    await scheduler.runOnce(now);
    now = new Date("2026-07-22T03:10:00.000Z");
    await runtime.acceptInput({ source: "test", sourceId: "after", kind: "interaction", payload: {} });
    await scheduler.runOnce(now);
    now = new Date("2026-07-22T03:10:00.001Z");
    await scheduler.runOnce(now);
    const turns = runtime.status().turns;

    now = new Date("2026-07-22T03:15:00.000Z");
    const result = await scheduler.runOnce(now);
    assert.equal(result.disposition, "waiting");
    assert.deepEqual(requests, [{
      day: "2026-07-21",
      activityIds: [runtime.status().activities[0]!.id],
      eventTurnIds: [turns[0]!.id],
    }]);
    assert.equal(runtime.status().memoryReflection?.lastCompletedDay, "2026-07-21");
    assert.equal(runtime.status().memoryReflection?.nextDay, "2026-07-22");
  } finally {
    runtime.close();
  }
});

test("keeps a failed Memory reflection day pending across restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-reflection-retry-"));
  let now = new Date("2026-07-21T12:00:00.000Z");
  const requests: Array<{ day: string; activityIds: string[]; eventTurnIds: string[] }> = [];
  const first = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: completingExecution,
    activityLifecycle,
    activityRecorder: recorder([]),
    memoryReflection: memoryReflector(requests, new Error("reflection unavailable")),
    now: () => now,
  });
  const firstScheduler = createScheduler({
    runtime: first,
    activityIdleMs: 1,
    memoryReflection: { delayMs: 0, retryDelayMs: 30_000 },
  });
  await firstScheduler.runOnce(now);
  await first.acceptInput({ source: "test", sourceId: "memory", kind: "interaction", payload: {} });
  await firstScheduler.runOnce(now);
  now = new Date("2026-07-21T12:00:00.001Z");
  await firstScheduler.runOnce(now);
  now = new Date("2026-07-22T03:00:00.000Z");
  assert.deepEqual(await firstScheduler.runOnce(now), {
    disposition: "deferred",
    reason: "memory_reflection_failed",
    nextRunAt: "2026-07-22T03:00:30.000Z",
  });
  first.close();

  now = new Date("2026-07-22T03:00:30.000Z");
  const recovered = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    memoryReflection: memoryReflector(requests),
    now: () => now,
  });
  try {
    const recoveredScheduler = createScheduler({
      runtime: recovered,
      memoryReflection: { delayMs: 0, retryDelayMs: 30_000 },
    });
    await recoveredScheduler.runOnce(now);
    assert.deepEqual(requests.map(request => request.day), ["2026-07-21", "2026-07-21"]);
    assert.equal(recovered.status().memoryReflection?.lastCompletedDay, "2026-07-21");
  } finally {
    recovered.close();
  }
});

test("advances an empty Memory reflection day without model work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-reflection-empty-"));
  let now = new Date("2026-07-21T12:00:00.000Z");
  const requests: Array<{ day: string; activityIds: string[]; eventTurnIds: string[] }> = [];
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    memoryReflection: memoryReflector(requests),
    now: () => now,
  });
  const scheduler = createScheduler({
    runtime,
    memoryReflection: { delayMs: 0 },
  });
  try {
    await scheduler.runOnce(now);
    now = new Date("2026-07-22T03:00:00.000Z");
    assert.deepEqual(await scheduler.runOnce(now), {
      disposition: "waiting",
      nextRunAt: "2026-07-23T03:00:00.000Z",
    });
    assert.deepEqual(requests, []);
    assert.equal(runtime.status().memoryReflection?.lastCompletedDay, "2026-07-21");
  } finally {
    runtime.close();
  }
});

test("does not claim a due Memory reflection while model work is blocked", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-reflection-blocked-"));
  let now = new Date("2026-07-21T12:00:00.000Z");
  const requests: Array<{ day: string; activityIds: string[]; eventTurnIds: string[] }> = [];
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: completingExecution,
    activityLifecycle,
    activityRecorder: recorder([]),
    memoryReflection: memoryReflector(requests),
    now: () => now,
  });
  const scheduler = createScheduler({
    runtime,
    admitAgentWork: () => false,
    memoryReflection: { delayMs: 0 },
  });
  try {
    await scheduler.runOnce(now);
    await runtime.acceptInput({ source: "test", sourceId: "blocked-memory", kind: "interaction", payload: {} });
    await runtime.advance();
    now = new Date("2026-07-21T12:00:00.001Z");
    await runtime.closeActivity();
    await runtime.advance();
    now = new Date("2026-07-22T03:00:00.000Z");
    assert.deepEqual(await scheduler.runOnce(now), {
      disposition: "deferred",
      reason: "agent_work_not_admitted",
    });
    assert.deepEqual(requests, []);
    assert.equal(runtime.status().memoryReflection?.nextDay, "2026-07-21");
  } finally {
    runtime.close();
  }
});

test("keeps recovered tool activity inside the idle interval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-tool-recovery-"));
  let now = new Date("2026-07-21T12:00:00.000Z");
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => {
    markStarted = resolve;
  });
  const execution: AgentExecution = {
    start(request, control) {
      control.prepareExecutionState({ version: 1 });
      control.includeInput(request.inputs[0]!.id);
      now = new Date("2026-07-21T12:40:00.000Z");
      control.recordToolActivity({
        toolCallId: "tool-1",
        toolName: "write",
        callArguments: { path: "notes/idea.md" },
        result: { status: "written" },
      });
      markStarted();
      return {
        result: new Promise(() => {}),
        steer: async () => {},
        abort: async () => {},
      };
    },
  };
  const interrupted = openRuntime({
    root,
    execution,
    ownerId: "interrupted-scheduler-runtime",
    leaseDurationMs: 1_000,
    now: () => now,
  });
  await interrupted.acceptInput({
    source: "test-channel",
    sourceId: "private-work",
    kind: "opportunity",
    payload: { text: "follow the idea" },
  });
  void interrupted.advance();
  await started;
  interrupted.close();

  now = new Date("2026-07-21T12:41:00.000Z");
  const recovered = openRuntime({
    root,
    ownerId: "recovered-scheduler-runtime",
    activityLifecycle,
    leaseDurationMs: 1_000,
    now: () => now,
  });
  try {
    const scheduler = createScheduler({ runtime: recovered, activityIdleMs: 30 * 60 * 1_000 });
    assert.deepEqual(await scheduler.runOnce(now), {
      disposition: "waiting",
      nextRunAt: "2026-07-21T13:10:00.000Z",
    });
    assert.equal(recovered.status().activeSegment?.lastActivityAt, "2026-07-21T12:40:00.000Z");
  } finally {
    recovered.close();
  }
});

test("retries pending Activity recording through Scheduler after restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-recorder-recovery-"));
  let now = new Date("2026-07-21T14:00:00.000Z");
  const failed: string[] = [];
  const firstRuntime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle,
    activityRecorder: failingRecorder(failed),
    now: () => now,
  });
  const firstScheduler = createScheduler({ runtime: firstRuntime });
  await firstRuntime.acceptInput({
    source: "test-channel",
    sourceId: "record-after-restart",
    kind: "interaction",
    payload: { text: "remember this" },
  });
  assert.equal((await firstScheduler.runOnce(now)).disposition, "waiting");

  now = new Date("2026-07-21T14:30:00.000Z");
  assert.deepEqual(await firstScheduler.runOnce(now), {
    disposition: "deferred",
    reason: "activity_recording_failed",
    nextRunAt: "2026-07-21T14:45:00.000Z",
  });
  const activityId = firstRuntime.status().activities[0]?.id;
  assert.ok(activityId);
  assert.deepEqual(failed, [activityId]);
  assert.equal(firstRuntime.status().activities[0]?.status, "pending");
  firstRuntime.close();

  const recorded: string[] = [];
  const recovered = openRuntime({
    root,
    ownerId: "recovered-recorder-runtime",
    activityRecorder: recorder(recorded),
    now: () => now,
  });
  try {
    const recoveredScheduler = createScheduler({ runtime: recovered });
    assert.deepEqual(await recoveredScheduler.runOnce(now), { disposition: "idle" });
    assert.deepEqual(recorded, [activityId]);
    assert.equal(recovered.status().activities.length, 1);
    assert.equal(recovered.status().activities[0]?.status, "recorded");
  } finally {
    recovered.close();
  }
});

test("maintains changed Thread material once after Activity recording", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-thread-maintenance-"));
  let now = new Date("2026-07-21T16:00:00.000Z");
  const maintained: string[] = [];
  const execution: AgentExecution = {
    start(request, control) {
      control.prepareExecutionState({ version: 1 });
      control.includeInput(request.inputs[0]!.id);
      control.recordToolActivity({
        toolCallId: "write-thread-note",
        toolName: "write",
        callArguments: { path: "threads/garden/observation.md", content: "new observation" },
        result: { status: "written" },
      });
      return {
        result: Promise.resolve({
          outcome: "completed",
          inputAnchors: request.inputs.map(input => ({
            inputId: input.id,
            transcriptAnchor: {
              sourceId: request.recordingDay,
              sessionId: "thread-session",
              entryId: `input-${input.id}`,
            },
          })),
          transcriptAnchor: {
            sourceId: request.recordingDay,
            sessionId: "thread-session",
            entryId: `turn-${request.turnId}`,
          },
          executionState: { version: 1, turnId: request.turnId },
          executionRecord: { version: 1, turnId: request.turnId },
        }),
        steer: async input => control.includeInput(input.id),
        abort: async () => {},
      };
    },
  };
  const threadMaintenance: ThreadMaintenance = {
    observationsFor: activity => activity.events.some(event => event.kind === "tool_call")
      ? [{
          turnId: activity.turns[0]!.turnId,
          threadPath: "garden",
          relation: "changed",
          paths: ["garden/observation.md"],
        }]
      : [],
    maintain: async request => {
      maintained.push(request.activity.segmentId);
      return { outcome: "no_change", runId: "maintain-garden", changedPaths: [] };
    },
  };
  const runtime = openRuntime({
    root,
    execution,
    activityLifecycle: {
      freeze: async request => ({
        activity: {
          version: 1,
          segmentId: request.segment.id,
          recordingDay: request.segment.recordingDay,
          openedAt: request.segment.openedAt,
          closedAt: request.segment.closedAt,
          events: request.toolActivities.flatMap(activity => [{
            eventId: `tool-call:${activity.turnId}:${activity.toolCallId}`,
            turnId: activity.turnId,
            at: activity.completedAt,
            actorRef: "individual" as const,
            kind: "tool_call" as const,
            content: {
              toolCallId: activity.toolCallId,
              toolName: activity.toolName,
              arguments: activity.callArguments,
            },
          }]),
          turns: request.turns.map(turn => ({
            turnId: turn.id,
            startedAt: turn.startedAt,
            endedAt: turn.endedAt,
            status: turn.status,
          })),
        },
        successorExecutionState: { version: 1 },
      }),
    },
    activityRecorder: recorder([]),
    threadMaintenance,
    now: () => now,
  });
  const scheduler = createScheduler({ runtime });
  t.after(() => runtime.close());

  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "changed-thread",
    kind: "interaction",
    payload: { text: "continue the garden line" },
  });
  assert.equal((await scheduler.runOnce(now)).disposition, "waiting");

  now = new Date("2026-07-21T16:30:00.000Z");
  assert.deepEqual(await scheduler.runOnce(now), { disposition: "idle" });
  assert.equal(runtime.status().activities[0]?.status, "recorded");
  assert.deepEqual(maintained, [runtime.status().activities[0]!.id]);
  assert.equal(runtime.status().threadMaintenance[0]?.status, "completed");

  await scheduler.runOnce(now);
  assert.equal(maintained.length, 1);
});

test("keeps failed Thread maintenance pending across restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-thread-recovery-"));
  let now = new Date("2026-07-21T17:00:00.000Z");
  const observationsFor: ThreadMaintenance["observationsFor"] = activity => [{
    turnId: activity.turns[0]!.turnId,
    threadPath: "garden",
    relation: "changed",
    paths: ["garden/thread.md"],
  }];
  const firstRuntime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle,
    activityRecorder: recorder([]),
    threadMaintenance: {
      observationsFor,
      maintain: async () => {
        throw new Error("thread maintainer unavailable");
      },
    },
    now: () => now,
  });
  const firstScheduler = createScheduler({ runtime: firstRuntime });
  await firstRuntime.acceptInput({
    source: "test-channel",
    sourceId: "maintain-after-restart",
    kind: "interaction",
    payload: { text: "continue the line" },
  });
  await firstScheduler.runOnce(now);

  now = new Date("2026-07-21T17:30:00.000Z");
  assert.deepEqual(await firstScheduler.runOnce(now), {
    disposition: "deferred",
    reason: "thread_maintenance_failed",
    nextRunAt: "2026-07-21T17:45:00.000Z",
  });
  const activityId = firstRuntime.status().activities[0]?.id;
  assert.ok(activityId);
  assert.equal(firstRuntime.status().threadMaintenance[0]?.status, "pending");
  assert.equal(firstRuntime.status().threadMaintenance[0]?.attempts, 1);
  assert.match(firstRuntime.status().threadMaintenance[0]?.lastError ?? "", /unavailable/);
  firstRuntime.close();

  const maintained: string[] = [];
  const recovered = openRuntime({
    root,
    ownerId: "recovered-thread-maintenance-runtime",
    threadMaintenance: {
      observationsFor,
      maintain: async request => {
        maintained.push(request.activity.segmentId);
        return { outcome: "no_change", runId: "recovered-maintenance", changedPaths: [] };
      },
    },
    now: () => now,
  });
  try {
    const scheduler = createScheduler({ runtime: recovered });
    assert.deepEqual(await scheduler.runOnce(now), { disposition: "idle" });
    assert.deepEqual(maintained, [activityId]);
    assert.equal(recovered.status().threadMaintenance[0]?.status, "completed");
    assert.equal(recovered.status().threadMaintenance[0]?.attempts, 2);
    assert.equal(recovered.status().threadMaintenance[0]?.lastError, undefined);
  } finally {
    recovered.close();
  }
});

test("does not claim pending Thread maintenance while agent work is deferred", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-scheduler-thread-blocked-"));
  const now = new Date("2026-07-21T18:00:00.000Z");
  let maintenanceCalls = 0;
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle,
    activityRecorder: recorder([]),
    threadMaintenance: {
      observationsFor: activity => [{
        turnId: activity.turns[0]!.turnId,
        threadPath: "garden",
        relation: "changed",
        paths: ["garden/thread.md"],
      }],
      maintain: async () => {
        maintenanceCalls += 1;
        return { outcome: "no_change", runId: "blocked-maintenance", changedPaths: [] };
      },
    },
    now: () => now,
  });
  t.after(() => runtime.close());
  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "blocked-thread-maintenance",
    kind: "interaction",
    payload: { text: "continue" },
  });
  await runtime.advance();
  await runtime.closeActivity();
  assert.equal((await runtime.advance()).disposition, "activity_recorded");

  const scheduler = createScheduler({ runtime, admitAgentWork: () => false });
  assert.deepEqual(await scheduler.runOnce(now), {
    disposition: "deferred",
    reason: "agent_work_not_admitted",
  });
  assert.equal(maintenanceCalls, 0);
  assert.equal(runtime.status().threadMaintenance[0]?.status, "pending");
  assert.equal(runtime.status().threadMaintenance[0]?.attempts, 0);
});
