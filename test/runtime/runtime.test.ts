import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  openRuntime,
  type ActivityFreezeRequest,
  type ActivityLifecycle,
  type ActivityRecorder,
  type AgentExecution,
  type EffectRequest,
  type JsonValue,
  type FrozenActivity,
  type OutboundDelivery,
  type RunningExecution,
  type TranscriptAnchor,
  type TurnControl,
  type TurnRequest,
} from "../../src/runtime/index.js";

interface TestExecutionState {
  generation: number;
  items: JsonValue[];
}

function readTestExecutionState(value: JsonValue | undefined): TestExecutionState | undefined {
  return value === undefined ? undefined : value as unknown as TestExecutionState;
}

function writeTestExecutionState(value: TestExecutionState): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime state");
    await delay(1);
  }
}

function executionResult(request: TurnRequest, transcriptAnchor: TranscriptAnchor) {
  const previous = readTestExecutionState(request.executionState);
  return {
    executionState: writeTestExecutionState({
      generation: (previous?.generation ?? 0) + 1,
      items: previous?.items ?? [],
    }),
    executionRecord: { kind: "test-execution", transcriptEntryId: transcriptAnchor.entryId },
  };
}

class HeldExecution implements AgentExecution {
  readonly started = deferred<TurnRequest>();
  readonly finished = deferred<Awaited<RunningExecution["result"]>>();
  readonly steered: TurnRequest["inputs"] = [];

  start(request: TurnRequest, control: TurnControl): RunningExecution {
    control.prepareExecutionState(request.executionState ?? {
      generation: 0,
      items: [],
    });
    control.includeInput(request.inputs[0]!.id);
    this.started.resolve(request);
    return {
      result: this.finished.promise,
      steer: async input => {
        this.steered.push(input);
        control.includeInput(input.id);
      },
      abort: async () => {},
    };
  }

  complete(request: TurnRequest): void {
    const inputs = [...request.inputs, ...this.steered];
    this.finished.resolve({
      outcome: "completed",
      inputAnchors: inputs.map(input => ({
        inputId: input.id,
        transcriptAnchor: { sessionId: "session-held", entryId: `input-${input.id}` },
      })),
      transcriptAnchor: { sessionId: "session-held", entryId: `entry-${request.turnId}` },
      ...executionResult(request, { sessionId: "session-held", entryId: `entry-${request.turnId}` }),
    });
  }
}

class NotStartedExecution implements AgentExecution {
  readonly started = deferred<TurnRequest>();
  readonly finished = deferred<Awaited<RunningExecution["result"]>>();

  start(request: TurnRequest): RunningExecution {
    this.started.resolve(request);
    return {
      result: this.finished.promise,
      steer: async () => {},
      abort: async () => {},
    };
  }
}

class EffectThenHoldExecution extends HeldExecution {
  constructor(readonly effect: EffectRequest) {
    super();
  }

  override start(request: TurnRequest, control: TurnControl): RunningExecution {
    const running = super.start(request, control);
    control.prepareEffect(this.effect);
    return running;
  }
}

class SlowSteeringExecution extends HeldExecution {
  readonly steeringStarted = deferred<Parameters<RunningExecution["steer"]>[0]>();
  readonly steeringFinished = deferred<Awaited<ReturnType<RunningExecution["steer"]>>>();

  override start(request: TurnRequest, control: TurnControl): RunningExecution {
    const running = super.start(request, control);
    return {
      ...running,
      steer: async input => {
        this.steered.push(input);
        this.steeringStarted.resolve(input);
        await this.steeringFinished.promise;
        control.includeInput(input.id);
      },
    };
  }
}

class SteeringEffectExecution extends HeldExecution {
  override start(request: TurnRequest, control: TurnControl): RunningExecution {
    const running = super.start(request, control);
    return {
      ...running,
      steer: async input => {
        this.steered.push(input);
        control.includeInput(input.id);
        control.prepareEffect({
          kind: "message",
          payload: { text: "reply after steering" },
          routeRef: "default",
        });
      },
    };
  }
}

class IncludedWithoutEvidenceExecution extends HeldExecution {
  override start(request: TurnRequest, control: TurnControl): RunningExecution {
    const running = super.start(request, control);
    return {
      ...running,
      steer: async input => {
        this.steered.push(input);
        control.includeInput(input.id);
      },
    };
  }

  override complete(request: TurnRequest): void {
    this.finished.resolve({
      outcome: "completed",
      inputAnchors: request.inputs.map(input => ({
        inputId: input.id,
        transcriptAnchor: { sessionId: "session-held", entryId: `input-${input.id}` },
      })),
      transcriptAnchor: { sessionId: "session-held", entryId: `entry-${request.turnId}` },
      ...executionResult(request, { sessionId: "session-held", entryId: `entry-${request.turnId}` }),
    });
  }
}

