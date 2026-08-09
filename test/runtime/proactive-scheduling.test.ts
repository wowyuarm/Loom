import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { createTimePolicy } from "../../src/configuration/index.js";
import {
  createScheduler,
  openRuntime,
  isPreemptingInteractionSignal,
  type ActivityLifecycle,
  type ActivityRecorder,
  type AgentExecution,
  type InteractionContext,
  type Orientation,
  type OrientationResult,
  type RunningExecution,
  type Runtime,
  type RuntimeInput,
  type TurnRequest,
  type TurnControl,
  type ExecutionInput,
  type EffectRequest,
} from "../../src/runtime/index.js";

/** Build an interaction Input with a chosen signal (foreground/ambient). */
function interactionInput(
  sourceId: string,
  signal: InteractionContext["signal"],
  overrides: { actorKind?: "human" | "agent" | "system"; placeKind?: "direct" | "channel" | "reply_thread" } = {},
): RuntimeInput {
  const actorKind = overrides.actorKind ?? "human";
  return {
    source: "test-channel",
    sourceId,
    kind: "interaction",
    payload: { text: `input-${sourceId}` },
    interaction: {
      routeRef: "test-route",
      signal,
      actor: { actorRef: actorKind === "human" ? "human" : `external:${actorKind}`, kind: actorKind },
      place: {
        placeRef: `place-${sourceId}`,
        kind: overrides.placeKind
          ?? (signal === "thread_reply" ? "reply_thread"
            : signal === "channel_activity" ? "channel"
            : "direct"),
        visibility: "private",
      },
      audience: { visibility: "private", description: "test audience" },
      references: [{ kind: "message", ref: `msg-${sourceId}` }],
      destinations: [{ destinationRef: `dest-${sourceId}`, routeRef: "test-route", kind: "top_level" }],
      defaultDestinationRef: `dest-${sourceId}`,
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void; settled: boolean } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (v: T) => { settled = true; res(v); };
    reject = (e: unknown) => { settled = true; rej(e); };
  });
  return { promise, resolve, reject, get settled() { return settled; } };
}

const activityLifecycle: ActivityLifecycle = {
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
};

