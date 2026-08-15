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
  type RuntimeOptions,
  type TurnControl,
  type TurnRequest,
} from "../../src/runtime/index.js";
import type { OperationalEvent } from "../../src/operational-events.js";
import { createTimePolicy } from "../../src/configuration/index.js";
import { COGNITIVE_ORGAN_POLICY } from "../../src/runtime/cognitive-organ-execution.js";
import { PiCognitiveOrganTurnLimitError } from "../../src/agents/session/index.js";

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

test("blocked Life Recorder work releases the scheduler and remains requeueable", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-blocked-recorder-"));
  let now = new Date("2026-07-19T11:00:00.000Z");
  let attentionCalls = 0;
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async () => { throw new Error("workspace is not writable"); },
      cancel: async () => {},
    },
    threadMaintenance: {
      observationsFor: activity => [{
        turnId: activity.turns[0]!.turnId,
        threadPath: "thread.md",
        relation: "changed",
        paths: ["thread.md"],
      }],
      maintain: async () => ({ outcome: "no_change", runId: "unreachable", changedPaths: [] }),
      cancel: async () => {},
    },
    attentionMaintenance: {
      maintain: async () => {
        attentionCalls += 1;
        return { outcome: "no_change", runId: "attention-after-block", path: "attention.md" };
      },
      cancel: async () => {},
    },
    now: () => now,
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({
    source: "test",
    sourceId: "blocked-recorder",
    kind: "interaction",
    payload: { text: "record me" },
  });
  await runtime.advance();
  await runtime.closeActivity();

  assert.equal((await runtime.advance()).disposition, "activity_recording_failed");
  now = new Date("2026-07-19T11:01:00.000Z");
  assert.equal((await runtime.advance()).disposition, "activity_recording_failed");
  now = new Date("2026-07-19T11:06:00.000Z");
  assert.equal((await runtime.advance()).disposition, "activity_recording_failed");

  const blocked = runtime.status().cognitiveOrganWork.find(entry => entry.organ === "life-recorder");
  assert.equal(blocked?.status, "blocked");
  assert.equal(blocked?.attemptCount, 3);
  assert.equal(runtime.status().threadMaintenance[0]?.status, "pending");

  // Both the pending Activity and its Thread row stay durable, but their
  // blocked recorder dependency does not force the ProcessDriver into its
  // one-second busy loop.
  assert.deepEqual(await runtime.advance(), { disposition: "idle" });
  const attentionOptions = {
    initialDelayMs: 1,
    cadenceMs: 60_000,
    retryDelayMs: 30_000,
    agentWork: "allow" as const,
  };
  assert.equal((await runtime.runAttentionMaintenance({ ...attentionOptions, observedAt: now })).disposition, "waiting");
  now = new Date("2026-07-19T11:06:00.001Z");
  assert.equal((await runtime.runAttentionMaintenance({ ...attentionOptions, observedAt: now })).disposition, "completed");
  assert.equal(attentionCalls, 1);
  assert.ok(blocked);
  assert.deepEqual(runtime.requeueCognitiveOrganWork(blocked.workId), { disposition: "requeued" });
});

test("blocked Attention work reports idle instead of busy", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-blocked-attention-"));
  let now = new Date("2026-07-19T11:00:00.000Z");
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, `record-${activity.segmentId}`),
      cancel: async () => {},
    },
    attentionMaintenance: {
      maintain: async () => { throw new Error("grounding failed"); },
      cancel: async () => {},
    },
    now: () => now,
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({ source: "test", sourceId: "blocked-attention", kind: "interaction", payload: {} });
  await runtime.advance();
  await runtime.closeActivity();
  await runtime.advance();

  const options = {
    initialDelayMs: 1,
    cadenceMs: 60_000,
    retryDelayMs: 30_000,
    agentWork: "allow" as const,
  };
  // Establish the schedule before its first due instant.
  assert.equal((await runtime.runAttentionMaintenance({ ...options, observedAt: now })).disposition, "waiting");
  now = new Date("2026-07-19T11:00:00.001Z");
  assert.equal((await runtime.runAttentionMaintenance({ ...options, observedAt: now })).disposition, "failed");
  now = new Date("2026-07-19T11:01:00.001Z");
  assert.equal((await runtime.runAttentionMaintenance({ ...options, observedAt: now })).disposition, "failed");
  now = new Date("2026-07-19T11:06:00.001Z");
  assert.equal((await runtime.runAttentionMaintenance({ ...options, observedAt: now })).disposition, "failed");

  assert.deepEqual(
    await runtime.runAttentionMaintenance({ ...options, observedAt: new Date("2026-07-19T11:06:30.001Z") }),
    { disposition: "idle" },
  );
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

test("requeue refuses an active attempt, unknown ids and empty ids", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-requeue-active-"));
  let now = new Date("2026-07-19T12:00:00.000Z");
  const attentionHang = deferred<{ outcome: "no_change"; runId: string; path: string }>();
  const attentionStarted = deferred<void>();
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, "record-requeue-active"),
      cancel: async () => {},
    },
    attentionMaintenance: {
      maintain: async () => {
        attentionStarted.resolve();
        return attentionHang.promise;
      },
      cancel: async () => {},
    },
    now: () => now,
  });
  t.after(() => runtime.close());

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
    { disposition: "waiting", nextRunAt: "2026-07-19T12:00:00.001Z" },
  );

  now = new Date("2026-07-19T12:00:01.000Z");
  const attentionRun = runtime.runAttentionMaintenance({
    observedAt: now,
    initialDelayMs: 1,
    cadenceMs: 60_000,
    retryDelayMs: 30_000,
    agentWork: "allow",
  });
  await attentionStarted.promise;

  // Status exposes the discoverable local id, never a raw UUID or error text.
  const work = runtime.status().cognitiveOrganWork
    .find(entry => entry.organ === "attention-maintainer")!;
  assert.match(work.workId, /^attention-maintainer-\d+$/);
  assert.equal(work.status, "running");
  assert.equal("lastError" in work, false);
  assert.equal(work.lastFailureCategory, undefined);

  // An active attempt blocks requeue regardless of the ledger state.
  assert.throws(() => runtime.requeueCognitiveOrganWork(work.workId), /has an active attempt/);
  assert.throws(
    () => runtime.requeueCognitiveOrganWork("attention-maintainer-999999"),
    /Unknown cognitive organ work attention-maintainer-999999/,
  );
  assert.throws(() => runtime.requeueCognitiveOrganWork("  "), /requires a work id/);
  // attentionRun intentionally stays unsettled: the organ never releases.
});

