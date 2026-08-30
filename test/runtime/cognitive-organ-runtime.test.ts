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

function threadRow(db: DatabaseSync, activityId: string): Record<string, unknown> {
  return db.prepare(
    "SELECT status, attempt_count, needs_human, next_eligible_at, last_error FROM thread_maintenance WHERE activity_id = ?",
  ).get(activityId) as Record<string, unknown>;
}

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

test("a foreground input aborts the running attention organ; the turn waits for release", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-foreground-abort-"));
  let now = new Date("2026-07-19T12:00:00.000Z");
  let releaseOrgan: (() => void) | undefined;
  const attentionStarted = deferred<void>();
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, `record-${activity.segmentId}`),
      cancel: async () => {},
    },
    attentionMaintenance: {
      maintain: async () => {
        attentionStarted.resolve();
        return new Promise(resolve => {
          releaseOrgan = () =>
            resolve({ outcome: "no_change", runId: "attention-held", path: "notes/attention.md" });
        });
      },
      // The cancel marks the abort but the run unwinds asynchronously, as a
      // real pi session does; the release happens below.
      cancel: async () => {},
    },
    now: () => now,
  });
  t.after(() => runtime.close());

  // One recorded Activity for attention window 1; the schedule is established
  // but not yet due.
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

  // Due time: the attention organ starts and holds.
  now = new Date("2026-07-19T12:00:01.000Z");
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
  // The foreground Input stays durable while the organ unwinds.
  assert.equal(
    runtime.status().inputs.find(input => input.id === human.inputId)?.status,
    "pending",
  );

  // Single-writer gate: the Turn waits until the organ run has released
  // (a short bounded deadline, since the abort unwinds promptly).
  assert.equal((await runtime.advance()).disposition, "waiting");
  assert.equal(
    runtime.status().inputs.find(input => input.id === human.inputId)?.status,
    "pending",
  );

  // The organ releases on the abort; nothing is charged for the interrupt:
  // the budget fields are untouched and the reserved window stays for retry.
  releaseOrgan!();
  assert.equal((await attentionRun).disposition, "busy");
  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const row = db.prepare(`
    SELECT attempt_count, needs_human, window_end_sequence, last_error
    FROM attention_maintenance WHERE singleton = 1
  `).get() as Record<string, unknown>;
  db.close();
  assert.equal(row.attempt_count, 0);
  assert.equal(row.needs_human, 0);
  assert.equal(row.last_error, null);
  assert.equal(row.window_end_sequence, 1);

  // Reopening: the foreground proceeds and consumes the human Input.
  const resumed = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, `record-${activity.segmentId}`),
      cancel: async () => {},
    },
    attentionMaintenance: {
      maintain: async () => ({ outcome: "no_change", runId: "attention-retry", path: "notes/attention.md" }),
      cancel: async () => {},
    },
    now: () => now,
  });
  t.after(() => resumed.close());
  assert.deepEqual(await resumed.advance(), { disposition: "turn_completed" });
  assert.equal(
    resumed.status().inputs.find(input => input.id === human.inputId)?.status,
    "consumed",
  );
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
  // Simulates a restart while the recording run is in flight. Nothing was
  // persisted about the run: the row is simply still due.
  first.close();

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

  // Crash recovery needs no reconciliation of execution claims: the row kept
  // its budget, and the lost run shows only as an interrupted agent run.
  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const row = db.prepare(
    "SELECT status, attempt_count, needs_human, next_eligible_at, last_error FROM activities LIMIT 1",
  ).get() as Record<string, unknown>;
  db.close();
  assert.equal(row.status, "pending");
  assert.equal(row.attempt_count, 0);
  assert.equal(row.needs_human, 0);
  assert.equal(row.next_eligible_at, null);
  assert.equal(row.last_error, null);

  // The same frozen evidence is retried from the immutable input, not
  // continued from the lost run.
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
  assert.equal((await runtime.advance()).disposition, "activity_recording_failed");

  // The revision is fixed when the second attempt starts; later changes do not
  // rewrite the first attempt's record.
  revision = "rev-2";
  now = new Date("2026-07-19T11:01:00.001Z");
  assert.deepEqual(await runtime.advance(), { disposition: "activity_recorded" });

  const history = runtime.operationalStatus({ since: "2026-07-19T00:00:00.000Z" })
    .agents.find(agent => agent.name === "life-recorder")?.history?.map(run => run.result);
  assert.deepEqual(history, ["failed", "succeeded"]);
  runtime.close();
  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const row = db.prepare(
    "SELECT status, attempt_count, needs_human, last_error FROM activities LIMIT 1",
  ).get() as Record<string, unknown>;
  db.close();
  assert.equal(row.status, "recorded");
  assert.equal(row.attempt_count, 0);
  assert.equal(row.needs_human, 0);
  assert.equal(row.last_error, null);
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
  assert.equal(runtime.status().activities[0]?.status, "recorded");
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

  // Nothing is charged for the interrupt: the row keeps its budget fields.
  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const row = db.prepare(
    "SELECT attempt_count, needs_human, next_eligible_at, last_error FROM activities LIMIT 1",
  ).get() as Record<string, unknown>;
  db.close();
  assert.equal(row.attempt_count, 0);
  assert.equal(row.needs_human, 0);
  assert.equal(row.next_eligible_at, null);
  assert.equal(row.last_error, null);
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
  assert.equal((await runtime.advance()).disposition, "activity_recording_failed");
  assert.equal(runtime.status().activities[0]?.status, "pending");
  assert.match(runtime.status().activities[0]?.lastError ?? "", /belongs to wrong-segment/);
  assert.equal(runtime.status().activities[0]?.attempts, 1);

  // The real failure backs off on the row without needing a human yet.
  runtime.close();
  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const row = db.prepare(
    "SELECT attempt_count, needs_human, next_eligible_at FROM activities LIMIT 1",
  ).get() as Record<string, unknown>;
  db.close();
  assert.equal(row.attempt_count, 1);
  assert.equal(row.needs_human, 0);
  assert.notEqual(row.next_eligible_at, null);
});