function recorder(requests: Array<{ activityIds: string[] }>): ActivityRecorder {
  return {
    async record(activity) {
      requests.push({ activityIds: [activity.segmentId] });
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

/** Held execution that stays open; records steered Inputs. */
class HeldExecution implements AgentExecution {
  readonly started = deferred<TurnRequest>();
  readonly finished = deferred<Awaited<RunningExecution["result"]>>();
  readonly steered: ExecutionInput[] = [];

  start(request: TurnRequest, control: TurnControl): RunningExecution {
    control.prepareExecutionState(request.executionState ?? { version: 1 });
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
    const all = [...request.inputs, ...this.steered];
    this.finished.resolve({
      outcome: "no_reply",
      inputAnchors: all.map(input => ({
        inputId: input.id,
        transcriptAnchor: { sourceId: request.recordingDay, sessionId: "sess", entryId: `in-${input.id}` },
      })),
      transcriptAnchor: { sourceId: request.recordingDay, sessionId: "sess", entryId: `turn-${request.turnId}` },
      executionState: { version: 1, turnId: request.turnId },
      executionRecord: { version: 1, turnId: request.turnId },
    });
  }
}

/** Completing execution that always emits a delivered message Effect. */
function messageExecution(): AgentExecution {
  return {
    start(request, control) {
      control.prepareExecutionState(request.executionState ?? { version: 1 });
      control.includeInput(request.inputs[0]!.id);
      control.prepareEffect({
        kind: "message",
        payload: { text: "reply" },
        routeRef: "test-route",
      });
      return {
        result: Promise.resolve({
          outcome: "completed",
          inputAnchors: request.inputs.map(input => ({
            inputId: input.id,
            transcriptAnchor: { sourceId: request.recordingDay, sessionId: "sess", entryId: `in-${input.id}` },
          })),
          transcriptAnchor: { sourceId: request.recordingDay, sessionId: "sess", entryId: `turn-${request.turnId}` },
          executionState: { version: 1, turnId: request.turnId },
          executionRecord: { version: 1 },
        }),
        steer: async () => {},
        abort: async () => {},
      };
    },
  };
}

/** Completing execution that always returns no_reply (no Effect, no tool). */
function noReplyExecution(): AgentExecution {
  return {
    start(request, control) {
      control.prepareExecutionState(request.executionState ?? { version: 1 });
      control.includeInput(request.inputs[0]!.id);
      return {
        result: Promise.resolve({
          outcome: "no_reply",
          inputAnchors: request.inputs.map(input => ({
            inputId: input.id,
            transcriptAnchor: { sourceId: request.recordingDay, sessionId: "sess", entryId: `in-${input.id}` },
          })),
          transcriptAnchor: { sourceId: request.recordingDay, sessionId: "sess", entryId: `turn-${request.turnId}` },
          executionState: { version: 1, turnId: request.turnId },
          executionRecord: { version: 1 },
        }),
        steer: async () => {},
        abort: async () => {},
      };
    },
  };
}

/** Completing execution (no_reply) that records each claimed turn's input order. */
class LoggingExecution implements AgentExecution {
  readonly log: Array<{ turnId: string; inputs: string[] }> = [];
  outcome: "no_reply" | "completed" = "no_reply";
  readonly starts = deferred<TurnRequest>();

  start(request: TurnRequest, control: TurnControl): RunningExecution {
    control.prepareExecutionState(request.executionState ?? { version: 1 });
    control.includeInput(request.inputs[0]!.id);
    this.log.push({ turnId: request.turnId, inputs: request.inputs.map(input => input.id) });
    this.starts.resolve(request);
    return {
      result: Promise.resolve({
        outcome: this.outcome,
        inputAnchors: request.inputs.map(input => ({
          inputId: input.id,
          transcriptAnchor: { sourceId: request.recordingDay, sessionId: "sess", entryId: `in-${input.id}` },
        })),
        transcriptAnchor: { sourceId: request.recordingDay, sessionId: "sess", entryId: `turn-${request.turnId}` },
        executionState: { version: 1, turnId: request.turnId },
        executionRecord: { version: 1, turnId: request.turnId },
      }),
      steer: async input => control.includeInput(input.id),
      abort: async () => {},
    };
  }
}

/** Orientation that can be gated open; reports each call and can emit an Opportunity. */
class HeldOrientation implements Orientation {
  readonly calls: Array<{ outcome: "none" | "opportunity"; runId: string }> = [];
  readonly gate = deferred<void>();
  readonly awaiting = deferred<void>();
  blocking = true;
  emitOpportunityOnNext = false;

  async form(): Promise<OrientationResult> {
    if (this.blocking) {
      this.awaiting.resolve();
      await this.gate.promise;
    }
    const n = this.calls.length + 1;
    const outcome: "none" | "opportunity" = this.emitOpportunityOnNext ? "opportunity" : "none";
    this.emitOpportunityOnNext = false;
    this.calls.push({ outcome, runId: `orientation-${n}` });
    if (outcome === "opportunity") {
      return {
        outcome,
        runId: `orientation-${n}`,
        narrative: "proactive call to action",
        whyNow: "test",
        evidence: [],
      };
    }
    return { outcome: "none", runId: `orientation-${n}`, whyNow: "test", evidence: [] };
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime state");
    await delay(1);
  }
}

function pulsePolicy(): {
  timeZone: string;
  intervalMs: number;
  initialDelayMs: number;
  quietHours: { start: string; end: string; intervalMs: number };
} {
  return {
    timeZone: "UTC",
    intervalMs: 60_000,
    initialDelayMs: 1,
    quietHours: { start: "00:00", end: "00:01", intervalMs: 60_000 },
  };
}

// ---------------------------------------------------------------------------
// Contract 1 — thread_reply → no_reply leaves an Active Segment; a due Pulse
// Fair-splits it; Orientation runs against the just-frozen Activity; reply kept.
// ---------------------------------------------------------------------------
test("thread_reply settles no_reply, leaves an Active Segment, and a due Pulse Fair-splits it for Orientation", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-split-"));
  let now = new Date("2026-07-21T17:00:00.000Z");
  const orientation = new HeldOrientation();
  orientation.blocking = false;
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: new LoggingExecution(),
    activityLifecycle,
    activityRecorder: recorder([]),
    orientation,
    now: () => now,
  });
  t.after(() => runtime.close());
  const scheduler = createScheduler({ runtime, proactivePulse: pulsePolicy() });
  await scheduler.runOnce(now); // establish the Pulse schedule

  await runtime.acceptInput(interactionInput("reply-a", "thread_reply", { actorKind: "agent", placeKind: "reply_thread" }));
  await runtime.advance();
  assert.ok(runtime.status().activeSegment, "a no_reply thread_reply should leave an Active Segment");
  assert.equal(runtime.status().inputs[0]?.status, "consumed");

  now = new Date("2026-07-21T17:05:00.000Z");
  await scheduler.runOnce(now);
  assert.equal(orientation.calls.length, 1, "Orientation should run after the fair split");
  assert.equal(runtime.status().activeSegment, undefined, "the Segment should be frozen by the fair split");
  assert.equal(runtime.status().activities.length, 1, "one Frozen Activity from the split");
  assert.equal(runtime.status().inputs[0]?.status, "consumed", "the ambient reply is not dropped");
});

