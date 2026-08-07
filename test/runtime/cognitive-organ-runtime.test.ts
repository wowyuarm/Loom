import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  openRuntime,
  type ActivityLifecycle,
  type ActivityRecorder,
  type AgentExecution,
  type FrozenActivity,
  type RunningExecution,
  type TurnControl,
  type TurnRequest,
} from "../../src/runtime/index.js";
import { createTimePolicy } from "../../src/configuration/index.js";
import { COGNITIVE_ORGAN_POLICY } from "../../src/runtime/cognitive-organ-execution.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const completingExecution: AgentExecution = {
  start(request: TurnRequest, control: TurnControl): RunningExecution {
    control.prepareExecutionState(request.executionState ?? { version: 1 });
    control.includeInput(request.inputs[0]!.id);
    return {
      result: Promise.resolve({
        outcome: "completed",
        inputAnchors: request.inputs.map(input => ({
          inputId: input.id,
          transcriptAnchor: {
            sourceId: request.recordingDay,
            sessionId: "session-1",
            entryId: `input-${input.id}`,
          },
        })),
        transcriptAnchor: {
          sourceId: request.recordingDay,
          sessionId: "session-1",
          entryId: `entry-${request.turnId}`,
        },
        executionState: { version: 1, turnId: request.turnId },
        executionRecord: { version: 1, turnId: request.turnId },
      }),
      steer: async input => control.includeInput(input.id),
      abort: async () => {},
    };
  },
};

function activityLifecycle(): ActivityLifecycle {
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
        })),
      },
      successorExecutionState: { version: 1 },
    }),
  };
}

function receiptFor(activity: FrozenActivity, runId: string): Awaited<ReturnType<ActivityRecorder["record"]>> {
  return {
    version: 1,
    segmentId: activity.segmentId,
    runId,
    recordedAt: "2026-07-19T12:00:00.000Z",
    daily: { status: "no_change", path: `daily/${activity.recordingDay}.md` },
    episodes: [],
  };
}

/**
 * Run one Turn for a pending Input, freeze its Activity and start its
 * recording; resolves once the recorder has begun (its record() call
 * resolved `started`).
 */
async function startRecording(
  runtime: ReturnType<typeof openRuntime>,
  started: Promise<void>,
): Promise<{ organRun: Promise<unknown> }> {
  await runtime.advance();
  await runtime.closeActivity();
  const organRun = runtime.advance();
  await started;
  return { organRun };
}

function readLedger(db: DatabaseSync): {
  work: Record<string, unknown>;
  attempts: Array<Record<string, unknown>>;
} {
  // Newest work first: single-writer tests may hold an older completed work
  // alongside the held one.
  const work = db.prepare("SELECT * FROM cognitive_work ORDER BY created_at DESC, rowid DESC").all() as Array<
    Record<string, unknown>
  >;
  const attempts = db.prepare("SELECT * FROM cognitive_attempts ORDER BY attempt_number").all() as Array<
    Record<string, unknown>
  >;
  return { work: work[0]!, attempts };
}