test("requeue rejects retry_wait and completed work without touching the ledger", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-requeue-states-"));
  let now = new Date("2026-07-19T11:00:00.000Z");
  let attempts = 0;
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => {
        attempts += 1;
        if (attempts === 1) throw new Error("provider unavailable");
        return receiptFor(activity, `record-${attempts}`);
      },
      cancel: async () => {},
    },
    now: () => now,
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({
    source: "test",
    sourceId: "pending-recording",
    kind: "interaction",
    payload: { text: "record me" },
  });
  await runtime.advance();
  await runtime.closeActivity();
  assert.deepEqual(await runtime.advance(), { disposition: "activity_recording_failed" });

  const waiting = runtime.status().cognitiveOrganWork
    .find(entry => entry.organ === "life-recorder")!;
  assert.equal(waiting.status, "retry_wait");
  assert.equal(waiting.lastFailureCategory, "provider");
  assert.equal("lastError" in waiting, false);
  assert.throws(() => runtime.requeueCognitiveOrganWork(waiting.workId), /in state retry_wait/);

  // The rejected requeue did not touch the row: the same work still completes
  // through the normal retry path once the backoff has elapsed.
  now = new Date("2026-07-19T11:01:00.001Z");
  assert.deepEqual(await runtime.advance(), { disposition: "activity_recorded" });
  const done = runtime.status().cognitiveOrganWork
    .find(entry => entry.organ === "life-recorder")!;
  assert.equal(done.status, "completed");
  // The completed work's domain input is gone (the activity is recorded), so
  // the runtime-level eligibility check refuses it as stale; the ledger-level
  // state rejection is covered by the execution unit tests.
  assert.throws(() => runtime.requeueCognitiveOrganWork(done.workId), /no Activity awaits recording/);
});

test("intervention_required survives a restart; requeue runs the successor through the organ entry", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-requeue-restart-"));
  let now = new Date("2026-07-19T12:00:00.000Z");
  const attentionHang = deferred<{ outcome: "no_change"; runId: string; path: string }>();
  const attentionStarted = deferred<void>();
  const timerCalls: Array<{ delayMs: number; callback: () => void }> = [];
  const first = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, "record-day-one"),
      cancel: async () => {},
    },
    attentionMaintenance: {
      maintain: async () => {
        attentionStarted.resolve();
        return attentionHang.promise;
      },
      cancel: async () => {},
    },
    cognitiveOrganPolicy: { ...COGNITIVE_ORGAN_POLICY, cancelGraceMs: 50 },
    now: () => now,
  });

  await first.acceptInput({
    source: "test",
    sourceId: "day-one",
    kind: "interaction",
    payload: { text: "day one" },
  });
  await first.advance();
  await first.closeActivity();
  await first.advance();
  assert.deepEqual(
    await first.runAttentionMaintenance({
      observedAt: now,
      initialDelayMs: 1,
      cadenceMs: 60_000,
      retryDelayMs: 30_000,
      agentWork: "allow",
    }),
    { disposition: "waiting", nextRunAt: "2026-07-19T12:00:00.001Z" },
  );

  now = new Date("2026-07-19T12:00:01.000Z");
  const heldRun = first.runAttentionMaintenance({
    observedAt: now,
    initialDelayMs: 1,
    cadenceMs: 60_000,
    retryDelayMs: 30_000,
    agentWork: "allow",
  });
  await attentionStarted.promise;

  // Human preemption, not a normal execution deadline, starts the retained
  // cancellation grace. This fake organ deliberately ignores cancellation.
  await first.acceptInput({
    source: "test", sourceId: "interrupt-held-attention", kind: "interaction", payload: { text: "interrupt" },
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(
    first.status().cognitiveOrganWork.find(entry => entry.organ === "attention-maintainer")?.status,
    "intervention_required",
  );
  first.close();
  // heldRun intentionally stays unsettled: the organ never released.

  // Restart: reconcile leaves the held cycle untouched, so the operator can
  // requeue it from the new process.
  now = new Date("2026-07-19T12:05:00.000Z");
  let attentionCalls = 0;
  const recovered = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, "record-day-one"),
      cancel: async () => {},
    },
    attentionMaintenance: {
      maintain: async () => {
        attentionCalls += 1;
        return { outcome: "no_change", runId: "attention-after-requeue", path: "attention/2026-07-20.md" };
      },
      cancel: async () => {},
    },
    now: () => now,
  });
  t.after(() => recovered.close());

  const held = recovered.status().cognitiveOrganWork
    .find(entry => entry.organ === "attention-maintainer")!;
  assert.equal(held.status, "intervention_required");
  assert.equal("lastError" in held, false);
  assert.throws(() => recovered.requeueCognitiveOrganWork("attention-maintainer-999999"), /Unknown/);

  assert.deepEqual(recovered.requeueCognitiveOrganWork(held.workId), { disposition: "requeued" });

  // The successor is a fresh budget cycle referencing the held work by its
  // local id; the held record itself stays untouched.
  const successor = recovered.status().cognitiveOrganWork
    .find(entry => entry.organ === "attention-maintainer")!;
  assert.notEqual(successor.workId, held.workId);
  assert.equal(successor.status, "running");
  assert.equal(successor.attemptCount, 1);
  assert.equal(successor.requeuedFrom, held.workId);
  // Transcript and result references are omitted until completion.
  assert.equal("transcriptRef" in successor, false);
  assert.equal("resultRef" in successor, false);

  // The preempting human Input is durable across restart and keeps the organ
  // scheduler human-first until its Activity has been closed.
  await recovered.advance();
  await recovered.closeActivity();
  await recovered.advance();

  // The organ entry claims the successor through the normal path and runs its
  // first attempt; domain preconditions were checked before the claim.
  assert.deepEqual(
    await recovered.runAttentionMaintenance({
      observedAt: now,
      initialDelayMs: 1,
      cadenceMs: 60_000,
      retryDelayMs: 30_000,
      agentWork: "allow",
    }),
    {
      disposition: "completed",
      result: { outcome: "no_change", runId: "attention-after-requeue", path: "attention/2026-07-20.md" },
      nextRunAt: "2026-07-19T12:06:00.000Z",
    },
  );
  assert.equal(attentionCalls, 1);
  const done = recovered.status().cognitiveOrganWork
    .find(entry => entry.organ === "attention-maintainer")!;
  assert.equal(done.status, "completed");
  assert.equal(done.attemptCount, 1);
  assert.equal(done.requeuedFrom, held.workId);
  assert.equal(done.transcriptRef, "organs/attention-maintainer/attention-after-requeue.jsonl");
  assert.equal(done.resultRef, "attention/2026-07-20.md");

  // Immutable history: the held record and the successor are both preserved,
  // linked by the successor's requeued_from reference to the same domain ref.
  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const attentionWork = db.prepare(`
    SELECT id, domain_ref, status, attempt_count, requeued_from
    FROM cognitive_work WHERE organ = 'attention-maintainer'
    ORDER BY created_at, rowid
  `).all() as Array<Record<string, unknown>>;
  db.close();
  assert.equal(attentionWork.length, 2);
  assert.equal(attentionWork[0]!.status, "intervention_required");
  assert.equal(attentionWork[0]!.requeued_from, null);
  assert.equal(attentionWork[1]!.status, "completed");
  assert.equal(attentionWork[1]!.requeued_from, attentionWork[0]!.id);
  assert.equal(attentionWork[1]!.domain_ref, attentionWork[0]!.domain_ref);
});