// ---------------------------------------------------------------------------
// Contract 5 — Pulse overdue + active Segment + pending thread replies: the
// split-formed Opportunity or none completes before the older replies run; a
// pending foreground Input / running Turn / Delivery must not be bypassed.
// ---------------------------------------------------------------------------
test("after a Fair split, the Opportunity/none completes before earlier thread replies are reprocessed", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-order-"));
  let now = new Date("2026-07-21T17:00:00.000Z");
  const orientation = new HeldOrientation();
  orientation.blocking = false;
  orientation.emitOpportunityOnNext = true;
  const exec = new LoggingExecution();
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: exec,
    activityLifecycle,
    activityRecorder: recorder([]),
    orientation,
    now: () => now,
  });
  t.after(() => runtime.close());
  const scheduler = createScheduler({ runtime, proactivePulse: pulsePolicy() });
  await scheduler.runOnce(now);

  await runtime.acceptInput(interactionInput("reply-early", "thread_reply", { actorKind: "agent", placeKind: "reply_thread" }));
  await runtime.acceptInput(interactionInput("reply-later", "thread_reply", { actorKind: "agent", placeKind: "reply_thread" }));
  await runtime.advance();
  const replyA = runtime.status().inputs[0]!.id;
  const replyB = runtime.status().inputs[1]!.id;
  assert.ok(runtime.status().activeSegment);

  now = new Date("2026-07-21T17:10:00.000Z");
  const turnsBefore = exec.log.length;
  await scheduler.runOnce(now);

  // New Turns claimed during the Fair-split pass: the first must be the
  // Proactive Opportunity (not an older ambient reply); any subsequent turns
  // then reprocess the replies in order.
  const newTurns = exec.log.slice(turnsBefore);
  assert.equal(orientation.calls.length, 1, "Orientation ran once during the split");
  assert.ok(newTurns.length >= 1, "at least one turn was claimed in the split pass");
  const firstNewInputs = newTurns[0]?.inputs ?? [];
  assert.ok(!firstNewInputs.includes(replyA) && !firstNewInputs.includes(replyB),
    "the Opportunity must run before the earlier thread replies");
  // Replies are still present and durable after the pass.
  const ids = runtime.status().inputs.map(input => input.id);
  assert.ok(ids.includes(replyA) && ids.includes(replyB), "the thread replies are not lost");
});