test("soft deadline only signals cancel; a released organ closes the work as cancelled", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-soft-deadline-"));
  const now = new Date("2026-07-19T11:00:00.000Z");
  const recording = deferred<Awaited<ReturnType<ActivityRecorder["record"]>>>();
  const started = deferred<void>();
  const cancelReasons: string[] = [];
  const timerCalls: Array<{ delayMs: number; callback: () => void }> = [];
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async () => {
        started.resolve();
        return recording.promise;
      },
      cancel: async reason => {
        cancelReasons.push(reason);
        recording.reject(new Error("released"));
      },
    },
    // Test-controlled soft deadline: the runtime registers a timer instead of
    // waiting 10 real minutes.
    organCancelTimer: (delayMs, callback) => {
      timerCalls.push({ delayMs, callback });
      return { clear: () => {} };
    },
    now: () => now,
  });

  await runtime.acceptInput({
    source: "test",
    sourceId: "pending-recording",
    kind: "interaction",
    payload: { text: "record me" },
  });
  const { organRun } = await startRecording(runtime, started.promise);
  assert.equal(timerCalls.length, 1);
  assert.equal(timerCalls[0]!.delayMs, COGNITIVE_ORGAN_POLICY.softDeadlineMs);

  // The deadline fires without killing anything: the recorder gets a cancel
  // signal only, and releases its own work.
  now.setTime(now.getTime() + COGNITIVE_ORGAN_POLICY.softDeadlineMs);
  timerCalls[0]!.callback();
  assert.deepEqual(cancelReasons, ["soft_deadline"]);
  assert.deepEqual(await organRun, { disposition: "busy" });
  assert.equal(runtime.status().activities[0]?.status, "pending");

  runtime.close();
  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const ledger = readLedger(db);
  db.close();
  assert.equal(ledger.work.status, "cancelled");
  assert.equal(ledger.work.last_cancel_reason, "soft_deadline");
  assert.equal(ledger.attempts.length, 1);
  assert.equal(ledger.attempts[0]!.status, "cancelled");
  assert.equal(ledger.attempts[0]!.cancel_reason, "soft_deadline");
});

test("a cancel that is not released persists intervention_required and blocks parallel organ starts", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-single-writer-"));
  let now = new Date("2026-07-19T12:00:00.000Z");
  const attentionHang = deferred<{ outcome: "no_change"; runId: string; path: string }>();
  const attentionStarted = deferred<void>();
  let reflectionCalls = 0;
  let recorderCalls = 0;
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => {
        recorderCalls += 1;
        return receiptFor(activity, `record-${recorderCalls}`);
      },
      cancel: async () => {},
    },
    attentionMaintenance: {
      maintain: async () => {
        attentionStarted.resolve();
        return attentionHang.promise;
      },
      // The organ ignores the cancel; its run never releases.
      cancel: async () => {},
    },
    memoryReflection: {
      reflect: async () => {
        reflectionCalls += 1;
        return { outcome: "no_change", runId: "reflection-held", changedMaterials: [] };
      },
    },
    cognitiveOrganPolicy: { ...COGNITIVE_ORGAN_POLICY, cancelGraceMs: 50 },
    now: () => now,
  });

  // One recorded Activity for reflection day 2026-07-19; both maintenance
  // schedules are established but not yet due.
  await runtime.acceptInput({
    source: "test",
    sourceId: "day-one",
    kind: "interaction",
    payload: { text: "day one" },
  });
  await runtime.advance();
  await runtime.closeActivity();
  await runtime.advance();
  assert.deepEqual(
    await runtime.runMemoryReflection({
      observedAt: now,
      delayMs: 0,
      retryDelayMs: 30_000,
      agentWork: "allow",
    }),
    { disposition: "waiting", nextRunAt: "2026-07-20T03:00:00.000Z" },
  );
  assert.deepEqual(
    await runtime.runAttentionMaintenance({
      observedAt: now,
      initialDelayMs: 1,
      cadenceMs: 60_000,
      retryDelayMs: 30_000,
      agentWork: "allow",
    }),
    { disposition: "waiting", nextRunAt: "2026-07-19T12:00:00.001Z" },
  );

  // Due time: the attention organ starts and hangs; it ignores the cancel.
  now = new Date("2026-07-20T04:00:01.000Z");
  const attentionRun = runtime.runAttentionMaintenance({
    observedAt: now,
    initialDelayMs: 1,
    cadenceMs: 60_000,
    retryDelayMs: 30_000,
    agentWork: "allow",
  });
  await attentionStarted.promise;
  const human = await runtime.acceptInput({
    source: "test",
    sourceId: "human-while-held",
    kind: "interaction",
    payload: { text: "please answer" },
  });
  assert.equal(human.disposition, "accepted");
  // The foreground Input stays durable while the organ is held.
  assert.equal(
    runtime.status().inputs.find(input => input.id === human.inputId)?.status,
    "pending",
  );

  // Single-writer gate: the due Reflection cannot start while
  // intervention_required work is held, and no parallel Workspace writer (the
  // turn for the durable Input) is started either.
  assert.deepEqual(
    await runtime.runMemoryReflection({
      observedAt: now,
      delayMs: 0,
      retryDelayMs: 30_000,
      agentWork: "allow",
    }),
    { disposition: "busy" },
  );
  assert.equal(reflectionCalls, 0);
  assert.deepEqual(await runtime.advance(), { disposition: "busy" });
  assert.equal(
    runtime.status().inputs.find(input => input.id === human.inputId)?.status,
    "pending",
  );

  runtime.close();
  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const ledger = readLedger(db);
  db.close();
  assert.equal(ledger.work.status, "intervention_required");
  assert.match(String(ledger.work.last_cancel_reason), /new_human_input/);
  // attentionRun intentionally stays unsettled: the organ never releases.
});