test("requeue refuses attention work whose window moved on; a successor whose domain advanced is not claimed", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-requeue-window-"));
  let now = new Date("2026-07-19T12:00:00.000Z");
  const attentionHang = deferred<{ outcome: "no_change"; runId: string; path: string }>();
  const attentionStarted = deferred<void>();
  const timerCalls: Array<{ delayMs: number; callback: () => void }> = [];
  const first = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, "record-day-one"),
      cancel: async () => {},
    },
    attentionMaintenance: {
      maintain: async () => {
        attentionStarted.resolve();
        return attentionHang.promise;
      },
      cancel: async () => {},
    },
    cognitiveOrganPolicy: { ...COGNITIVE_ORGAN_POLICY, cancelGraceMs: 50 },
    now: () => now,
  });

  // One recorded Activity; the attention window is 1 and its run hangs.
  await first.acceptInput({
    source: "test",
    sourceId: "day-one",
    kind: "interaction",
    payload: { text: "day one" },
  });
  await first.advance();
  await first.closeActivity();
  await first.advance();
  assert.deepEqual(
    await first.runAttentionMaintenance({
      observedAt: now,
      initialDelayMs: 1,
      cadenceMs: 60_000,
      retryDelayMs: 30_000,
      agentWork: "allow",
    }),
    { disposition: "waiting", nextRunAt: "2026-07-19T12:00:00.001Z" },
  );
  now = new Date("2026-07-19T12:00:01.000Z");
  const heldRun = first.runAttentionMaintenance({
    observedAt: now,
    initialDelayMs: 1,
    cadenceMs: 60_000,
    retryDelayMs: 30_000,
    agentWork: "allow",
  });
  await attentionStarted.promise;
  await first.acceptInput({
    source: "test", sourceId: "interrupt-held-attention-window", kind: "interaction", payload: { text: "interrupt" },
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(
    first.status().cognitiveOrganWork.find(entry => entry.organ === "attention-maintainer")?.status,
    "intervention_required",
  );
  first.close();
  // heldRun intentionally stays unsettled: the organ never released.

  // The domain moves on while the held work awaits recovery: the schedule
  // window advances past the held window.
  let db = new DatabaseSync(path.join(root, "runtime.db"));
  db.prepare(`UPDATE attention_maintenance SET window_end_sequence = 2 WHERE singleton = 1`).run();
  db.close();

  let attentionCalls = 0;
  const recovered = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, "record-day-one"),
      cancel: async () => {},
    },
    attentionMaintenance: {
      maintain: async () => {
        attentionCalls += 1;
        return { outcome: "no_change", runId: "attention-after-requeue", path: "attention/2026-07-20.md" };
      },
      cancel: async () => {},
    },
    now: () => now,
  });
  t.after(() => recovered.close());

  const held = recovered.status().cognitiveOrganWork
    .find(entry => entry.organ === "attention-maintainer")!;
  assert.equal(held.status, "intervention_required");

  // Requeue refuses a moved-on window: a successor for it could never run,
  // and no work is created.
  assert.throws(
    () => recovered.requeueCognitiveOrganWork(held.workId),
    /superseded by a newer attention window/,
  );
  assert.equal(
    recovered.status().cognitiveOrganWork.find(entry => entry.organ === "attention-maintainer")?.workId,
    held.workId,
  );

  // Requeue while the window still matches: the successor is created, then
  // the domain advances again before the entry point runs.
  db = new DatabaseSync(path.join(root, "runtime.db"));
  db.prepare(`UPDATE attention_maintenance SET window_end_sequence = 1 WHERE singleton = 1`).run();
  db.close();
  assert.deepEqual(recovered.requeueCognitiveOrganWork(held.workId), { disposition: "requeued" });
  const successor = recovered.status().cognitiveOrganWork
    .find(entry => entry.organ === "attention-maintainer")!;
  assert.equal(successor.status, "running");
  assert.equal(successor.requeuedFrom, held.workId);

  db = new DatabaseSync(path.join(root, "runtime.db"));
  db.prepare(`UPDATE attention_maintenance SET window_end_sequence = 2 WHERE singleton = 1`).run();
  db.close();
  assert.deepEqual(
    await recovered.runAttentionMaintenance({
      observedAt: now,
      initialDelayMs: 1,
      cadenceMs: 60_000,
      retryDelayMs: 30_000,
      agentWork: "allow",
    }),
    { disposition: "busy" },
  );
  // The successor is never executed against the moved-on window; it stays
  // running and untouched.
  assert.equal(attentionCalls, 0);
  const untouched = recovered.status().cognitiveOrganWork
    .find(entry => entry.organ === "attention-maintainer")!;
  assert.equal(untouched.workId, successor.workId);
  assert.equal(untouched.status, "running");
  assert.equal(untouched.attemptCount, 1);
});