// ---------------------------------------------------------------------------
// Contract 3 — an ambient thread_reply does not delete a pending (unexecuted)
// Opportunity; a foreground Input does.
// ---------------------------------------------------------------------------
test("a thread_reply does not discard a pending Opportunity; a foreground Input does", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-oppkeep-"));
  const now = new Date("2026-07-21T17:00:00.000Z");
  const orientation = new HeldOrientation();
  orientation.blocking = false;
  orientation.emitOpportunityOnNext = true;
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: new HeldExecution(),
    activityLifecycle,
    activityRecorder: recorder([]),
    orientation,
    now: () => now,
  });
  t.after(() => runtime.close());

  assert.equal((await runtime.formOpportunity()).disposition, "accepted");
  assert.ok(runtime.status().inputs.find(input => input.kind === "opportunity"),
    "an Opportunity is pending before any Input");

  // Ambient: thread_reply must NOT discard the pending Opportunity.
  await runtime.acceptInput(interactionInput("reply-keep", "thread_reply", { actorKind: "agent", placeKind: "reply_thread" }));
  assert.ok(runtime.status().inputs.find(input => input.kind === "opportunity"),
    "an ambient thread_reply must not discard the pending Opportunity");

  // Foreground: a DM must discard the unclaimed Opportunity.
  await runtime.acceptInput(interactionInput("dm-discard", "direct_message"));
  assert.equal(runtime.status().inputs.find(input => input.kind === "opportunity"), undefined,
    "a foreground DM must discard the unclaimed Opportunity");
});

// ---------------------------------------------------------------------------
// Contract 2 — Orientation in flight: a thread_reply does not stale it; a
// foreground DM/mention does (stales it and the foreground runs first).
// ---------------------------------------------------------------------------
async function staling(arrival: RuntimeInput): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-stale-"));
  const now = new Date("2026-07-21T17:00:00.000Z");
  const orientation = new HeldOrientation();
  orientation.blocking = true;
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: new LoggingExecution(),
    activityLifecycle,
    activityRecorder: recorder([]),
    orientation,
    now: () => now,
  });
  try {
    const pending = runtime.formOpportunity();
    await orientation.awaiting.promise;
    await runtime.acceptInput(arrival);
    orientation.gate.resolve();
    const result = await pending;
    return result.disposition;
  } finally {
    await runtime.close();
  }
}

test("a thread_reply does not stale an in-flight Orientation; a foreground DM stales it", async t => {
  const ambient = await staling(interactionInput("r", "thread_reply", { actorKind: "agent", placeKind: "reply_thread" }));
  assert.equal(ambient, "none", "an ambient thread_reply must leave the Orientation to complete normally (not stale)");

  const foreground = await staling(interactionInput("d", "direct_message"));
  assert.equal(foreground, "stale", "a foreground DM must stale the in-flight Orientation");
});

// ---------------------------------------------------------------------------
// Contract 4 — a thread_reply does not steer into a running Proactive Turn; a
// foreground DM still preempts/steers under ordinary rules.
// ---------------------------------------------------------------------------
test("a thread_reply does not steer into a running Proactive Turn; a foreground DM still does", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-steer-"));
  const now = new Date("2026-07-21T17:00:00.000Z");
  const orientation = new HeldOrientation();
  orientation.blocking = false;
  orientation.emitOpportunityOnNext = true;
  const held = new HeldExecution();
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: held,
    activityLifecycle,
    activityRecorder: recorder([]),
    orientation,
    now: () => now,
  });
  t.after(() => runtime.close());

  await runtime.formOpportunity();
  const running = runtime.advance(); // Proactive Turn starts; not awaited yet
  await waitUntil(() => held.started.settled);
  const oppRequest = await held.started.promise;
  assert.equal(held.steered.length, 0);

  // Ambient thread_reply arrives while the Proactive Turn runs: not steered.
  const replyOk = await runtime.acceptInput(interactionInput("reply-nos", "thread_reply", { actorKind: "agent", placeKind: "reply_thread" }));
  await delay(10);
  assert.equal(held.steered.length, 0, "an ambient thread_reply must not steer into the Proactive Turn");
  assert.equal(runtime.status().inputs.find(input => input.id === replyOk.inputId)?.status, "pending",
    "the ambient reply stays pending until the Proactive Turn ends");

  // Foreground DM arrives while the Proactive Turn runs: steers into it.
  const dmOk = await runtime.acceptInput(interactionInput("dm-yes", "direct_message"));
  const deadline = Date.now() + 1_500;
  while (!held.steered.some(input => input.id === dmOk.inputId)) {
    if (Date.now() >= deadline) {
      const dm = runtime.status().inputs.find(input => input.id === dmOk.inputId);
      throw new Error(`DM was not steered into the Proactive Turn. dmStatus=${JSON.stringify(dm)} steered=${JSON.stringify(held.steered.map(i => i.id))}`);
    }
    await delay(1);
  }

  held.complete(oppRequest);
  await running;
});