const effectThenCompleteExecution: AgentExecution = {
  start(request, control): RunningExecution {
    const running = completingExecution.start(request, control);
    control.prepareEffect({
      kind: "message",
      payload: { text: "hello from the Agent" },
      routeRef: "default",
    });
    return running;
  },
};

class HeldOutboundDelivery implements OutboundDelivery {
  readonly started = deferred<string>();
  readonly finished = deferred<{ status: "delivered"; remoteId: string }>();

  async deliver(attempt: Parameters<OutboundDelivery["deliver"]>[0]): Promise<{ status: "delivered"; remoteId: string }> {
    this.started.resolve(attempt.attemptId);
    return this.finished.promise;
  }
}

const completingExecution: AgentExecution = {
  start(request: TurnRequest, control: TurnControl): RunningExecution {
    control.prepareExecutionState(request.executionState ?? {
      generation: 0,
      items: [],
    });
    control.includeInput(request.inputs[0]!.id);
    return {
      result: Promise.resolve({
        outcome: "completed",
        inputAnchors: request.inputs.map(input => ({
          inputId: input.id,
          transcriptAnchor: { sessionId: "session-1", entryId: `input-${input.id}` },
        })),
        transcriptAnchor: { sessionId: "session-1", entryId: `entry-${request.turnId}` },
        ...executionResult(request, { sessionId: "session-1", entryId: `entry-${request.turnId}` }),
      }),
      steer: async input => control.includeInput(input.id),
      abort: async () => {},
    };
  },
};

class ObservedCompletingExecution implements AgentExecution {
  readonly requests: TurnRequest[] = [];

  start(request: TurnRequest, control: TurnControl): RunningExecution {
    this.requests.push(structuredClone(request));
    return completingExecution.start(request, control);
  }
}

function activityLifecycle(observed: Parameters<ActivityLifecycle["freeze"]>[0][] = []): ActivityLifecycle {
  return {
    freeze: async request => {
      observed.push(structuredClone(request));
      return {
        activity: {
          version: 1,
          segmentId: request.segment.id,
          recordingDay: request.segment.recordingDay,
          openedAt: request.segment.openedAt,
          closedAt: request.segment.closedAt,
          events: request.inputs.map(input => ({
            eventId: `input:${input.id}`,
            at: input.occurredAt,
            actorRef: input.kind === "interaction" ? "human" : "system",
            kind: "input",
            content: input.payload,
          })),
          transcriptAnchors: request.turns.flatMap(turn => turn.transcriptAnchor ? [turn.transcriptAnchor] : []),
        },
        successorExecutionState: {
          version: 1,
          successorOf: request.segment.id,
        },
      };
    },
  };
}

function recorder(recorded: string[], failFirst = false): ActivityRecorder {
  let attempts = 0;
  return {
    record: async (activity: FrozenActivity) => {
      attempts += 1;
      recorded.push(activity.segmentId);
      if (failFirst && attempts === 1) throw new Error("recorder unavailable");
      return {
        version: 1,
        segmentId: activity.segmentId,
        runId: `run-${attempts}`,
        recordedAt: "2026-07-19T12:00:00.000Z",
        daily: { status: "no_change", path: `daily/${activity.recordingDay}.md` },
        episodes: [],
      };
    },
  };
}

test("continues interaction from the successor state while recording is pending", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-activity-"));
  const execution = new ObservedCompletingExecution();
  const recorded: string[] = [];
  const runtime = openRuntime({
    root,
    execution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: recorder(recorded),
    now: () => new Date("2026-07-19T11:00:00.000Z"),
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "first",
    kind: "interaction",
    payload: { text: "first activity" },
    occurredAt: "2026-07-19T10:59:00.000Z",
  });
  assert.deepEqual(await runtime.advance(), { disposition: "turn_completed" });

  const closed = await runtime.closeActivity();
  assert.equal(closed.disposition, "activity_frozen");
  assert.equal(runtime.status().activities[0]?.status, "pending");

  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "second",
    kind: "interaction",
    payload: { text: "successor activity" },
    occurredAt: "2026-07-19T11:01:00.000Z",
  });
  assert.deepEqual(await runtime.advance(), { disposition: "turn_completed" });
  assert.deepEqual(execution.requests[1]?.executionState, {
    version: 1,
    successorOf: closed.activityId,
  });
  assert.deepEqual(recorded, []);

  assert.deepEqual(await runtime.advance(), { disposition: "activity_recorded" });
  assert.deepEqual(recorded, [closed.activityId]);
  assert.equal(runtime.status().activities[0]?.status, "recorded");
});