test("classifies an incomplete model stream as a provider failure", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-stream-failure-"));
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async () => { throw new Error("Stream ended without finish_reason"); },
    },
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({ source: "test", sourceId: "stream-failure", kind: "interaction", payload: {} });
  await runtime.advance();
  await runtime.closeActivity();
  assert.equal((await runtime.advance()).disposition, "activity_recording_failed");
  const latest = runtime.operationalStatus().agents.find(agent => agent.name === "life-recorder")?.latest;
  assert.equal(latest?.failureCategory, "provider");
});

test("a quota-parked recorder yields the scheduler and never burns attempt budget", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-parked-recorder-"));
  let now = new Date("2026-07-19T11:00:00.000Z");
  let recordCalls = 0;
  let attentionCalls = 0;
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async () => {
        recordCalls += 1;
        throw new Error(
          "429 GoUsageLimitError: usage limit reached for https://opencode.ai/workspace/example/go",
        );
      },
      cancel: async () => {},
    },
    threadMaintenance: {
      observationsFor: activity => [{
        turnId: activity.turns[0]!.turnId,
        threadPath: "thread.md",
        relation: "changed",
        paths: ["thread.md"],
      }],
      maintain: async () => ({ outcome: "no_change", runId: "thread-during-park", changedPaths: [] }),
      cancel: async () => {},
    },
    attentionMaintenance: {
      maintain: async () => {
        attentionCalls += 1;
        return { outcome: "no_change", runId: "attention-during-park", path: "attention.md" };
      },
      cancel: async () => {},
    },
    now: () => now,
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({
    source: "test",
    sourceId: "parked-recorder",
    kind: "interaction",
    payload: { text: "record me" },
  });
  await runtime.advance();
  await runtime.closeActivity();
  assert.equal((await runtime.advance()).disposition, "activity_recording_failed");

  // Quota exhaustion is an environment fact: the recorder parks until the
  // default park elapses without consuming any attempt budget.
  const parked = runtime.status().activities[0];
  assert.equal(parked?.attempts, 0);
  const db0 = new DatabaseSync(path.join(root, "runtime.db"));
  const row0 = db0.prepare(
    "SELECT needs_human, next_eligible_at FROM activities LIMIT 1",
  ).get() as Record<string, unknown>;
  db0.close();
  assert.equal(row0.needs_human, 0);
  assert.equal(row0.next_eligible_at, "2026-07-19T17:00:00.000Z");

  // Inside the park the whole lane waits on the row's deadline; no further
  // recorder call happens and no busy loop is implied.
  now = new Date("2026-07-19T11:06:30.000Z");
  await runtime.advance();
  assert.equal(recordCalls, 1);

  // The parked recorder does not starve the other organs; the Thread row
  // waits on its own real dependency (the Activity being recorded), not on
  // the recorder's failure.
  assert.equal(runtime.status().threadMaintenance[0]?.status, "pending");
  const attentionOptions = {
    initialDelayMs: 1,
    cadenceMs: 60_000,
    retryDelayMs: 30_000,
    agentWork: "allow" as const,
  };
  now = new Date("2026-07-19T11:07:00.000Z");
  assert.equal(
    (await runtime.runAttentionMaintenance({ ...attentionOptions, observedAt: now })).disposition,
    "waiting",
  );
  now = new Date("2026-07-19T11:07:00.001Z");
  assert.equal(
    (await runtime.runAttentionMaintenance({ ...attentionOptions, observedAt: now })).disposition,
    "completed",
  );
  assert.equal(attentionCalls, 1);

  // At the park deadline the recorder retries; another quota park follows,
  // still without touching the attempt budget.
  now = new Date("2026-07-19T17:00:00.000Z");
  assert.equal((await runtime.advance()).disposition, "activity_recording_failed");
  assert.equal(recordCalls, 2);
  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const row = db.prepare(
    "SELECT status, attempt_count, needs_human, next_eligible_at FROM activities LIMIT 1",
  ).get() as Record<string, unknown>;
  const ledgerRows = db.prepare(
    "SELECT COUNT(*) AS n FROM cognitive_work WHERE organ = 'life-recorder'",
  ).get() as Record<string, number>;
  db.close();
  assert.equal(row.status, "pending");
  assert.equal(row.attempt_count, 0);
  assert.equal(row.needs_human, 0);
  assert.equal(row.next_eligible_at, "2026-07-19T23:00:00.000Z");
  assert.equal(ledgerRows.n, 0);
});
test("exhausted attention failures enter needs_human cooldown instead of busy", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-blocked-attention-"));
  let now = new Date("2026-07-19T11:00:00.000Z");
  let maintainCalls = 0;
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: {
      record: async activity => receiptFor(activity, `record-${activity.segmentId}`),
      cancel: async () => {},
    },
    attentionMaintenance: {
      maintain: async () => {
        maintainCalls += 1;
        throw new Error("grounding failed");
      },
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
  const third = await runtime.runAttentionMaintenance({ ...options, observedAt: now });
  assert.equal(third.disposition, "failed");
  assert.equal(maintainCalls, 3);
  assert.equal(third.nextRunAt, "2026-07-20T11:06:00.001Z");

  // The exhausted row is a waiting deadline (24h mechanical cooldown), not a
  // busy loop and not an idle organ.
  assert.deepEqual(
    await runtime.runAttentionMaintenance({ ...options, observedAt: new Date("2026-07-19T11:06:30.001Z") }),
    { disposition: "waiting", nextRunAt: "2026-07-20T11:06:00.001Z" },
  );
  assert.equal(maintainCalls, 3);

  // The cooldown retry runs at its deadline and stays in cooldown on failure,
  // without spending additional attempt budget.
  now = new Date("2026-07-20T11:06:00.001Z");
  const cooldownRetry = await runtime.runAttentionMaintenance({ ...options, observedAt: now });
  assert.equal(cooldownRetry.disposition, "failed");
  assert.equal(cooldownRetry.nextRunAt, "2026-07-21T11:06:00.001Z");

  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const row = db.prepare(`
    SELECT attempt_count, needs_human, last_error FROM attention_maintenance WHERE singleton = 1
  `).get() as Record<string, unknown>;
  assert.equal(row.attempt_count, 3);
  assert.equal(row.needs_human, 1);
  assert.equal(row.last_error, "grounding failed");
  // Attention no longer owns execution-ledger work.
  const ledgerRows = db.prepare(`
    SELECT COUNT(*) AS n FROM cognitive_work WHERE organ = 'attention-maintainer'
  `).get() as Record<string, number>;
  db.close();
  assert.equal(ledgerRows.n, 0);
});