// ---------------------------------------------------------------------------
// Contract 7 — after-chat: only delivered message Effects schedule a
// continuation; no_reply does not; a due continuation completes in-place before
// an overdue Pulse Fair-splits.
// ---------------------------------------------------------------------------
test("after-chat runs in the original Segment for a delivered message, not for no_reply", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-afterchat-"));
  let now = new Date("2026-07-21T17:00:00.000Z");
  const orientation = new HeldOrientation();
  orientation.blocking = false;
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: messageExecution(),
    activityLifecycle,
    activityRecorder: recorder([]),
    orientation,
    outboundDelivery: {
      deliver: async () => ({ status: "delivered" as const, remoteId: "remote-1" }),
    },
    now: () => now,
  });
  t.after(() => runtime.close());
  const scheduler = createScheduler({ runtime, proactivePulse: pulsePolicy() });
  await scheduler.runOnce(now);

  // A delivered-message interaction schedules after-chat on the SAME segment.
  await runtime.acceptInput(interactionInput("ask", "direct_message"));
  await runtime.advance();
  const segBefore = runtime.status().activeSegment?.id;
  assert.ok(segBefore, "an active Segment exists");
  assert.equal((await runtime.advance()).disposition, "delivery_completed");
  const continuation = runtime.status().afterChatContinuation;
  assert.ok(continuation, "a delivered message schedules an after-chat continuation");
  assert.equal(continuation.sourceSegmentId, segBefore, "the continuation stays in the original Segment");
  assert.equal(continuation.sourceBehavior, "interactivity");

  // The pending (due) continuation completes in-place before an overdue Pulse
  // triggers a Fair split; it is not bypassed or split away.
  now = new Date("2026-07-21T17:05:00.000Z");
  await scheduler.runOnce(now);
  assert.equal(runtime.status().afterChatContinuation?.status, "completed",
    "the continuation must be allowed to complete before a Fair split");
});

test("no_reply does not schedule an after-chat continuation", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-noafterchat-"));
  let now = new Date("2026-07-21T17:00:00.000Z");
  const orientation = new HeldOrientation();
  orientation.blocking = false;
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: noReplyExecution(),
    activityLifecycle,
    activityRecorder: recorder([]),
    orientation,
    now: () => now,
  });
  t.after(() => runtime.close());
  await runtime.acceptInput(interactionInput("quiet", "thread_reply", { actorKind: "agent", placeKind: "reply_thread" }));
  await runtime.advance();
  assert.equal(runtime.status().afterChatContinuation, undefined,
    "no_reply must not schedule an after-chat continuation");
});