test("supplies recently recorded Activities to the next lifecycle close", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-recent-activity-"));
  const observed: Parameters<ActivityLifecycle["freeze"]>[0][] = [];
  const runtime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(observed),
    activityRecorder: recorder([]),
    now: () => new Date("2026-07-19T12:00:00.000Z"),
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "first-recent",
    kind: "interaction",
    payload: { text: "first recent activity" },
    occurredAt: "2026-07-19T11:58:00.000Z",
  });
  await runtime.advance();
  const first = await runtime.closeActivity();
  assert.equal(first.disposition, "activity_frozen");
  assert.deepEqual(await runtime.advance(), { disposition: "activity_recorded" });

  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "second-recent",
    kind: "interaction",
    payload: { text: "second recent activity" },
    occurredAt: "2026-07-19T12:01:00.000Z",
  });
  await runtime.advance();
  assert.equal((await runtime.closeActivity()).disposition, "activity_frozen");

  const secondRequest = observed[1] as ActivityFreezeRequest;
  assert.deepEqual(
    secondRequest.recentActivities.map(activity => activity.segmentId),
    [first.activityId],
  );
});

test("retries failed frozen activities in FIFO order after restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-activity-retry-"));
  const failedOrder: string[] = [];
  const firstRuntime = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: recorder(failedOrder, true),
    now: () => new Date("2026-07-19T12:00:00.000Z"),
  });

  const frozenIds: string[] = [];
  for (const sourceId of ["first", "second"]) {
    await firstRuntime.acceptInput({
      source: "test-channel",
      sourceId,
      kind: "interaction",
      payload: { text: sourceId },
    });
    assert.deepEqual(await firstRuntime.advance(), { disposition: "turn_completed" });
    const closed = await firstRuntime.closeActivity();
    assert.equal(closed.disposition, "activity_frozen");
    frozenIds.push(closed.activityId);
  }

  assert.deepEqual(await firstRuntime.advance(), { disposition: "activity_recording_failed" });
  assert.equal(firstRuntime.status().activities[0]?.attempts, 1);
  assert.match(firstRuntime.status().activities[0]?.lastError ?? "", /recorder unavailable/);
  firstRuntime.close();

  const recoveredOrder: string[] = [];
  const recovered = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: recorder(recoveredOrder),
    now: () => new Date("2026-07-19T12:05:00.000Z"),
  });
  try {
    assert.deepEqual(await recovered.advance(), { disposition: "activity_recorded" });
    assert.deepEqual(await recovered.advance(), { disposition: "activity_recorded" });
    assert.deepEqual(recoveredOrder, frozenIds);
    assert.deepEqual(recovered.status().activities.map(activity => activity.status), ["recorded", "recorded"]);
  } finally {
    recovered.close();
  }
});

test("preserves stopped Turn facts without treating an uncommitted transcript branch as evidence", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-stopped-turn-activity-"));
  const observed: Parameters<ActivityLifecycle["freeze"]>[0][] = [];
  const runtime = openRuntime({
    root,
    execution: {
      start(request, control) {
        control.prepareExecutionState(request.executionState ?? { version: 1, prepared: true });
        control.includeInput(request.inputs[0]!.id);
        control.prepareEffect({ kind: "workspace_change", payload: { path: "notes/plan.md" } });
        return {
          result: Promise.reject(new Error("provider stopped after workspace effect")),
          steer: async () => {},
          abort: async () => {},
        };
      },
    },
    activityLifecycle: activityLifecycle(observed),
    now: () => new Date("2026-07-19T12:30:00.000Z"),
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "failed-turn",
    kind: "interaction",
    payload: { text: "change the plan" },
  });
  await assert.rejects(runtime.advance(), /provider stopped after workspace effect/);
  assert.equal(runtime.status().inputs[0]?.status, "consumed");
  assert.equal((await runtime.closeActivity()).disposition, "activity_frozen");

  assert.equal(observed[0]?.turns.length, 1);
  assert.deepEqual(observed[0]?.turns[0], {
    id: runtime.status().turns[0]!.id,
    inputIds: [runtime.status().inputs[0]!.id],
    status: "failed",
    startedAt: "2026-07-19T12:30:00.000Z",
    endedAt: "2026-07-19T12:30:00.000Z",
    error: "provider stopped after workspace effect",
  });
});