test("a retried attention window picks up activities that arrived during the backoff", async t => {
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
  // backoff with the window reserved.
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

  // A second activity arrives during the backoff and the reserved window is
  // released, so the retry covers the wider window with the row's remaining
  // budget — there is no per-window work cycle to reuse or abandon.
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
  // The retry read the wider window: both activities, not only the first.
  assert.equal(recentActivityIds.length, 2);

  runtime.close();
  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const row = db.prepare(`
    SELECT attempt_count, needs_human, last_error, cursor_sequence, window_end_sequence
    FROM attention_maintenance WHERE singleton = 1
  `).get() as Record<string, unknown>;
  assert.equal(row.attempt_count, 0);
  assert.equal(row.needs_human, 0);
  assert.equal(row.last_error, null);
  assert.equal(row.cursor_sequence, 2);
  assert.equal(row.window_end_sequence, null);
  const ledgerRows = db.prepare(`
    SELECT COUNT(*) AS n FROM cognitive_work WHERE organ = 'attention-maintainer'
  `).get() as Record<string, number>;
  db.close();
  assert.equal(ledgerRows.n, 0);
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

  // The retry continued the immutable day input on the row itself: success
  // cleared the budget and scheduled the next reflection day.
  runtime.close();
  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const row = db.prepare(`
    SELECT next_day, attempt_count, needs_human, last_error, next_run_after
    FROM memory_reflection WHERE singleton = 1
  `).get() as Record<string, unknown>;
  const ledgerRows = db.prepare(
    "SELECT COUNT(*) AS n FROM cognitive_work WHERE organ = 'memory-reflector'",
  ).get() as Record<string, number>;
  db.close();
  assert.equal(row.next_day, "2026-07-20");
  assert.equal(row.attempt_count, 0);
  assert.equal(row.needs_human, 0);
  assert.equal(row.last_error, null);
  assert.equal(row.next_run_after, "2026-07-21T03:00:00.000Z");
  assert.equal(ledgerRows.n, 0);
});