// ---------------------------------------------------------------------------
// Contract 6 — an ambient Input does not roll back a Fair-split close; a
// pending foreground Input blocks the split (human-first); replies not lost.
// ---------------------------------------------------------------------------
test("an ambient thread_reply does not roll back a Fair-split close, and is not lost", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-ambientclose-"));
  let now = new Date("2026-07-21T17:00:00.000Z");
  const orientation = new HeldOrientation();
  orientation.blocking = false;
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: noReplyExecution(),
    activityLifecycle,
    activityRecorder: recorder([]),
    orientation,
    now: () => now,
  });
  t.after(() => runtime.close());
  const scheduler = createScheduler({ runtime, proactivePulse: pulsePolicy() });
  await scheduler.runOnce(now);

  await runtime.acceptInput(interactionInput("amb-fc", "thread_reply", { actorKind: "agent", placeKind: "reply_thread" }));
  await runtime.advance();
  const segId = runtime.status().activeSegment?.id;
  assert.ok(segId);
  const replyId = runtime.status().inputs[0]!.id;

  // A due Pulse Fair-splits while an ambient reply is still pending; the
  // ambient Input must not roll the close back.
  now = new Date("2026-07-21T17:05:00.000Z");
  await scheduler.runOnce(now);
  const splitFrozen = runtime.status().activities.some(activity => activity.id === segId);
  assert.ok(splitFrozen, "the Fair-split close committed despite the pending ambient reply");
  assert.ok(runtime.status().inputs.some(i => i.id === replyId), "the ambient reply is not lost");
});

test("a pending foreground Input blocks the Fair-split (human-first); the reply is not lost", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-foreclose-"));
  let now = new Date("2026-07-21T17:00:00.000Z");
  const orientation = new HeldOrientation();
  orientation.blocking = false;
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: noReplyExecution(),
    activityLifecycle,
    activityRecorder: recorder([]),
    orientation,
    now: () => now,
  });
  t.after(() => runtime.close());
  const scheduler = createScheduler({ runtime, proactivePulse: pulsePolicy() });
  await scheduler.runOnce(now);

  await runtime.acceptInput(interactionInput("orig", "thread_reply", { actorKind: "agent", placeKind: "reply_thread" }));
  await runtime.advance();
  assert.ok(runtime.status().activeSegment);

  // A pending foreground DM must be processed before any Fair split/Orientation
  // can park it behind Proactivity (human-first).
  await runtime.acceptInput(interactionInput("human-dm", "direct_message"));
  const dmId = runtime.status().inputs.find(i => i.sourceId === "human-dm")!.id;
  now = new Date("2026-07-21T17:05:00.000Z");
  const result = await scheduler.runOnce(now);
  const dmRow = runtime.status().inputs.find(i => i.id === dmId);
  assert.equal(dmRow?.status, "consumed", "the foreground DM is processed (consumed) in this pass");
  assert.ok(!["busy", "activity_close_blocked"].includes(result.disposition),
    "the pass did not swallow the pass on a foreground blocker");
  assert.ok(runtime.status().inputs.some(i => i.sourceId === "orig"), "the ambient reply is not lost");
});

// ---------------------------------------------------------------------------
// Contract 8 — the two-class signal helper: ambient vs foreground mapping.
// ---------------------------------------------------------------------------
test("classifies Interaction signals into ambient vs foreground", () => {
  assert.equal(isPreemptingInteractionSignal("thread_reply"), false);
  assert.equal(isPreemptingInteractionSignal("channel_activity"), false);
  assert.equal(isPreemptingInteractionSignal("direct_message"), true);
  assert.equal(isPreemptingInteractionSignal("mention"), true);
  assert.equal(isPreemptingInteractionSignal("task"), true);
  assert.equal(isPreemptingInteractionSignal("reminder"), true);
  assert.equal(isPreemptingInteractionSignal(undefined), true);
  assert.equal(isPreemptingInteractionSignal("other"), true);
});