test("requeue refuses stale Life Recorder, Reflection and Thread work whose domain moved on", async t => {
  // Life Recorder: the FIFO recording queue is empty because the held
  // activity was recorded elsewhere.
  {
    const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-requeue-stale-life-"));
    let now = new Date("2026-07-19T12:00:00.000Z");
    const recordHang = deferred<Awaited<ReturnType<NonNullable<ActivityRecorder["record"]>>>>();
    const recordStarted = deferred<void>();
    const timerCalls: Array<{ delayMs: number; callback: () => void }> = [];
    const first = openRuntime({
      root,
      timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
      execution: completingExecution,
      activityLifecycle: activityLifecycle(),
      activityRecorder: {
        record: async () => {
          recordStarted.resolve();
          return recordHang.promise;
        },
        cancel: async () => {},
      },
      cognitiveOrganPolicy: { ...COGNITIVE_ORGAN_POLICY, cancelGraceMs: 50 },
      now: () => now,
    });
    await first.acceptInput({
      source: "test",
      sourceId: "day-one",
      kind: "interaction",
      payload: { text: "day one" },
    });
    await first.advance();
    await first.closeActivity();
    const recordingRun = first.advance();
    await recordStarted.promise;
    await first.acceptInput({
      source: "test", sourceId: "interrupt-held-recording", kind: "interaction", payload: { text: "interrupt" },
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(
      first.status().cognitiveOrganWork.find(entry => entry.organ === "life-recorder")?.status,
      "intervention_required",
    );
    first.close();
    // recordingRun intentionally stays unsettled: the recorder never released.

    // The activity is recorded elsewhere while held: no input awaits the
    // organ, so a successor could never run.
    let db = new DatabaseSync(path.join(root, "runtime.db"));
    db.prepare(`UPDATE activities SET status = 'recorded' WHERE status <> 'recorded'`).run();
    db.close();
    const recovered = openRuntime({
      root,
      timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
      execution: completingExecution,
      activityLifecycle: activityLifecycle(),
      activityRecorder: {
        record: async activity => receiptFor(activity, "record-day-one"),
        cancel: async () => {},
      },
      now: () => now,
    });
    t.after(() => recovered.close());
    const held = recovered.status().cognitiveOrganWork
      .find(entry => entry.organ === "life-recorder")!;
    assert.equal(held.status, "intervention_required");
    assert.throws(
      () => recovered.requeueCognitiveOrganWork(held.workId),
      /no Activity awaits recording/,
    );
  }

  // Memory Reflector: the schedule's next day moved past the held day.
  {
    const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-requeue-stale-reflection-"));
    let now = new Date("2026-07-19T12:00:00.000Z");
    const reflectHang = deferred<{ outcome: "no_change"; runId: string; changedMaterials: string[] }>();
    const reflectStarted = deferred<void>();
    const timerCalls: Array<{ delayMs: number; callback: () => void }> = [];
    const first = openRuntime({
      root,
      timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
      execution: completingExecution,
      activityLifecycle: activityLifecycle(),
      activityRecorder: {
        record: async activity => receiptFor(activity, "record-day-one"),
        cancel: async () => {},
      },
      memoryReflection: {
        reflect: async () => {
          reflectStarted.resolve();
          return reflectHang.promise;
        },
        cancel: async () => {},
      },
      cognitiveOrganPolicy: { ...COGNITIVE_ORGAN_POLICY, cancelGraceMs: 50 },
      now: () => now,
    });
    await first.acceptInput({
      source: "test",
      sourceId: "day-one",
      kind: "interaction",
      payload: { text: "day one" },
    });
    await first.advance();
    await first.closeActivity();
    await first.advance();
    assert.deepEqual(
      await first.runMemoryReflection({
        observedAt: now,
        delayMs: 0,
        retryDelayMs: 30_000,
        agentWork: "allow",
      }),
      { disposition: "waiting", nextRunAt: "2026-07-20T03:00:00.000Z" },
    );
    now = new Date("2026-07-20T04:00:01.000Z");
    const heldRun = first.runMemoryReflection({
      observedAt: now,
      delayMs: 0,
      retryDelayMs: 30_000,
      agentWork: "allow",
    });
    await reflectStarted.promise;
    await first.acceptInput({
      source: "test", sourceId: "interrupt-held-reflection", kind: "interaction", payload: { text: "interrupt" },
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(
      first.status().cognitiveOrganWork.find(entry => entry.organ === "memory-reflector")?.status,
      "intervention_required",
    );
    first.close();
    // heldRun intentionally stays unsettled: the reflector never released.

    // The schedule moved on to a newer day while held.
    let db = new DatabaseSync(path.join(root, "runtime.db"));
    db.prepare(`UPDATE memory_reflection SET next_day = '2026-07-21' WHERE singleton = 1`).run();
    db.close();
    const recovered = openRuntime({
      root,
      timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
      execution: completingExecution,
      activityLifecycle: activityLifecycle(),
      activityRecorder: {
        record: async activity => receiptFor(activity, "record-day-one"),
        cancel: async () => {},
      },
      memoryReflection: {
        reflect: async () => ({ outcome: "no_change", runId: "reflection", changedMaterials: [] }),
        cancel: async () => {},
      },
      now: () => now,
    });
    t.after(() => recovered.close());
    const held = recovered.status().cognitiveOrganWork
      .find(entry => entry.organ === "memory-reflector")!;
    assert.equal(held.status, "intervention_required");
    assert.throws(
      () => recovered.requeueCognitiveOrganWork(held.workId),
      /superseded by a newer reflection day/,
    );
  }

  // Thread Maintainer: the activity's maintenance row completed elsewhere.
  {
    const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-requeue-stale-thread-"));
    let now = new Date("2026-07-19T12:00:00.000Z");
    const threadHang = deferred<{ outcome: "no_change"; runId: string; changedPaths: string[] }>();
    const threadStarted = deferred<void>();
    const timerCalls: Array<{ delayMs: number; callback: () => void }> = [];
    const first = openRuntime({
      root,
      timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
      execution: completingExecution,
      activityLifecycle: activityLifecycle(),
      activityRecorder: {
        record: async activity => receiptFor(activity, "record-day-one"),
        cancel: async () => {},
      },
      threadMaintenance: {
        observationsFor: () => [
          { turnId: "turn-1", threadPath: "threads/t.md", relation: "changed", paths: ["threads/t.md"] },
        ],
        maintain: async () => {
          threadStarted.resolve();
          return threadHang.promise;
        },
        cancel: async () => {},
      },
      cognitiveOrganPolicy: { ...COGNITIVE_ORGAN_POLICY, cancelGraceMs: 50 },
      now: () => now,
    });
    await first.acceptInput({
      source: "test",
      sourceId: "day-one",
      kind: "interaction",
      payload: { text: "day one" },
    });
    await first.advance();
    await first.closeActivity();
    await first.advance();
    const threadRun = first.advance();
    await threadStarted.promise;
    await first.acceptInput({
      source: "test", sourceId: "interrupt-held-thread", kind: "interaction", payload: { text: "interrupt" },
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(
      first.status().cognitiveOrganWork.find(entry => entry.organ === "thread-maintainer")?.status,
      "intervention_required",
    );
    first.close();
    // threadRun intentionally stays unsettled: the maintainer never released.

    // The maintenance row completed elsewhere while held.
    let db = new DatabaseSync(path.join(root, "runtime.db"));
    db.prepare(`UPDATE thread_maintenance SET status = 'completed' WHERE status <> 'completed'`).run();
    db.close();
    const recovered = openRuntime({
      root,
      timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
      execution: completingExecution,
      activityLifecycle: activityLifecycle(),
      activityRecorder: {
        record: async activity => receiptFor(activity, "record-day-one"),
        cancel: async () => {},
      },
      threadMaintenance: {
        observationsFor: () => [
          { turnId: "turn-1", threadPath: "threads/t.md", relation: "changed", paths: ["threads/t.md"] },
        ],
        maintain: async () => ({ outcome: "no_change", runId: "thread", changedPaths: [] }),
        cancel: async () => {},
      },
      now: () => now,
    });
    t.after(() => recovered.close());
    const held = recovered.status().cognitiveOrganWork
      .find(entry => entry.organ === "thread-maintainer")!;
    assert.equal(held.status, "intervention_required");
    assert.throws(
      () => recovered.requeueCognitiveOrganWork(held.workId),
      /thread maintenance is already completed/,
    );
  }
});

test("emits agent.run.started/finished for a Cognitive Organ run", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-organ-run-events-"));
  let now = new Date("2026-07-19T11:00:00.000Z");
  const events: OperationalEvent[] = [];
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, `record-${activity.segmentId}`),
      cancel: async () => {},
    },
    attentionMaintenance: {
      maintain: async () => ({ outcome: "no_change", runId: "attention-1", path: "notes/attention.md" }),
      cancel: async () => {},
    },
    observe: event => events.push(event),
    now: () => now,
  });
  t.after(() => runtime.close());

  // Establish one recorded activity so the attention schedule becomes due.
  await runtime.acceptInput({
    source: "test",
    sourceId: "organ-day",
    kind: "interaction",
    payload: { text: "day one" },
  });
  await runtime.advance();
  await runtime.closeActivity();
  await runtime.advance();
  await runtime.runAttentionMaintenance({
    observedAt: now,
    initialDelayMs: 1,
    cadenceMs: 60_000,
    retryDelayMs: 30_000,
    agentWork: "allow",
  });

  now = new Date("2026-07-19T11:00:00.001Z");
  const result = await runtime.runAttentionMaintenance({
    observedAt: now,
    initialDelayMs: 1,
    cadenceMs: 60_000,
    retryDelayMs: 30_000,
    agentWork: "allow",
  });
  assert.equal(result.disposition, "completed");

  const started = events.filter(event =>
    event.event === "agent.run.started" && event.agentName === "attention-maintainer");
  const finished = events.filter((event): event is Extract<OperationalEvent, { event: "agent.run.finished" }> =>
    event.event === "agent.run.finished" && event.agentName === "attention-maintainer");
  assert.equal(started.length, 1);
  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.result, "succeeded");
  assert.ok(started[0] && finished[0]);
  const startedAt = events.indexOf(started[0]);
  const finishedAt = events.indexOf(finished[0]);
  assert.ok(startedAt !== -1 && finishedAt !== -1 && startedAt < finishedAt);
});