test("restart recovers a leftover running attempt as interrupted with policy backoff", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-restart-"));
  let now = new Date("2026-07-19T11:00:00.000Z");
  const recording = deferred<Awaited<ReturnType<ActivityRecorder["record"]>>>();
  const started = deferred<void>();
  const first = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async () => {
        started.resolve();
        return recording.promise;
      },
      cancel: async () => {},
    },
    now: () => now,
  });
  await first.acceptInput({
    source: "test",
    sourceId: "pending-recording",
    kind: "interaction",
    payload: { text: "record me" },
  });
  await startRecording(first, started.promise);
  // Simulates a restart while the attempt is still running in the ledger.
  first.close();

  // Past the domain lease (30s) but not the ledger backoff (1 minute): the
  // recovery is visible but the retry is still gated.
  now = new Date("2026-07-19T11:01:01.000Z");
  const recovered = openRuntime({
    root,
    ownerId: "recovered-runtime",
    activityRecorder: {
      record: async activity => receiptFor(activity, "recorder-after-restart"),
      cancel: async () => {},
    },
    now: () => now,
  });
  t.after(() => recovered.close());
  assert.equal(recovered.status().activities[0]?.status, "pending");

  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const ledger = readLedger(db);
  db.close();
  assert.equal(ledger.work.status, "retry_wait");
  assert.equal(ledger.work.last_failure_category, "interrupted");
  assert.equal(ledger.attempts.length, 1);
  assert.equal(ledger.attempts[0]!.status, "failed");
  assert.equal(ledger.attempts[0]!.failure_category, "interrupted");

  // Once the policy backoff has elapsed the same frozen evidence is retried
  // from the immutable input, not continued from the lost run.
  now = new Date("2026-07-19T11:02:01.000Z");
  assert.deepEqual(await recovered.advance(), { disposition: "activity_recorded" });
  assert.equal(recovered.status().activities[0]?.status, "recorded");
  const history = recovered.operationalStatus({ since: "2026-07-19T00:00:00.000Z" })
    .agents.find(agent => agent.name === "life-recorder")?.history?.map(run => run.result);
  assert.deepEqual(history, ["interrupted", "succeeded"]);
});

test("fixes the Model Runtime Revision per attempt and links transcript and result references", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-revision-"));
  let now = new Date("2026-07-19T11:00:00.000Z");
  let revision = "rev-1";
  let attempts = 0;
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    revisions: { current: () => ({ id: revision }) },
    activityRecorder: {
      record: async activity => {
        attempts += 1;
        if (attempts === 1) throw new Error("recorder unavailable");
        return receiptFor(activity, `run-${attempts}`);
      },
      cancel: async () => {},
    },
    now: () => now,
  });

  await runtime.acceptInput({
    source: "test",
    sourceId: "pending-recording",
    kind: "interaction",
    payload: { text: "record me" },
  });
  await runtime.advance();
  await runtime.closeActivity();
  assert.deepEqual(await runtime.advance(), { disposition: "activity_recording_failed" });

  // The revision is fixed when the second attempt starts; later changes do not
  // rewrite the first attempt's record.
  revision = "rev-2";
  now = new Date("2026-07-19T11:01:00.001Z");
  assert.deepEqual(await runtime.advance(), { disposition: "activity_recorded" });

  runtime.close();
  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const ledger = readLedger(db);
  db.close();
  assert.equal(ledger.work.status, "completed");
  assert.equal(ledger.attempts.length, 2);
  assert.equal(ledger.attempts[0]!.model_revision, "rev-1");
  assert.equal(ledger.attempts[0]!.status, "failed");
  assert.equal(ledger.attempts[1]!.model_revision, "rev-2");
  assert.equal(ledger.attempts[1]!.status, "completed");
  assert.equal(ledger.attempts[1]!.transcript_ref, "organs/life-recorder/run-2.jsonl");
  assert.equal(ledger.attempts[1]!.result_ref, "daily/2026-07-19.md");
});