test("preserves an interrupted Turn with a durable Effect when closing after restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-interrupted-turn-activity-"));
  let now = Date.parse("2026-07-19T12:40:00.000Z");
  const execution = new EffectThenHoldExecution({
    kind: "workspace_change",
    payload: { path: "notes/recovered.md" },
  });
  const interrupted = openRuntime({
    root,
    execution,
    ownerId: "interrupted-runtime",
    leaseDurationMs: 1_000,
    now: () => new Date(now),
  });
  await interrupted.acceptInput({
    source: "test-channel",
    sourceId: "interrupted-turn",
    kind: "opportunity",
    payload: { reason: "continue private work" },
  });
  void interrupted.advance();
  await execution.started.promise;
  interrupted.close();

  now += 2_000;
  const observed: Parameters<ActivityLifecycle["freeze"]>[0][] = [];
  const recovered = openRuntime({
    root,
    ownerId: "recovered-runtime",
    activityLifecycle: activityLifecycle(observed),
    leaseDurationMs: 1_000,
    now: () => new Date(now),
  });
  try {
    assert.equal(recovered.status().inputs[0]?.status, "consumed");
    assert.equal((await recovered.closeActivity()).disposition, "activity_frozen");
    assert.equal(observed[0]?.turns[0]?.status, "interrupted");
    assert.equal(observed[0]?.turns[0]?.error, "runtime lease expired");
    assert.equal(observed[0]?.effects[0]?.kind, "workspace_change");
  } finally {
    recovered.close();
  }
});

test("recovers an interrupted Activity close without losing the active segment", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-activity-close-recovery-"));
  let now = new Date("2026-07-19T13:00:00.000Z");
  const closeStarted = deferred<Parameters<ActivityLifecycle["freeze"]>[0]>();
  const interruptedLifecycle: ActivityLifecycle = {
    freeze: request => {
      closeStarted.resolve(request);
      return new Promise(() => {});
    },
  };
  const interrupted = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: interruptedLifecycle,
    activityRecorder: recorder([]),
    leaseDurationMs: 50,
    now: () => now,
  });
  await interrupted.acceptInput({
    source: "test-channel",
    sourceId: "before-crash",
    kind: "interaction",
    payload: { text: "preserve this activity" },
  });
  assert.deepEqual(await interrupted.advance(), { disposition: "turn_completed" });
  void interrupted.closeActivity();
  const closing = await closeStarted.promise;
  interrupted.close();

  now = new Date("2026-07-19T13:01:00.000Z");
  const recovered = openRuntime({
    root,
    execution: completingExecution,
    activityLifecycle: activityLifecycle(),
    activityRecorder: recorder([]),
    leaseDurationMs: 50,
    now: () => now,
  });
  try {
    assert.equal(recovered.status().activeSegment?.id, closing.segment.id);
    const result = await recovered.closeActivity();
    assert.deepEqual(result, { disposition: "activity_frozen", activityId: closing.segment.id });
  } finally {
    recovered.close();
  }
});

test("accepts a source input exactly once", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-"));
  const runtime = openRuntime({ root });
  t.after(() => runtime.close());

  const first = await runtime.acceptInput({
    source: "test-channel",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "hello" },
  });
  const duplicate = await runtime.acceptInput({
    source: "test-channel",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "changed duplicate" },
  });

  assert.equal(first.disposition, "accepted");
  assert.deepEqual(duplicate, { disposition: "duplicate", inputId: first.inputId });
  assert.deepEqual(runtime.status().inputs, [
    {
      id: first.inputId,
      source: "test-channel",
      sourceId: "message-1",
      kind: "interaction",
      payload: { text: "hello" },
      status: "pending",
    },
  ]);
});

test("completes one pending input through a main Agent Turn", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-"));
  const runtime = openRuntime({ root, execution: completingExecution });
  t.after(() => runtime.close());

  const accepted = await runtime.acceptInput({
    source: "test-channel",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "hello" },
  });

  assert.deepEqual(await runtime.advance(), { disposition: "turn_completed" });

  const status = runtime.status();
  assert.equal(status.inputs[0]?.status, "consumed");
  assert.equal(status.turns.length, 1);
  assert.equal(status.turns[0]?.status, "completed");
  assert.equal(status.turns[0]?.inputIds[0], accepted.inputId);
  assert.deepEqual(status.turns[0]?.transcriptAnchor, {
    sessionId: "session-1",
    entryId: `entry-${status.turns[0]?.id}`,
  });
});