test("records the stable turn_limit category when an organ exhausts its Pi turns", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-organ-turn-limit-"));
  let now = new Date("2026-07-19T11:00:00.000Z");
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, `record-${activity.segmentId}`),
      cancel: async () => {},
    },
    attentionMaintenance: {
      maintain: async () => { throw new PiCognitiveOrganTurnLimitError(); },
      cancel: async () => {},
    },
    now: () => now,
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({ source: "test", sourceId: "turn-limit", kind: "interaction", payload: {} });
  await runtime.advance();
  await runtime.closeActivity();
  await runtime.advance();
  await runtime.runAttentionMaintenance({
    observedAt: now,
    initialDelayMs: 1,
    cadenceMs: 60_000,
    retryDelayMs: 30_000,
    agentWork: "allow",
  });
  now = new Date(now.getTime() + 1);
  assert.equal((await runtime.runAttentionMaintenance({
    observedAt: now,
    initialDelayMs: 1,
    cadenceMs: 60_000,
    retryDelayMs: 30_000,
    agentWork: "allow",
  })).disposition, "failed");

  const latest = runtime.operationalStatus().agents.find(agent => agent.name === "attention-maintainer")?.latest;
  assert.equal(latest?.failureCategory, "turn_limit");
  assert.equal(runtime.status().cognitiveOrganWork.find(work => work.organ === "attention-maintainer")?.lastFailureCategory, "turn_limit");
});

