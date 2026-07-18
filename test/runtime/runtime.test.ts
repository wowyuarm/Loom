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

class HeldExecution implements AgentExecution {
  readonly started = deferred<TurnRequest>();
  readonly finished = deferred<Awaited<RunningExecution["result"]>>();
  readonly steered: TurnRequest["inputs"] = [];

  start(request: TurnRequest, _control?: TurnControl): RunningExecution {
    this.started.resolve(request);
    return {
      result: this.finished.promise,
      steer: async input => {
        this.steered.push(input);
        return { sessionId: "session-held", entryId: `steer-${input.id}` };
      },
      abort: async () => {},
    };
  }

  complete(request: TurnRequest): void {
    this.finished.resolve({
      outcome: "completed",
      transcriptAnchor: { sessionId: "session-held", entryId: `entry-${request.turnId}` },
    });
  }
}

class EffectThenHoldExecution extends HeldExecution {
  constructor(readonly effect: EffectRequest) {
    super();
  }

  override start(request: TurnRequest, control: TurnControl): RunningExecution {
    control.prepareEffect(this.effect);
    return super.start(request);
  }
}

const effectThenCompleteExecution: AgentExecution = {
  start(request, control): RunningExecution {
    control.prepareEffect({
      kind: "message",
      payload: { text: "hello from the Agent" },
      routeRef: "default",
    });
    return completingExecution.start(request, control);
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
  start(request: TurnRequest): RunningExecution {
    return {
      result: Promise.resolve({
        outcome: "completed",
        transcriptAnchor: { sessionId: "session-1", entryId: `entry-${request.turnId}` },
      }),
      steer: async () => ({ sessionId: "session-1", entryId: "steer-entry" }),
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

  assert.deepEqual(oldExecution.steered.map(input => input.id), [late.inputId]);

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