test("restores opaque execution state for the next Turn after restart", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-execution-state-"));
  const observed: TurnRequest[] = [];
  const statefulExecution: AgentExecution = {
    start(request, control) {
      observed.push(request);
      control.prepareExecutionState(request.executionState ?? {
        generation: 0,
        items: [],
      });
      control.includeInput(request.inputs[0]!.id);
      const transcriptAnchor = {
        sessionId: "session-agent",
        entryId: `entry-${request.turnId}`,
      };
      const previous = readTestExecutionState(request.executionState);
      return {
        result: Promise.resolve({
          outcome: "completed",
          inputAnchors: request.inputs.map(input => ({
            inputId: input.id,
            transcriptAnchor: {
              sessionId: "session-agent",
              entryId: `input-${input.id}`,
            },
          })),
          transcriptAnchor,
          executionState: writeTestExecutionState({
            generation: (previous?.generation ?? 0) + 1,
            items: [...(previous?.items ?? []), request.inputs[0]!.payload],
          }),
          executionRecord: { kind: "test-execution", inputCount: request.inputs.length },
        }),
        steer: async input => control.includeInput(input.id),
        abort: async () => {},
      };
    },
  };

  const first = openRuntime({ root, execution: statefulExecution });
  await first.acceptInput({
    source: "test-channel",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "first" },
  });
  assert.deepEqual(await first.advance(), { disposition: "turn_completed" });
  assert.deepEqual(first.status().turns[0]?.executionRecord, {
    kind: "test-execution",
    inputCount: 1,
  });
  first.close();

  const second = openRuntime({ root, execution: statefulExecution });
  t.after(() => second.close());
  await second.acceptInput({
    source: "test-channel",
    sourceId: "message-2",
    kind: "interaction",
    payload: { text: "second" },
  });
  assert.deepEqual(await second.advance(), { disposition: "turn_completed" });

  assert.deepEqual(readTestExecutionState(observed[1]?.executionState), {
    generation: 1,
    items: [{ text: "first" }],
  });
});

test("keeps an atomic execution state replacement when the following execution fails", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-state-replacement-"));
  let run = 0;
  const execution: AgentExecution = {
    start(request, control) {
      run += 1;
      if (run === 1) {
        const prepared = {
          generation: 0,
          items: [] as JsonValue[],
        };
        control.prepareExecutionState(prepared);
        control.includeInput(request.inputs[0]!.id);
        const transcriptAnchor = { sessionId: "session-agent", entryId: "entry-first" };
        return {
          result: Promise.resolve({
            outcome: "completed" as const,
            inputAnchors: [{
              inputId: request.inputs[0]!.id,
              transcriptAnchor: { sessionId: "session-agent", entryId: "input-first" },
            }],
            transcriptAnchor,
            executionState: {
              generation: 1,
              items: ["raw state"],
            },
            executionRecord: { kind: "test-execution" },
          }),
          steer: async () => {},
          abort: async () => {},
        };
      }

      const expected = readTestExecutionState(request.executionState)!;
      control.prepareExecutionState(request.executionState!);
      control.replaceExecutionState(request.executionState!, writeTestExecutionState({
        ...expected,
        items: ["replaced state"],
      }));
      return {
        result: Promise.reject(new Error("execution failed after replacement")),
        steer: async () => {},
        abort: async () => {},
      };
    },
  };
  const runtime = openRuntime({ root, execution });
  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "first" },
  });
  assert.deepEqual(await runtime.advance(), { disposition: "turn_completed" });
  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "message-2",
    kind: "interaction",
    payload: { text: "second" },
  });
  await assert.rejects(runtime.advance(), /execution failed after replacement/);
  runtime.close();

  const started = deferred<TurnRequest>();
  const observer = openRuntime({
    root,
    execution: {
      start(request) {
        started.resolve(request);
        return { result: new Promise(() => {}), steer: async () => {}, abort: async () => {} };
      },
    },
  });
  t.after(() => observer.close());
  const advance = observer.advance();

  assert.deepEqual(readTestExecutionState((await started.promise).executionState)?.items, ["replaced state"]);
  void advance;
});

test("rejects a stale execution state replacement without changing current state", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-state-stale-"));
  let run = 0;
  const runtime = openRuntime({
    root,
    execution: {
      start(request, control) {
        run += 1;
        if (run === 1) {
          const prepared = {
            generation: 0,
            items: [] as JsonValue[],
          };
          control.prepareExecutionState(prepared);
          control.includeInput(request.inputs[0]!.id);
          const transcriptAnchor = { sessionId: "session-agent", entryId: "entry-first" };
          return {
            result: Promise.resolve({
              outcome: "completed" as const,
              inputAnchors: [{
                inputId: request.inputs[0]!.id,
                transcriptAnchor: { sessionId: "session-agent", entryId: "input-first" },
              }],
              transcriptAnchor,
              executionState: {
                generation: 1,
                items: ["current state"],
              },
              executionRecord: { kind: "test-execution" },
            }),
            steer: async () => {},
            abort: async () => {},
          };
        }

        const expected = readTestExecutionState(request.executionState)!;
        control.prepareExecutionState(request.executionState!);
        control.replaceExecutionState(request.executionState!, writeTestExecutionState({
          ...expected,
          items: ["current replacement"],
        }));
        control.replaceExecutionState(request.executionState!, writeTestExecutionState({
          ...expected,
          items: ["stale replacement"],
        }));
        throw new Error("stale replacement should have failed");
      },
    },
  });
  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "first" },
  });
  assert.deepEqual(await runtime.advance(), { disposition: "turn_completed" });
  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "message-2",
    kind: "interaction",
    payload: { text: "second" },
  });
  await assert.rejects(runtime.advance(), /execution state replacement.*stale/i);
  runtime.close();

  const started = deferred<TurnRequest>();
  const observer = openRuntime({
    root,
    execution: {
      start(request) {
        started.resolve(request);
        return { result: new Promise(() => {}), steer: async () => {}, abort: async () => {} };
      },
    },
  });
  t.after(() => observer.close());
  const advance = observer.advance();

  assert.deepEqual(readTestExecutionState((await started.promise).executionState)?.items, ["current replacement"]);
  void advance;
});