// ---------------------------------------------------------------------------
// Review NO-GO P1 regression 1 — an ambient thread_reply arriving while an
// in-flight Orientation is about to emit an Opportunity must not stale it: the
// Opportunity is admitted and the ambient reply stays pending to be processed
// exactly once after it.
// ---------------------------------------------------------------------------
test("an ambient thread_reply during an in-flight Orientation does not stale its Opportunity", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-opp-ambient-"));
  const now = new Date("2026-07-21T17:00:00.000Z");
  const orientation = new HeldOrientation();
  orientation.blocking = true;
  orientation.emitOpportunityOnNext = true;
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: noReplyExecution(),
    activityLifecycle,
    activityRecorder: recorder([]),
    orientation,
    now: () => now,
  });
  t.after(() => runtime.close());

  const pending = runtime.formOpportunity();
  await orientation.awaiting.promise;

  // An ambient thread_reply arrives while Orientation is still in flight.
  await runtime.acceptInput(interactionInput("amb", "thread_reply", { actorKind: "agent", placeKind: "reply_thread" }));

  orientation.gate.resolve();
  const result = await pending;
  assert.equal(result.disposition, "accepted", JSON.stringify(result));

  const opp = runtime.status().inputs.find(input => input.kind === "opportunity");
  assert.ok(opp, "the Opportunity is admitted despite the ambient reply");
  const amb = runtime.status().inputs.find(input => input.sourceId === "amb");
  assert.equal(amb?.status, "pending",
    "the ambient reply stays pending to be processed exactly once after the Opportunity");
});

// ---------------------------------------------------------------------------
// Review NO-GO P1 regression 2 — a pending (not-yet-due) Delivery must not be
// crossed by the Proactive fair-split. With a pending ambient reply AND a not
// yet sent effect, a due Pulse must NOT freeze the Segment; Orientation must
// not run; the reply must not be processed ahead of the Delivery.
// ---------------------------------------------------------------------------
test("a pending not-yet-sent Delivery is not crossed by the Proactive fair-split", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-delivery-"));
  let now = new Date("2026-07-21T17:00:00.000Z");
  const orientations = [] as string[];
  const orientation: Orientation = {
    async form() {
      orientations.push("orientation");
      return { outcome: "none", runId: `orient-${orientations.length}`, whyNow: "test", evidence: [] };
    },
  };
  const runtime = openRuntime({
    root,
    timePolicy: createTimePolicy({ timeZone: "UTC", logicalDayStart: "03:00" }),
    execution: messageExecution(),
    activityLifecycle,
    activityRecorder: recorder([]),
    orientation,
    outboundDelivery: {
      deliver: async () => ({ status: "not_sent" as const, error: "route unavailable" }),
    },
    now: () => now,
  });
  t.after(() => runtime.close());
  const scheduler = createScheduler({
    runtime,
    proactivePulse: pulsePolicy(),
  });
  await scheduler.runOnce(now); // establish the Pulse schedule

  // A delivered-effect interaction produces a pending (not-yet-delivered) effect
  // into the active Segment.
  await runtime.acceptInput(interactionInput("orig-deliver", "thread_reply", { actorKind: "agent", placeKind: "reply_thread" }));
  await runtime.advance();
  assert.ok(runtime.status().activeSegment, "an active Segment exists with a pending Delivery");
  assert.equal(runtime.status().activities.length, 0, "the Segment is not yet frozen");

  // A pending ambient reply must not pull the fair-split across the Delivery.
  await runtime.acceptInput(interactionInput("amb-slack", "thread_reply", { actorKind: "agent", placeKind: "reply_thread" }));

  now = new Date("2026-07-21T17:05:00.000Z");
  const result = await scheduler.runOnce(now);
  assert.equal(runtime.status().activeSegment !== undefined, true,
    "the Segment must NOT be frozen while a Delivery is pending");
  assert.equal(runtime.status().activities.length, 0, "no Activity is frozen by a split while a Delivery is pending");
  assert.equal(orientations.length, 0, "Orientation must not run while a Delivery is pending");
  // The pending Delivery is preserved (not crossed by a fair-split): the pass
  // surfaces the Delivery path rather than silently splitting.
  assert.equal(result.disposition, "deferred", `the scheduler defers to the Delivery path instead of splitting (got ${result.disposition})`);
  assert.equal(result.reason, "delivery_not_sent",
    "the deferred outcome is the not-sent Delivery, not a Proactive split");
});