test("records unpinned as the Model Runtime Revision when no provider is configured", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-revision-unpinned-"));
  const now = new Date("2026-07-19T11:00:00.000Z");
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, "unpinned-recorder"),
      cancel: async () => {},
    },
    now: () => now,
  });

  await runtime.acceptInput({
    source: "test",
    sourceId: "pending-recording",
    kind: "interaction",
    payload: { text: "record me" },
  });
  await runtime.advance();
  await runtime.closeActivity();
  assert.deepEqual(await runtime.advance(), { disposition: "activity_recorded" });

  runtime.close();
  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const ledger = readLedger(db);
  db.close();
  assert.equal(ledger.attempts[0]!.model_revision, "unpinned");
});

test("human preemption releases the attempt back to pending without consuming retry quota", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-preempt-ledger-"));
  const now = new Date("2026-07-19T11:00:00.000Z");
  const recording = deferred<Awaited<ReturnType<ActivityRecorder["record"]>>>();
  const started = deferred<void>();
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async () => {
        started.resolve();
        return recording.promise;
      },
      cancel: async () => {
        recording.reject(new Error("cancelled for human Input"));
      },
    },
    now: () => now,
  });

  await runtime.acceptInput({
    source: "test",
    sourceId: "pending-recording",
    kind: "interaction",
    payload: { text: "record me" },
  });
  const { organRun } = await startRecording(runtime, started.promise);
  const human = await runtime.acceptInput({
    source: "test",
    sourceId: "interrupting-human",
    kind: "interaction",
    payload: { text: "please answer now" },
  });
  assert.equal(human.disposition, "accepted");
  assert.deepEqual(await organRun, { disposition: "busy" });
  assert.equal(runtime.status().activities[0]?.status, "pending");

  runtime.close();
  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const ledger = readLedger(db);
  db.close();
  assert.equal(ledger.work.status, "cancelled");
  assert.equal(ledger.work.last_cancel_reason, "new_human_input");
  assert.equal(ledger.attempts.length, 1);
  assert.equal(ledger.attempts[0]!.status, "cancelled");
  assert.equal(ledger.attempts[0]!.cancel_reason, "new_human_input");
});

test("a Life Recorder receipt for another segment fails without superseding domain state", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-wrong-receipt-"));
  const now = new Date("2026-07-19T11:00:00.000Z");
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async () => receiptFor({ segmentId: "wrong-segment" } as FrozenActivity, "wrong-run"),
      cancel: async () => {},
    },
    now: () => now,
  });

  await runtime.acceptInput({
    source: "test",
    sourceId: "pending-recording",
    kind: "interaction",
    payload: { text: "record me" },
  });
  await runtime.advance();
  await runtime.closeActivity();
  assert.deepEqual(await runtime.advance(), { disposition: "activity_recording_failed" });
  assert.equal(runtime.status().activities[0]?.status, "pending");
  assert.match(runtime.status().activities[0]?.lastError ?? "", /belongs to wrong-segment/);
  assert.equal(runtime.status().activities[0]?.attempts, 1);

  runtime.close();
  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const ledger = readLedger(db);
  db.close();
  assert.equal(ledger.work.status, "retry_wait");
  assert.equal(ledger.attempts.length, 1);
  assert.equal(ledger.attempts[0]!.status, "failed");
});

