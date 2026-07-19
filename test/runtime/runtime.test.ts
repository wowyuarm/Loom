import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  openRuntime,
  type AgentExecution,
  type EffectRequest,
  type Integration,
  type RunningExecution,
  type TranscriptAnchor,
  type TurnControl,
  type TurnRequest,
} from "../../src/runtime/index.js";

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

function contextResult(request: TurnRequest, transcriptAnchor: TranscriptAnchor) {
  return {
    contextWindow: {
      version: 1 as const,
      id: request.contextWindow?.id ?? "window-test",
      frozenSeed: request.contextWindow?.frozenSeed ?? [],
      committedTrace: request.contextWindow?.committedTrace ?? [],
      transcriptAnchor,
    },
    contextPlan: {
      version: 1,
      budget: {},
      decisions: [],
    },
  };
}

class HeldExecution implements AgentExecution {
  readonly started = deferred<TurnRequest>();
  readonly finished = deferred<Awaited<RunningExecution["result"]>>();
  readonly steered: TurnRequest["inputs"] = [];

  start(request: TurnRequest, control: TurnControl): RunningExecution {
    control.prepareContextWindow(request.contextWindow ?? {
      version: 1,
      id: "window-test",
      frozenSeed: [],
      committedTrace: [],
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
      ...contextResult(request, { sessionId: "session-held", entryId: `entry-${request.turnId}` }),
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
      ...contextResult(request, { sessionId: "session-held", entryId: `entry-${request.turnId}` }),
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

class HeldIntegration implements Integration {
  readonly started = deferred<string>();
  readonly finished = deferred<{ status: "delivered"; remoteId: string }>();

  async deliver(attempt: Parameters<Integration["deliver"]>[0]): Promise<{ status: "delivered"; remoteId: string }> {
    this.started.resolve(attempt.attemptId);
    return this.finished.promise;
  }
}

const completingExecution: AgentExecution = {
  start(request: TurnRequest, control: TurnControl): RunningExecution {
    control.prepareContextWindow(request.contextWindow ?? {
      version: 1,
      id: "window-test",
      frozenSeed: [],
      committedTrace: [],
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
        ...contextResult(request, { sessionId: "session-1", entryId: `entry-${request.turnId}` }),
      }),
      steer: async input => control.includeInput(input.id),
      abort: async () => {},
    };
  },
};

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

test("restores the committed Context Window for the next Turn after restart", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-context-"));
  const observed: TurnRequest[] = [];
  const contextExecution: AgentExecution = {
    start(request, control) {
      observed.push(request);
      control.prepareContextWindow(request.contextWindow ?? {
        version: 1,
        id: "window-1",
        frozenSeed: [{ role: "user", content: "frozen" }],
        committedTrace: [],
      });
      control.includeInput(request.inputs[0]!.id);
      const transcriptAnchor = {
        sessionId: "session-context",
        entryId: `entry-${request.turnId}`,
      };
      return {
        result: Promise.resolve({
          outcome: "completed",
          inputAnchors: request.inputs.map(input => ({
            inputId: input.id,
            transcriptAnchor: {
              sessionId: "session-context",
              entryId: `input-${input.id}`,
            },
          })),
          transcriptAnchor,
          contextWindow: {
            version: 1,
            id: request.contextWindow?.id ?? "window-1",
            frozenSeed: request.contextWindow?.frozenSeed ?? [{ role: "user", content: "frozen" }],
            committedTrace: [
              ...(request.contextWindow?.committedTrace ?? []),
              { role: "user", content: request.inputs[0]!.payload },
            ],
            transcriptAnchor,
          },
          contextPlan: {
            version: 1,
            budget: { selectedMaterialTokens: request.inputs.length },
            decisions: [{ unitId: "current:pending", action: "kept" }],
          },
        }),
        steer: async input => control.includeInput(input.id),
        abort: async () => {},
      };
    },
  };

  const first = openRuntime({ root, execution: contextExecution });
  await first.acceptInput({
    source: "test-channel",
    sourceId: "message-1",
    kind: "interaction",
    payload: { text: "first" },
  });
  assert.deepEqual(await first.advance(), { disposition: "turn_completed" });
  assert.deepEqual(first.status().turns[0]?.contextPlan, {
    version: 1,
    budget: { selectedMaterialTokens: 1 },
    decisions: [{ unitId: "current:pending", action: "kept" }],
  });
  first.close();

  const second = openRuntime({ root, execution: contextExecution });
  t.after(() => second.close());
  await second.acceptInput({
    source: "test-channel",
    sourceId: "message-2",
    kind: "interaction",
    payload: { text: "second" },
  });
  assert.deepEqual(await second.advance(), { disposition: "turn_completed" });

  assert.deepEqual(observed[1]?.contextWindow, {
    version: 1,
    id: "window-1",
    frozenSeed: [{ role: "user", content: "frozen" }],
    committedTrace: [{ role: "user", content: { text: "first" } }],
    transcriptAnchor: observed[0]?.contextWindow?.transcriptAnchor ?? {
      sessionId: "session-context",
      entryId: observed[0] ? `entry-${observed[0].turnId}` : "missing",
    },
  });
});

test("keeps the prepared window seed when its first Turn fails", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-context-seed-"));
  const failingExecution: AgentExecution = {
    start(request, control) {
      control.prepareContextWindow({
        version: 1,
        id: "window-prepared",
        frozenSeed: [{ role: "user", content: "original seed" }],
        committedTrace: [],
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

  assert.deepEqual(request.contextWindow, {
    version: 1,
    id: "window-prepared",
    frozenSeed: [{ role: "user", content: "original seed" }],
    committedTrace: [],
  });

  void advance;
});

test("rejects a completed Turn that replaces its prepared Context Window", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-runtime-context-replace-"));
  const execution: AgentExecution = {
    start(request, control) {
      control.prepareContextWindow({
        version: 1,
        id: "window-prepared",
        frozenSeed: [{ role: "user", content: "original seed" }],
        committedTrace: [],
      });
      control.includeInput(request.inputs[0]!.id);
      const transcriptAnchor = { sessionId: "session-context", entryId: "entry-complete" };
      return {
        result: Promise.resolve({
          outcome: "completed",
          inputAnchors: [{
            inputId: request.inputs[0]!.id,
            transcriptAnchor: { sessionId: "session-context", entryId: "entry-input" },
          }],
          transcriptAnchor,
          contextWindow: {
            version: 1,
            id: "window-replaced",
            frozenSeed: [{ role: "user", content: "changed seed" }],
            committedTrace: [],
            transcriptAnchor,
          },
          contextPlan: { version: 1, budget: {}, decisions: [] },
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

  await assert.rejects(runtime.advance(), /prepared Context Window/i);
  assert.equal(runtime.status().turns[0]?.status, "failed");
  assert.equal(runtime.status().inputs[0]?.status, "pending");
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
  const integration = new HeldIntegration();
  const oldRuntime = openRuntime({
    root,
    execution: effectThenCompleteExecution,
    integration,
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
  const attemptId = await integration.started.promise;
  now += 2_000;

  const replacement = openRuntime({ root, now: () => new Date(now), ownerId: "replacement-runtime" });
  t.after(() => replacement.close());
  const recovered = replacement.status();
  assert.equal(recovered.deliveries.find(delivery => delivery.id === attemptId)?.status, "unknown");
  assert.equal(recovered.effects[0]?.status, "reconciliation_required");

  integration.finished.resolve({ status: "delivered", remoteId: "remote-1" });
  await assert.rejects(lateDelivery, /no longer accepts writes/);
  assert.equal(replacement.status().deliveries[0]?.status, "unknown");
});