test("keeps prepared execution state when its first Turn fails", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-state-prepared-"));
  const failingExecution: AgentExecution = {
    start(request, control) {
      control.prepareExecutionState({
        owner: "main-agent",
        phase: "prepared",
        privateData: ["original"],
      });
      control.includeInput(request.inputs[0]!.id);
      return {
        result: Promise.reject(new Error("provider failed")),
        steer: async () => {},
        abort: async () => {},
      };
    },
  };
  const failed = openRuntime({ root, execution: failingExecution });
  await failed.acceptInput({
    source: "test-channel",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "first" },
  });
  await assert.rejects(failed.advance(), /provider failed/);
  failed.close();

  const started = deferred<TurnRequest>();
  const recoveringExecution: AgentExecution = {
    start(request) {
      started.resolve(request);
      return {
        result: new Promise(() => {}),
        steer: async () => {},
        abort: async () => {},
      };
    },
  };
  const recovered = openRuntime({ root, execution: recoveringExecution });
  t.after(() => recovered.close());
  const advance = recovered.advance();
  const request = await started.promise;

  assert.deepEqual(request.executionState, {
    owner: "main-agent",
    phase: "prepared",
    privateData: ["original"],
  });

  void advance;
});

test("persists completed execution state without interpreting its schema", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-execution-state-"));
  const execution: AgentExecution = {
    start(request, control) {
      control.prepareExecutionState({
        owner: "main-agent",
        schema: "private-before-provider",
      });
      control.includeInput(request.inputs[0]!.id);
      const transcriptAnchor = { sessionId: "session-agent", entryId: "entry-complete" };
      return {
        result: Promise.resolve({
          outcome: "completed",
          inputAnchors: [{
            inputId: request.inputs[0]!.id,
            transcriptAnchor: { sessionId: "session-agent", entryId: "entry-input" },
          }],
          transcriptAnchor,
          executionState: {
            owner: "main-agent",
            schema: "private-after-provider",
            nested: { arbitrary: [true, 42, "kept"] },
          },
          executionRecord: { kind: "main-agent-plan", selected: 3 },
        }),
        steer: async () => {},
        abort: async () => {},
      };
    },
  };
  const runtime = openRuntime({ root, execution });
  t.after(() => runtime.close());
  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "hello" },
  });

  assert.deepEqual(await runtime.advance(), { disposition: "turn_completed" });
  assert.equal(runtime.status().turns[0]?.status, "completed");
  assert.equal(runtime.status().inputs[0]?.status, "consumed");
  assert.deepEqual(runtime.status().turns[0]?.executionRecord, {
    kind: "main-agent-plan",
    selected: 3,
  });
});

test("keeps an initial Input pending until Agent Execution starts its user message", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-"));
  const execution = new NotStartedExecution();
  const runtime = openRuntime({ root, execution });
  t.after(() => runtime.close());

  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "hello" },
  });
  const advance = runtime.advance();
  await execution.started.promise;

  assert.equal(runtime.status().inputs[0]?.status, "pending");
  assert.deepEqual(runtime.status().turns[0]?.inputIds, []);

  execution.finished.reject(new Error("test stop"));
  await assert.rejects(advance, /test stop/);
});

test("retries inputs from an expired Turn and rejects its late completion", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-"));
  let now = Date.parse("2026-07-18T12:00:00.000Z");
  const oldExecution = new HeldExecution();
  const oldRuntime = openRuntime({
    root,
    execution: oldExecution,
    ownerId: "old-runtime",
    leaseDurationMs: 1_000,
    now: () => new Date(now),
  });
  t.after(() => oldRuntime.close());

  await oldRuntime.acceptInput({
    source: "test-channel",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "hello" },
  });
  const lateAdvance = oldRuntime.advance();
  const oldTurn = await oldExecution.started.promise;

  now += 2_000;
  const replacement = openRuntime({
    root,
    execution: completingExecution,
    ownerId: "replacement-runtime",
    leaseDurationMs: 1_000,
    now: () => new Date(now),
  });
  t.after(() => replacement.close());

  assert.equal(replacement.status().turns[0]?.status, "interrupted");
  assert.equal(replacement.status().inputs[0]?.status, "pending");
  assert.deepEqual(await replacement.advance(), { disposition: "turn_completed" });

  oldExecution.complete(oldTurn);
  await assert.rejects(lateAdvance, /no longer accepts writes/);
  assert.deepEqual(replacement.status().turns.map(turn => turn.status), ["interrupted", "completed"]);
  assert.equal(replacement.status().inputs[0]?.status, "consumed");
});