function threadObservation(activity: FrozenActivity) {
  return [{
    turnId: activity.turns[0]!.turnId,
    threadPath: "threads/t.md",
    relation: "changed" as const,
    paths: ["threads/t.md"],
  }];
}

async function seedTwoPendingThreads(
  runtime: ReturnType<typeof openRuntime>,
  advanceNow: (ms: number) => void,
): Promise<[string, string]> {
  await runtime.acceptInput({ source: "test", sourceId: "first", kind: "interaction", payload: { text: "one" } });
  await runtime.advance(); // turn 1
  await runtime.closeActivity();
  await runtime.advance(); // recording 1
  advanceNow(1_000);
  await runtime.acceptInput({ source: "test", sourceId: "second", kind: "interaction", payload: { text: "two" } });
  await runtime.advance(); // turn 2 (thread 1 still pending)
  await runtime.closeActivity();
  await runtime.advance(); // recording 2
  const rows = runtime.status().threadMaintenance;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.status), ["pending", "pending"]);
  return [rows[0]!.activityId, rows[1]!.activityId];
}

test("thread maintenance runs the FIFO head first and leaves the later row pending", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-organ-thread-fifo-"));
  let now = new Date("2026-07-19T11:00:00.000Z");
  const maintainLog: string[] = [];
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, "record"),
      cancel: async () => {},
    },
    threadMaintenance: {
      observationsFor: activity => threadObservation(activity),
      maintain: async ({ activity }) => {
        maintainLog.push(activity.segmentId);
        return { outcome: "no_change", runId: `run-${maintainLog.length}`, changedPaths: [] };
      },
      cancel: async () => {},
    },
    now: () => now,
  });
  t.after(() => runtime.close());

  const [head, tail] = await seedTwoPendingThreads(runtime, ms => { now = new Date(now.getTime() + ms); });

  assert.equal((await runtime.advance()).disposition, "thread_maintenance_completed");
  assert.deepEqual(maintainLog, [head]);
  const rows = runtime.status().threadMaintenance;
  assert.equal(rows.find(row => row.activityId === head)?.status, "completed");
  assert.equal(rows.find(row => row.activityId === tail)?.status, "pending");

  assert.equal((await runtime.advance()).disposition, "thread_maintenance_completed");
  assert.deepEqual(maintainLog, [head, tail]);
});

test("a retrying head defers the later thread row and retries the same head on its own work", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-organ-thread-retry-head-"));
  let now = new Date("2026-07-19T11:00:00.000Z");
  const maintainLog: string[] = [];
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, "record"),
      cancel: async () => {},
    },
    threadMaintenance: {
      observationsFor: activity => threadObservation(activity),
      maintain: async ({ activity }) => {
        maintainLog.push(activity.segmentId);
        if (maintainLog.length === 1) throw new Error("provider unavailable");
        return { outcome: "no_change", runId: `run-${maintainLog.length}`, changedPaths: [] };
      },
      cancel: async () => {},
    },
    now: () => now,
  });
  t.after(() => runtime.close());

  const [head, tail] = await seedTwoPendingThreads(runtime, ms => { now = new Date(now.getTime() + ms); });

  const failed = await runtime.advance();
  assert.equal(failed.disposition, "thread_maintenance_failed");
  assert.deepEqual(maintainLog, [head]);
  const work = runtime.status().cognitiveOrganWork.find(entry => entry.organ === "thread-maintainer")!;
  assert.equal(work.status, "retry_wait");
  assert.equal(work.attemptCount, 1);
  assert.equal(work.domainRef, `activity:${head}`);

  // While the head backs off, the later row must not overtake it.
  assert.equal((await runtime.advance()).disposition, "waiting");
  assert.deepEqual(maintainLog, [head]);
  assert.equal(runtime.status().threadMaintenance.find(row => row.activityId === tail)?.status, "pending");

  // Once the backoff elapses the same head retries on the same work.
  now = new Date(Date.parse(work.nextAttemptAt!) + 1);
  assert.equal((await runtime.advance()).disposition, "thread_maintenance_completed");
  assert.deepEqual(maintainLog, [head, head]);
  assert.equal(runtime.status().cognitiveOrganWork.find(entry => entry.organ === "thread-maintainer")?.attemptCount, 2);

  assert.equal((await runtime.advance()).disposition, "thread_maintenance_completed");
  assert.deepEqual(maintainLog, [head, head, tail]);
});

test("a blocked head keeps the later row pending until requeue restores the head", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-organ-thread-blocked-head-"));
  let now = new Date("2026-07-19T11:00:00.000Z");
  const maintainLog: string[] = [];
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, "record"),
      cancel: async () => {},
    },
    threadMaintenance: {
      observationsFor: activity => threadObservation(activity),
      maintain: async ({ activity }) => {
        maintainLog.push(activity.segmentId);
        if (maintainLog.length < 4) throw new Error("workspace not writable");
        return { outcome: "no_change", runId: `run-${maintainLog.length}`, changedPaths: [] };
      },
      cancel: async () => {},
    },
    now: () => now,
  });
  t.after(() => runtime.close());

  const [head, tail] = await seedTwoPendingThreads(runtime, ms => { now = new Date(now.getTime() + ms); });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await runtime.advance()).disposition, "thread_maintenance_failed");
    const work = runtime.status().cognitiveOrganWork.find(entry => entry.organ === "thread-maintainer")!;
    if (attempt < 2) {
      assert.equal(work.status, "retry_wait");
      now = new Date(Date.parse(work.nextAttemptAt!) + 1);
    }
  }
  assert.equal(runtime.status().cognitiveOrganWork.find(entry => entry.organ === "thread-maintainer")?.status, "blocked");
  assert.deepEqual(maintainLog, [head, head, head]);
  assert.equal(runtime.status().threadMaintenance.find(row => row.activityId === tail)?.status, "pending");

  // A blocked head is not runnable: the scheduler reports idle and the later
  // row must not be claimed instead.
  assert.deepEqual(await runtime.advance(), { disposition: "idle" });
  assert.deepEqual(maintainLog, [head, head, head]);
  assert.equal(runtime.status().threadMaintenance.find(row => row.activityId === tail)?.status, "pending");

  const blockedWork = runtime.status().cognitiveOrganWork.find(entry => entry.organ === "thread-maintainer")!;
  assert.deepEqual(runtime.requeueCognitiveOrganWork(blockedWork.workId), { disposition: "requeued" });
  assert.equal((await runtime.advance()).disposition, "thread_maintenance_completed");
  assert.deepEqual(maintainLog, [head, head, head, head]);
  assert.equal(runtime.status().threadMaintenance.find(row => row.activityId === head)?.status, "completed");

  assert.equal((await runtime.advance()).disposition, "thread_maintenance_completed");
  assert.deepEqual(maintainLog, [head, head, head, head, tail]);
});