test("requeue refuses unknown ids and empty ids", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-cognitive-organ-requeue-active-"));
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
  });
  t.after(() => runtime.close());

  assert.throws(
    () => runtime.requeueCognitiveOrganWork("life-recorder-999999"),
    /Unknown cognitive organ work life-recorder-999999/,
  );
  assert.throws(() => runtime.requeueCognitiveOrganWork("  "), /requires a work id/);
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
  // The domain row carries the budget consequence; the category projection on
  // status follows the domain-row rework.
  const db = new DatabaseSync(path.join(root, "runtime.db"));
  const row = db.prepare(
    "SELECT attempt_count, needs_human, last_error FROM attention_maintenance WHERE singleton = 1",
  ).get() as Record<string, unknown>;
  db.close();
  assert.equal(row.attempt_count, 1);
  assert.equal(row.needs_human, 0);
  assert.match(String(row.last_error), /turn limit|Pi/i);
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
  assert.equal(failed.nextRunAt, "2026-07-19T11:01:01.000Z");
  assert.deepEqual(maintainLog, [head]);

  // The failure lives on the head row itself.
  {
    const db = new DatabaseSync(path.join(root, "runtime.db"));
    const row = threadRow(db, head);
    db.close();
    assert.equal(row.attempt_count, 1);
    assert.equal(row.needs_human, 0);
    assert.equal(row.next_eligible_at, failed.nextRunAt);
    assert.equal(row.last_error, "provider unavailable");
  }

  // While the head backs off, the later row must not overtake it.
  assert.equal((await runtime.advance()).disposition, "waiting");
  assert.deepEqual(maintainLog, [head]);
  assert.equal(runtime.status().threadMaintenance.find(row => row.activityId === tail)?.status, "pending");

  // Once the backoff elapses the same head retries on its own row.
  now = new Date(Date.parse(failed.nextRunAt!) + 1);
  assert.equal((await runtime.advance()).disposition, "thread_maintenance_completed");
  assert.deepEqual(maintainLog, [head, head]);
  {
    const db = new DatabaseSync(path.join(root, "runtime.db"));
    const row = threadRow(db, head);
    db.close();
    assert.equal(row.status, "completed");
    assert.equal(row.attempt_count, 0);
  }

  assert.equal((await runtime.advance()).disposition, "thread_maintenance_completed");
  assert.deepEqual(maintainLog, [head, head, tail]);
});