test("reconciles a Turn that expires after the replacement Runtime starts", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-"));
  let now = Date.parse("2026-07-19T12:00:00.000Z");
  const execution = new HeldExecution();
  const oldRuntime = openRuntime({
    root,
    execution,
    ownerId: "old-runtime",
    leaseDurationMs: 1_000,
    now: () => new Date(now),
  });

  await oldRuntime.acceptInput({
    source: "test-channel",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "hello" },
  });
  void oldRuntime.advance();
  await execution.started.promise;
  oldRuntime.close();

  const replacement = openRuntime({
    root,
    ownerId: "replacement-runtime",
    leaseDurationMs: 1_000,
    now: () => new Date(now),
  });
  t.after(() => replacement.close());

  assert.deepEqual(await replacement.advance(), { disposition: "busy" });
  now += 2_000;
  assert.deepEqual(await replacement.advance(), { disposition: "idle" });
  assert.equal(replacement.status().turns[0]?.status, "interrupted");
  assert.equal(replacement.status().inputs[0]?.status, "pending");
});

test("renews the lease while a main Agent Turn is still running", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-"));
  const execution = new HeldExecution();
  const runtime = openRuntime({
    root,
    execution,
    ownerId: "active-runtime",
    leaseDurationMs: 150,
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "hello" },
  });
  const advance = runtime.advance();
  const turn = await execution.started.promise;
  await delay(400);

  const observer = openRuntime({ root, ownerId: "observer" });
  t.after(() => observer.close());
  assert.equal(observer.status().turns[0]?.status, "running");
  assert.equal(observer.status().inputs[0]?.status, "active");

  execution.complete(turn);
  assert.deepEqual(await advance, { disposition: "turn_completed" });
});

test("accepts a live Input without waiting for Agent Execution to include it", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-"));
  const execution = new SlowSteeringExecution();
  const runtime = openRuntime({ root, execution });
  t.after(() => runtime.close());

  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "first" },
  });
  const advance = runtime.advance();
  const turn = await execution.started.promise;

  const acceptance = runtime.acceptInput({
    source: "test-channel",
    sourceId: "message-2",
    kind: "interaction",
    payload: { text: "second" },
  });
  await execution.steeringStarted.promise;
  const observed = await Promise.race([
    acceptance.then(result => result.disposition),
    delay(50).then(() => "blocked" as const),
  ]);

  execution.steeringFinished.resolve(undefined);
  await acceptance;
  execution.complete(turn);
  await advance;

  assert.equal(observed, "accepted");
});

test("does not replay an input after its Turn created an Effect", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-"));
  let now = Date.parse("2026-07-18T12:00:00.000Z");
  const oldExecution = new EffectThenHoldExecution({
    kind: "message",
    payload: { text: "hello from the Agent" },
    routeRef: "default",
  });
  const oldRuntime = openRuntime({
    root,
    execution: oldExecution,
    ownerId: "old-runtime",
    leaseDurationMs: 1_000,
    now: () => new Date(now),
  });
  t.after(() => oldRuntime.close());

  await oldRuntime.acceptInput({
    source: "test-channel",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "hello" },
  });
  const lateAdvance = oldRuntime.advance();
  const oldTurn = await oldExecution.started.promise;

  now += 2_000;
  const replacement = openRuntime({ root, now: () => new Date(now), ownerId: "replacement-runtime" });
  t.after(() => replacement.close());

  const recovered = replacement.status();
  assert.equal(recovered.turns[0]?.status, "interrupted");
  assert.equal(recovered.inputs[0]?.status, "consumed");
  assert.equal(recovered.effects[0]?.status, "pending");
  assert.equal(recovered.effects[0]?.coveredInputPosition, 1);

  oldExecution.complete(oldTurn);
  await assert.rejects(lateAdvance, /no longer accepts writes/);
});