test("a retrying thread head survives a restart with its budget and backoff", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-organ-thread-restart-retry-"));
  let now = new Date("2026-07-19T11:00:00.000Z");
  const maintainLog: string[] = [];
  const options = (failOnce: boolean): RuntimeOptions => ({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, "record"),
      cancel: async () => {},
    },
    threadMaintenance: {
      observationsFor: (activity: FrozenActivity) => threadObservation(activity),
      maintain: async ({ activity }: { activity: FrozenActivity }) => {
        maintainLog.push(activity.segmentId);
        if (failOnce && maintainLog.length === 1) throw new Error("provider unavailable");
        return { outcome: "no_change", runId: `run-${maintainLog.length}`, changedPaths: [] };
      },
      cancel: async () => {},
    },
    now: () => now,
  });

  const first = openRuntime(options(true));
  await first.acceptInput({ source: "test", sourceId: "restart", kind: "interaction", payload: { text: "one" } });
  await first.advance();
  await first.closeActivity();
  await first.advance(); // recording
  assert.equal((await first.advance()).disposition, "thread_maintenance_failed");
  const before = first.status().cognitiveOrganWork.find(entry => entry.organ === "thread-maintainer")!;
  assert.equal(before.status, "retry_wait");
  assert.equal(before.attemptCount, 1);
  first.close();

  const recovered = openRuntime(options(false));
  t.after(() => recovered.close());
  const work = recovered.status().cognitiveOrganWork.find(entry => entry.organ === "thread-maintainer")!;
  assert.equal(work.status, "retry_wait");
  assert.equal(work.attemptCount, 1);
  assert.equal(work.domainRef, before.domainRef);

  // Backoff survives the restart: still waiting, no premature retry.
  assert.equal((await recovered.advance()).disposition, "waiting");
  assert.deepEqual(maintainLog, [work.domainRef.slice("activity:".length)]);

  now = new Date(Date.parse(work.nextAttemptAt!) + 1);
  assert.equal((await recovered.advance()).disposition, "thread_maintenance_completed");
  assert.equal(recovered.status().cognitiveOrganWork.find(entry => entry.organ === "thread-maintainer")?.attemptCount, 2);
});

test("a blocked thread head does not starve Reflection for the same recording day", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-organ-thread-blocked-reflection-"));
  let now = new Date("2026-07-19T11:00:00.000Z");
  const threadCalls: string[] = [];
  let reflectCalls = 0;
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, "record"),
      cancel: async () => {},
    },
    threadMaintenance: {
      observationsFor: activity => threadObservation(activity),
      maintain: async ({ activity }) => {
        threadCalls.push(activity.segmentId);
        throw new Error("workspace not writable");
      },
      cancel: async () => {},
    },
    memoryReflection: {
      reflect: async () => {
        reflectCalls += 1;
        return { outcome: "no_change", runId: "reflection-after-blocked-thread", changedMaterials: [] };
      },
      cancel: async () => {},
    },
    now: () => now,
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({ source: "test", sourceId: "blocked-thread-day", kind: "interaction", payload: { text: "one" } });
  await runtime.advance(); // turn
  await runtime.closeActivity();
  await runtime.advance(); // recording

  // Establish the Reflection schedule for the recording day before it is due.
  assert.equal((await runtime.runMemoryReflection({
    observedAt: now,
    delayMs: 0,
    retryDelayMs: 30_000,
    agentWork: "allow",
  })).disposition, "waiting");

  // Thread exhausts its attempts into blocked.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await runtime.advance()).disposition, "thread_maintenance_failed");
    const work = runtime.status().cognitiveOrganWork.find(entry => entry.organ === "thread-maintainer")!;
    if (attempt < 2) now = new Date(Date.parse(work.nextAttemptAt!) + 1);
  }
  assert.equal(
    runtime.status().cognitiveOrganWork.find(entry => entry.organ === "thread-maintainer")?.status,
    "blocked",
  );

  // The same recording day's Reflection must not be starved by the blocked
  // Thread lane: it runs and completes while the thread row stays pending.
  now = new Date("2026-07-20T04:00:01.000Z");
  const reflection = await runtime.runMemoryReflection({
    observedAt: now,
    delayMs: 0,
    retryDelayMs: 30_000,
    agentWork: "allow",
  });
  assert.equal(reflection.disposition, "completed");
  assert.equal(reflection.reflectionDay, "2026-07-19");
  assert.equal(reflectCalls, 1);
  assert.equal(runtime.status().threadMaintenance[0]?.status, "pending");
  assert.equal(runtime.status().cognitiveOrganWork.find(entry => entry.organ === "thread-maintainer")?.status, "blocked");
});