test("a newer attention window starts a fresh budget cycle and never reuses the retried work", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-fresh-window-"));
  let now = new Date("2026-07-19T11:00:00.000Z");
  let maintainCalls = 0;
  let recentActivityIds: string[] = [];
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, `record-${activity.segmentId}`),
      cancel: async () => {},
    },
    attentionMaintenance: {
      maintain: async options => {
        maintainCalls += 1;
        recentActivityIds = options.recentActivities.map(activity => activity.segmentId);
        if (maintainCalls === 1) throw new Error("provider unavailable");
        return { outcome: "no_change", runId: `attention-${maintainCalls}`, path: "notes/attention.md" };
      },
      cancel: async () => {},
    },
    now: () => now,
  });

  // One activity in the first window; the first maintenance run fails into
  // retry_wait with domainRef window:1.
  await runtime.acceptInput({
    source: "test",
    sourceId: "day-one",
    kind: "interaction",
    payload: { text: "day one" },
  });
  await runtime.advance();
  await runtime.closeActivity();
  await runtime.advance();
  assert.deepEqual(
    await runtime.runAttentionMaintenance({
      observedAt: now,
      initialDelayMs: 1,
      cadenceMs: 60_000,
      retryDelayMs: 30_000,
      agentWork: "allow",
    }),
    { disposition: "waiting", nextRunAt: "2026-07-19T11:00:00.001Z" },
  );
  now = new Date("2026-07-19T11:00:00.001Z");
  assert.deepEqual(
    await runtime.runAttentionMaintenance({
      observedAt: now,
      initialDelayMs: 1,
      cadenceMs: 60_000,
      retryDelayMs: 30_000,
      agentWork: "allow",
    }),
    { disposition: "failed", nextRunAt: "2026-07-19T11:01:00.001Z", error: "provider unavailable" },
  );

  // A second activity arrives and the schedule window is reset (as a
  // cancelled run would), so the next due window is wider: window:2. The old
  // retry_wait work must keep its own budget instead of running the new
  // window's input as its second attempt.
  await runtime.acceptInput({
    source: "test",
    sourceId: "day-two",
    kind: "interaction",
    payload: { text: "day two" },
  });
  await runtime.advance();
  await runtime.closeActivity();
  await runtime.advance();
  const windowDb = new DatabaseSync(path.join(root, "runtime.db"));
  windowDb.prepare("UPDATE attention_maintenance SET window_end_sequence = NULL WHERE singleton = 1").run();
  windowDb.close();

  now = new Date("2026-07-19T12:00:00.000Z");
  assert.deepEqual(
    await runtime.runAttentionMaintenance({
      observedAt: now,
      initialDelayMs: 1,
      cadenceMs: 60_000,
      retryDelayMs: 30_000,
      agentWork: "allow",
    }),
    {
      disposition: "completed",
      result: { outcome: "no_change", runId: "attention-2", path: "notes/attention.md" },
      nextRunAt: "2026-07-19T12:01:00.000Z",
    },
  );
  assert.equal(maintainCalls, 2);
  // The fresh run read the wider window: both activities, not only the first.
  assert.equal(recentActivityIds.length, 2);

  runtime.close();
  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const work = db.prepare(
    "SELECT id, organ, domain_ref, status FROM cognitive_work WHERE organ = 'attention-maintainer' ORDER BY created_at, rowid",
  ).all() as Array<Record<string, unknown>>;
  const attempts = db.prepare(
    "SELECT work_id, attempt_number, status FROM cognitive_attempts "
      + "WHERE work_id IN (SELECT id FROM cognitive_work WHERE organ = 'attention-maintainer') ORDER BY rowid",
  ).all() as Array<Record<string, unknown>>;
  db.close();
  assert.equal(work.length, 2);
  assert.deepEqual(
    { id: work[0]!.id, domain_ref: work[0]!.domain_ref, status: work[0]!.status },
    { id: work[0]!.id, domain_ref: "window:1", status: "retry_wait" },
  );
  assert.deepEqual(
    { id: work[1]!.id, domain_ref: work[1]!.domain_ref, status: work[1]!.status },
    { id: work[1]!.id, domain_ref: "window:2", status: "completed" },
  );
  // The second attempt ran on the fresh window's work, not as a retry of the
  // old budget.
  assert.deepEqual(attempts.map(attempt => ({ workId: attempt.work_id, attemptNumber: attempt.attempt_number, status: attempt.status })), [
    { workId: work[0]!.id, attemptNumber: 1, status: "failed" },
    { workId: work[1]!.id, attemptNumber: 1, status: "completed" },
  ]);
});