test("retries a late steering Input not covered by an earlier Effect", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-"));
  let now = Date.parse("2026-07-18T12:00:00.000Z");
  const oldExecution = new EffectThenHoldExecution({
    kind: "message",
    payload: { text: "first reply" },
    routeRef: "default",
  });
  const oldRuntime = openRuntime({
    root,
    execution: oldExecution,
    ownerId: "old-runtime",
    leaseDurationMs: 1_000,
    now: () => new Date(now),
  });
  t.after(() => oldRuntime.close());

  const first = await oldRuntime.acceptInput({
    source: "test-channel",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "first" },
  });
  const lateAdvance = oldRuntime.advance();
  const oldTurn = await oldExecution.started.promise;
  const late = await oldRuntime.acceptInput({
    source: "test-channel",
    sourceId: "message-2",
    kind: "interaction",
    payload: { text: "second" },
  });
  await waitUntil(() => oldRuntime.status().turns[0]?.inputIds.includes(late.inputId) === true);

  now += 2_000;
  const replacement = openRuntime({ root, now: () => new Date(now), ownerId: "replacement-runtime" });
  t.after(() => replacement.close());

  const recovered = replacement.status();
  assert.equal(recovered.inputs.find(input => input.id === first.inputId)?.status, "consumed");
  assert.equal(recovered.inputs.find(input => input.id === late.inputId)?.status, "pending");
  assert.deepEqual(recovered.turns[0]?.inputIds, [first.inputId, late.inputId]);

  oldExecution.complete(oldTurn);
  await assert.rejects(lateAdvance, /no longer accepts writes/);
});

test("does not replay a steering Input covered by an Effect after actual inclusion", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-"));
  let now = Date.parse("2026-07-18T12:00:00.000Z");
  const oldExecution = new SteeringEffectExecution();
  const oldRuntime = openRuntime({
    root,
    execution: oldExecution,
    ownerId: "old-runtime",
    leaseDurationMs: 1_000,
    now: () => new Date(now),
  });
  t.after(() => oldRuntime.close());

  await oldRuntime.acceptInput({
    source: "test-channel",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "first" },
  });
  const lateAdvance = oldRuntime.advance();
  const oldTurn = await oldExecution.started.promise;
  const late = await oldRuntime.acceptInput({
    source: "test-channel",
    sourceId: "message-2",
    kind: "interaction",
    payload: { text: "second" },
  });
  await waitUntil(() => oldRuntime.status().effects[0]?.coveredInputPosition === 2);

  now += 2_000;
  const replacement = openRuntime({ root, now: () => new Date(now), ownerId: "replacement-runtime" });
  t.after(() => replacement.close());

  const recovered = replacement.status();
  assert.equal(recovered.inputs.find(input => input.id === late.inputId)?.status, "consumed");
  assert.equal(recovered.effects[0]?.coveredInputPosition, 2);

  oldExecution.complete(oldTurn);
  await assert.rejects(lateAdvance, /no longer accepts writes/);
});

test("does not complete a Turn without evidence for every included Input", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-"));
  const execution = new IncludedWithoutEvidenceExecution();
  const runtime = openRuntime({ root, execution });
  t.after(() => runtime.close());

  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "first" },
  });
  const advance = runtime.advance();
  const turn = await execution.started.promise;
  const late = await runtime.acceptInput({
    source: "test-channel",
    sourceId: "message-2",
    kind: "interaction",
    payload: { text: "second" },
  });
  await waitUntil(() => runtime.status().turns[0]?.inputIds.includes(late.inputId) === true);

  execution.complete(turn);

  await assert.rejects(advance, /verified Transcript Anchor for Input/);
});

test("marks an expired dispatch as unknown and rejects its late result", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-"));
  let now = Date.parse("2026-07-18T12:00:00.000Z");
  const outboundDelivery = new HeldOutboundDelivery();
  const oldRuntime = openRuntime({
    root,
    execution: effectThenCompleteExecution,
    outboundDelivery,
    ownerId: "old-runtime",
    leaseDurationMs: 1_000,
    now: () => new Date(now),
  });
  t.after(() => oldRuntime.close());

  await oldRuntime.acceptInput({
    source: "test-channel",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "hello" },
  });
  assert.deepEqual(await oldRuntime.advance(), { disposition: "turn_completed" });

  const lateDelivery = oldRuntime.advance();
  const attemptId = await outboundDelivery.started.promise;
  now += 2_000;

  const replacement = openRuntime({ root, now: () => new Date(now), ownerId: "replacement-runtime" });
  t.after(() => replacement.close());
  const recovered = replacement.status();
  assert.equal(recovered.deliveries.find(delivery => delivery.id === attemptId)?.status, "unknown");
  assert.equal(recovered.effects[0]?.status, "reconciliation_required");

  outboundDelivery.finished.resolve({ status: "delivered", remoteId: "remote-1" });
  await assert.rejects(lateDelivery, /no longer accepts writes/);
  assert.equal(replacement.status().deliveries[0]?.status, "unknown");
});