test("a requeued thread head gates Reflection until the successor completes", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-organ-thread-requeue-reflection-"));
  let now = new Date("2026-07-19T11:00:00.000Z");
  const threadCalls: string[] = [];
  let reflectCalls = 0;
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, "record"),
      cancel: async () => {},
    },
    threadMaintenance: {
      observationsFor: activity => threadObservation(activity),
      maintain: async ({ activity }) => {
        threadCalls.push(activity.segmentId);
        if (threadCalls.length < 4) throw new Error("workspace not writable");
        return { outcome: "no_change", runId: `run-${threadCalls.length}`, changedPaths: [] };
      },
      cancel: async () => {},
    },
    memoryReflection: {
      reflect: async () => {
        reflectCalls += 1;
        return { outcome: "no_change", runId: "reflection-after-requeue", changedMaterials: [] };
      },
      cancel: async () => {},
    },
    now: () => now,
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({ source: "test", sourceId: "requeued-thread-day", kind: "interaction", payload: { text: "one" } });
  await runtime.advance(); // turn
  await runtime.closeActivity();
  await runtime.advance(); // recording

  // Establish the Reflection schedule for the recording day before it is due.
  assert.equal((await runtime.runMemoryReflection({
    observedAt: now,
    delayMs: 0,
    retryDelayMs: 30_000,
    agentWork: "allow",
  })).disposition, "waiting");

  // Thread exhausts its attempts into blocked.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await runtime.advance()).disposition, "thread_maintenance_failed");
    const work = runtime.status().cognitiveOrganWork.find(entry => entry.organ === "thread-maintainer")!;
    if (attempt < 2) now = new Date(Date.parse(work.nextAttemptAt!) + 1);
  }
  const blockedWork = runtime.status().cognitiveOrganWork.find(entry => entry.organ === "thread-maintainer")!;
  assert.equal(blockedWork.status, "blocked");

  // Requeue creates a running successor; the blocked history row stays.
  assert.deepEqual(runtime.requeueCognitiveOrganWork(blockedWork.workId), { disposition: "requeued" });
  const work = runtime.status().cognitiveOrganWork.find(entry => entry.organ === "thread-maintainer")!;
  assert.equal(work.status, "running");
  assert.equal(work.requeuedFrom, blockedWork.workId);

  // While the successor is runnable the same-day Reflection must stay gated:
  // running it now would race the Thread writer.
  now = new Date("2026-07-20T04:00:01.000Z");
  assert.equal((await runtime.runMemoryReflection({
    observedAt: now,
    delayMs: 0,
    retryDelayMs: 30_000,
    agentWork: "allow",
  })).disposition, "busy");
  assert.equal(reflectCalls, 0);

  // The successor completes the Thread work, then Reflection is released.
  assert.equal((await runtime.advance()).disposition, "thread_maintenance_completed");
  assert.equal(runtime.status().threadMaintenance[0]?.status, "completed");
  const released = await runtime.runMemoryReflection({
    observedAt: now,
    delayMs: 0,
    retryDelayMs: 30_000,
    agentWork: "allow",
  });
  assert.equal(released.disposition, "completed");
  assert.equal(released.reflectionDay, "2026-07-19");
  assert.equal(reflectCalls, 1);
});

test("a foreground Input submitted immediately after an organ starts is cancelled (no claim→run scheduling gap)", async t => {
  // Regression: the shared #driveCognitiveOrgan driver must set the active
  // organ in the same synchronous tick as the ledger/domain claim, so a human
  // Input arriving in the next microtask still cancels it.
  const root = await mkdtemp(path.join(tmpdir(), "loom-organ-cancel-same-tick-"));
  let now = new Date("2026-07-19T12:00:00.000Z");
  const attended = deferred<{ outcome: "no_change"; runId: string; path: string }>();
  let cancelCalls = 0;
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, "record"),
      cancel: async () => {},
    },
    attentionMaintenance: {
      maintain: async () => attended.promise,
      cancel: async () => {
        cancelCalls += 1;
      },
    },
    memoryReflection: {
      reflect: async () => ({ outcome: "no_change", runId: "reflection", changedMaterials: [] }),
      cancel: async () => {},
    },
    cognitiveOrganPolicy: { ...COGNITIVE_ORGAN_POLICY, cancelGraceMs: 10_000 },
    now: () => now,
  });
  t.after(() => runtime.close());

  // Establish one recorded Activity and both maintenance schedules, mirroring
  // the held-organ cancel test above, so that at due time attention is the only
  // organ that can claim (life-recorder and thread are settled) and no active
  // organ is left lingering.
  await runtime.acceptInput({ source: "test", sourceId: "day-one", kind: "interaction", payload: { text: "day one" } });
  await runtime.advance();
  await runtime.closeActivity();
  await runtime.advance();
  assert.equal(
    (await runtime.runMemoryReflection({
      observedAt: now,
      delayMs: 0,
      retryDelayMs: 30_000,
      agentWork: "allow",
    })).disposition,
    "waiting",
  );
  assert.equal(
    (await runtime.runAttentionMaintenance({
      observedAt: now,
      initialDelayMs: 1,
      cadenceMs: 60_000,
      retryDelayMs: 30_000,
      agentWork: "allow",
    })).disposition,
    "waiting",
  );

  // Due time: start attention and, WITHOUT awaiting the run, submit a
  // foreground human Input in the same synchronous tick. The Input must find
  // the active organ and trigger its cancel; otherwise a gap between the
  // ledger/domain claim and the active-organ assignment swallows the cancel.
  now = new Date("2026-07-20T04:00:01.000Z");
  const attentionRun = runtime.runAttentionMaintenance({
    observedAt: now,
    initialDelayMs: 1,
    cadenceMs: 60_000,
    retryDelayMs: 30_000,
    agentWork: "allow",
  });
  const human = await runtime.acceptInput({
    source: "test",
    sourceId: "human-same-tick",
    kind: "interaction",
    payload: { text: "please stop" },
  });
  assert.equal(human.disposition, "accepted");
  // The active organ must have been visible to #cancelActiveCognitiveOrgan.
  assert.equal(cancelCalls, 1, "the foreground Input must cancel the just-started organ");

  // Release the organ run; the canceled attempt settles to a busy lane.
  attended.resolve({ outcome: "no_change", runId: "run-1", path: "daily/2026-07-19.md" });
  assert.equal((await attentionRun).disposition, "busy");
  assert.equal(
    runtime.status().inputs.find(input => input.id === human.inputId)?.status,
    "pending",
  );
});