test("a retry continues the same reflection day on the same work", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-same-day-retry-"));
  let now = new Date("2026-07-19T12:00:00.000Z");
  let reflectCalls = 0;
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, "recorder"),
      cancel: async () => {},
    },
    memoryReflection: {
      reflect: async () => {
        reflectCalls += 1;
        if (reflectCalls === 1) throw new Error("provider unavailable");
        return { outcome: "no_change", runId: "reflection-2", changedMaterials: [] };
      },
      cancel: async () => {},
    },
    now: () => now,
  });

  await runtime.acceptInput({
    source: "test",
    sourceId: "day-one",
    kind: "interaction",
    payload: { text: "day one" },
  });
  await runtime.advance();
  await runtime.closeActivity();
  await runtime.advance();
  // The schedule is due after the recording day ends; the first call only
  // establishes it.
  assert.deepEqual(
    await runtime.runMemoryReflection({
      observedAt: now,
      delayMs: 0,
      retryDelayMs: 30_000,
      agentWork: "allow",
    }),
    { disposition: "waiting", nextRunAt: "2026-07-20T03:00:00.000Z" },
  );
  now = new Date("2026-07-20T04:00:01.000Z");
  assert.deepEqual(
    await runtime.runMemoryReflection({
      observedAt: now,
      delayMs: 0,
      retryDelayMs: 30_000,
      agentWork: "allow",
    }),
    { disposition: "failed", reflectionDay: "2026-07-19", nextRunAt: "2026-07-20T04:01:01.000Z", error: "provider unavailable" },
  );

  // After the policy backoff the same day is retried on the same work: the
  // second attempt continues the immutable day input, not a new one.
  now = new Date("2026-07-20T04:01:01.001Z");
  assert.deepEqual(
    await runtime.runMemoryReflection({
      observedAt: now,
      delayMs: 0,
      retryDelayMs: 30_000,
      agentWork: "allow",
    }),
    {
      disposition: "completed",
      reflectionDay: "2026-07-19",
      result: { outcome: "no_change", runId: "reflection-2", changedMaterials: [] },
      nextRunAt: "2026-07-21T03:00:00.000Z",
    },
  );
  assert.equal(reflectCalls, 2);

  runtime.close();
  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const work = db.prepare(
    "SELECT id, domain_ref, status FROM cognitive_work WHERE organ = 'memory-reflector'",
  ).all() as Array<Record<string, unknown>>;
  const attempts = db.prepare(
    "SELECT work_id, attempt_number, status FROM cognitive_attempts WHERE work_id = ? ORDER BY attempt_number, rowid",
  ).all(String(work[0]!.id)) as Array<Record<string, unknown>>;
  db.close();
  assert.equal(work.length, 1);
  assert.deepEqual(
    { id: work[0]!.id, domain_ref: work[0]!.domain_ref, status: work[0]!.status },
    { id: work[0]!.id, domain_ref: "day:2026-07-19", status: "completed" },
  );
  assert.deepEqual(attempts.map(attempt => ({ workId: attempt.work_id, attemptNumber: attempt.attempt_number, status: attempt.status })), [
    { workId: work[0]!.id, attemptNumber: 1, status: "failed" },
    { workId: work[0]!.id, attemptNumber: 2, status: "completed" },
  ]);
});
