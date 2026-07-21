import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createScheduler,
  openRuntime,
  type ActivityLifecycle,
  type ActivityRecorder,
  type AgentExecution,
} from "../../src/runtime/index.js";

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
    { disposition: "not_due", lastActivityAt: "2026-07-21T10:20:00.000Z" },
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