test("a needs_human head keeps the later row pending until the cooldown retry heals it", async t => {
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

  let lastNextRunAt = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const failed = await runtime.advance();
    assert.equal(failed.disposition, "thread_maintenance_failed");
    lastNextRunAt = failed.nextRunAt!;
    if (attempt < 2) now = new Date(Date.parse(lastNextRunAt) + 1);
  }
  {
    const db = new DatabaseSync(path.join(root, "runtime.db"));
    const row = threadRow(db, head);
    db.close();
    assert.equal(row.attempt_count, 3);
    assert.equal(row.needs_human, 1);
    assert.equal(row.next_eligible_at, lastNextRunAt);
  }
  assert.deepEqual(maintainLog, [head, head, head]);
  assert.equal(runtime.status().threadMaintenance.find(row => row.activityId === tail)?.status, "pending");

  // The needs_human head is a waiting deadline, not busy work: nothing runs
  // and the later row must not be claimed instead.
  assert.equal((await runtime.advance()).disposition, "waiting");
  assert.deepEqual(maintainLog, [head, head, head]);
  assert.equal(runtime.status().threadMaintenance.find(row => row.activityId === tail)?.status, "pending");

  // The daily mechanical cooldown retry heals the head without a human.
  now = new Date(lastNextRunAt);
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
  const failed = await first.advance();
  assert.equal(failed.disposition, "thread_maintenance_failed");
  const backoffUntil = failed.nextRunAt!;
  first.close();

  const recovered = openRuntime(options(false));
  t.after(() => recovered.close());
  // The row's budget and backoff survive the restart.
  {
    const db = new DatabaseSync(path.join(root, "runtime.db"));
    const row = threadRow(db, maintainLog[0]!);
    db.close();
    assert.equal(row.attempt_count, 1);
    assert.equal(row.needs_human, 0);
    assert.equal(row.next_eligible_at, backoffUntil);
  }

  // Backoff survives the restart: still waiting, no premature retry.
  assert.equal((await recovered.advance()).disposition, "waiting");
  assert.deepEqual(maintainLog, [maintainLog[0]]);

  now = new Date(Date.parse(backoffUntil) + 1);
  assert.equal((await recovered.advance()).disposition, "thread_maintenance_completed");
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

  // Thread exhausts its attempts into needs_human cooldown.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const failed = await runtime.advance();
    assert.equal(failed.disposition, "thread_maintenance_failed");
    if (attempt < 2) now = new Date(Date.parse(failed.nextRunAt!) + 1);
  }
  {
    const db = new DatabaseSync(path.join(root, "runtime.db"));
    const row = threadRow(db, runtime.status().threadMaintenance[0]!.activityId);
    db.close();
    assert.equal(row.needs_human, 1);
  }

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
