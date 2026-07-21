import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createTimePolicy } from "../../src/configuration/index.js";
import type {
  ActivityFreezeRequest,
  AgentExecution,
  JsonValue,
  OrientationRequest,
  TurnRequest,
} from "../../src/runtime/index.js";
import { openRuntime } from "../../src/runtime/index.js";

test("uses one Instance Time Policy for Opportunity context and Activity recording day", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-time-policy-"));
  const orientationRequests: OrientationRequest[] = [];
  const freezeRequests: ActivityFreezeRequest[] = [];
  const execution: AgentExecution = {
    start(request, control) {
      control.prepareExecutionState(request.executionState ?? { branch: "prepared" });
      control.includeInput(request.inputs[0]!.id);
      control.recordToolActivity({
        toolCallId: "inspect-time",
        toolName: "read",
        callArguments: { path: "attention.md" },
        result: { content: [{ type: "text", text: "current evidence" }] },
      });
      return {
        result: Promise.resolve(executionResult(request, { branch: "complete" })),
        steer: async () => {},
        abort: async () => {},
      };
    },
  };
  const runtime = openRuntime({
    root,
    execution,
    now: () => new Date("2026-10-25T01:30:00.000Z"),
    timePolicy: createTimePolicy({
      timeZone: "Europe/Berlin",
      logicalDayStart: "03:00",
    }),
    orientation: {
      async form(request) {
        orientationRequests.push(request);
        return {
          outcome: "opportunity",
          runId: "orientation-time-policy",
          narrative: "A grounded private opening.",
          whyNow: "The evidence remains active.",
          evidence: ["attention.md"],
        };
      },
    },
    activityLifecycle: {
      async freeze(request) {
        freezeRequests.push(request);
        return {
          activity: {
            version: 1,
            segmentId: request.segment.id,
            recordingDay: request.segment.recordingDay,
            openedAt: request.segment.openedAt,
            closedAt: request.segment.closedAt,
            events: [],
            turns: [],
          },
          successorExecutionState: { branch: "successor" },
        };
      },
    },
  });
  t.after(() => runtime.close());

  assert.equal((await runtime.formOpportunity()).disposition, "accepted");
  assert.equal(orientationRequests[0]?.localTime, "2026-10-25 02:30 +01:00");
  assert.deepEqual(await runtime.advance(), { disposition: "turn_completed" });
  assert.equal(freezeRequests[0]?.segment.recordingDay, "2026-10-24");
});

test("forms one grounded Opportunity while the Runtime is idle", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-"));
  const requests: OrientationRequest[] = [];
  const runtime = openRuntime({
    root,
    now: () => new Date("2026-07-20T06:30:00.000Z"),
    orientation: {
      async form(request) {
        requests.push(request);
        return {
          outcome: "opportunity",
          runId: "orientation-run-1",
          narrative: "A current line has a concrete place to continue.",
          whyNow: "The latest evidence left it open.",
          evidence: ["attention.md names the open line"],
        };
      },
    },
  });
  t.after(() => runtime.close());

  assert.deepEqual(await runtime.formOpportunity(), {
    disposition: "accepted",
    inputId: runtime.status().inputs[0]?.id,
    runId: "orientation-run-1",
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.observedAt, "2026-07-20T06:30:00.000Z");
  assert.equal(requests[0]?.lastHumanInputAt, undefined);
  assert.deepEqual(requests[0]?.recentActivities, []);
  assert.deepEqual(runtime.status().inputs.map(input => ({
    source: input.source,
    sourceId: input.sourceId,
    kind: input.kind,
    status: input.status,
  })), [{
    source: "orientation",
    sourceId: "orientation-run-1",
    kind: "opportunity",
    status: "pending",
  }]);
});

test("creates no Input when Orientation finds no grounded Opportunity", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-none-"));
  const runtime = openRuntime({
    root,
    orientation: {
      async form() {
        return {
          outcome: "none",
          runId: "orientation-run-none",
          whyNow: "The inspected evidence has no current traction.",
          evidence: ["attention.md contains no open line"],
        };
      },
    },
  });
  t.after(() => runtime.close());

  assert.deepEqual(await runtime.formOpportunity(), {
    disposition: "none",
    runId: "orientation-run-none",
  });
  assert.deepEqual(runtime.status().inputs, []);
});

test("freezes a standalone proactive tool activity immediately after its Turn", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-private-"));
  const freezes: ActivityFreezeRequest[] = [];
  const execution: AgentExecution = {
    start(request, control) {
      control.prepareExecutionState(request.executionState ?? { branch: "prepared" });
      control.includeInput(request.inputs[0]!.id);
      control.recordToolActivity?.({
        toolCallId: "read-private",
        toolName: "read",
        callArguments: { path: "threads/private.md" },
        result: { content: [{ type: "text", text: "private evidence" }] },
      });
      return {
        result: Promise.resolve(executionResult(request, { branch: "private-complete" })),
        steer: async () => {},
        abort: async () => {},
      };
    },
  };
  const runtime = openRuntime({
    root,
    execution,
    activityLifecycle: {
      async freeze(request) {
        freezes.push(request);
        return {
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
          successorExecutionState: { branch: "successor" },
        };
      },
    },
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({
    source: "orientation",
    sourceId: "orientation-private",
    kind: "opportunity",
    payload: {
      version: 1,
      narrative: "Continue the private line.",
      observedAt: "2026-07-20T06:30:00.000Z",
    },
  });

  assert.deepEqual(await runtime.advance(), { disposition: "turn_completed" });
  assert.equal(runtime.status().activeSegment, undefined);
  assert.equal(runtime.status().activities[0]?.status, "pending");
  assert.equal(freezes.length, 1);
});

test("preserves failed proactive tool activity without replaying the Opportunity", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-failed-private-"));
  const freezes: ActivityFreezeRequest[] = [];
  const execution: AgentExecution = {
    start(request, control) {
      control.prepareExecutionState(request.executionState ?? { branch: "prepared" });
      control.includeInput(request.inputs[0]!.id);
      control.recordToolActivity?.({
        toolCallId: "edit-private",
        toolName: "edit",
        callArguments: { path: "threads/private.md", oldText: "a", newText: "b" },
        result: { content: [{ type: "text", text: "changed" }] },
      });
      return {
        result: Promise.reject(new Error("provider failed after tool activity")),
        steer: async () => {},
        abort: async () => {},
      };
    },
  };
  const runtime = openRuntime({
    root,
    execution,
    activityLifecycle: {
      async freeze(request) {
        freezes.push(request);
        return {
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
          successorExecutionState: { branch: "successor-after-failure" },
        };
      },
    },
  });
  t.after(() => runtime.close());

  await runtime.acceptInput({
    source: "orientation",
    sourceId: "orientation-failed-private",
    kind: "opportunity",
    payload: {
      version: 1,
      narrative: "Continue the private line.",
      observedAt: "2026-07-20T06:30:00.000Z",
    },
  });

  await assert.rejects(runtime.advance(), /provider failed after tool activity/);
  assert.equal(runtime.status().inputs[0]?.status, "consumed");
  assert.equal(runtime.status().activeSegment, undefined);
  assert.equal(runtime.status().activities[0]?.status, "pending");
  assert.deepEqual(freezes[0]?.toolActivities, [{
    turnId: runtime.status().turns[0]?.id,
    toolCallId: "edit-private",
    toolName: "edit",
    callArguments: { path: "threads/private.md", oldText: "a", newText: "b" },
    result: { content: [{ type: "text", text: "changed" }] },
    completedAt: freezes[0]?.toolActivities[0]?.completedAt,
  }]);
});

test("keeps a proactive Segment open after a message Effect", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-message-"));
  const execution: AgentExecution = {
    start(request, control) {
      control.prepareExecutionState(request.executionState ?? { branch: "prepared" });
      control.includeInput(request.inputs[0]!.id);
      control.prepareEffect({
        kind: "message",
        routeRef: "primary",
        payload: { text: "A genuine message." },
      });
      return {
        result: Promise.resolve(executionResult(request, { branch: "message-complete" })),
        steer: async () => {},
        abort: async () => {},
      };
    },
  };
  const runtime = openRuntime({ root, execution });
  t.after(() => runtime.close());
  await runtime.acceptInput({
    source: "orientation",
    sourceId: "orientation-message",
    kind: "opportunity",
    payload: { version: 1, narrative: "Something is worth sharing.", observedAt: "2026-07-20T06:30:00.000Z" },
  });

  assert.deepEqual(await runtime.advance(), { disposition: "turn_completed" });
  assert.ok(runtime.status().activeSegment);
  assert.equal(runtime.status().effects.length, 1);
});

test("keeps a human Input in the proactive Segment when it arrives during the Turn", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-steer-"));
  const started = deferred<void>();
  const release = deferred<void>();
  const included = new Set<string>();
  let controlRef: Parameters<AgentExecution["start"]>[1] | undefined;
  const requestInputs: TurnRequest["inputs"] = [];
  const execution: AgentExecution = {
    start(request, control) {
      controlRef = control;
      requestInputs.push(...request.inputs);
      control.prepareExecutionState(request.executionState ?? { branch: "prepared" });
      control.includeInput(request.inputs[0]!.id);
      included.add(request.inputs[0]!.id);
      started.resolve();
      return {
        result: release.promise.then(() => executionResult({ ...request, inputs: requestInputs }, { branch: "steered" })),
        steer: async input => {
          requestInputs.push(input);
          controlRef!.includeInput(input.id);
          included.add(input.id);
        },
        abort: async () => {},
      };
    },
  };
  const runtime = openRuntime({ root, execution });
  t.after(() => runtime.close());
  await runtime.acceptInput({
    source: "orientation",
    sourceId: "orientation-steer",
    kind: "opportunity",
    payload: { version: 1, narrative: "A private opening.", observedAt: "2026-07-20T06:30:00.000Z" },
  });
  const advancing = runtime.advance();
  await started.promise;
  const human = await runtime.acceptInput({
    source: "test-channel",
    sourceId: "human-during-opportunity",
    kind: "interaction",
    payload: { text: "I arrived during the background Turn." },
  });
  release.resolve();

  assert.deepEqual(await advancing, { disposition: "turn_completed" });
  assert.ok(included.has(human.inputId));
  assert.ok(runtime.status().activeSegment);
  assert.equal(runtime.status().inputs.find(input => input.id === human.inputId)?.status, "consumed");
});

test("yields proactive Activity closure when human Input arrives during freeze", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-close-race-"));
  const freezeStarted = deferred<void>();
  const releaseFreeze = deferred<void>();
  const segmentIds: string[] = [];
  const execution: AgentExecution = {
    start(request, control) {
      control.prepareExecutionState(request.executionState ?? { branch: "prepared" });
      control.includeInput(request.inputs[0]!.id);
      if (request.inputs[0]!.kind === "opportunity") {
        control.recordToolActivity?.({
          toolCallId: "read-private",
          toolName: "read",
          callArguments: { path: "threads/private.md" },
          result: { content: [{ type: "text", text: "private evidence" }] },
        });
      }
      return {
        result: Promise.resolve(executionResult(request, { branch: request.inputs[0]!.kind })),
        steer: async () => {},
        abort: async () => {},
      };
    },
  };
  const runtime = openRuntime({
    root,
    execution,
    activityLifecycle: {
      async freeze(request) {
        segmentIds.push(request.segment.id);
        freezeStarted.resolve();
        await releaseFreeze.promise;
        return {
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
          successorExecutionState: { branch: "must-not-install" },
        };
      },
    },
  });
  t.after(() => runtime.close());
  await runtime.acceptInput({
    source: "orientation",
    sourceId: "orientation-close-race",
    kind: "opportunity",
    payload: { version: 1, narrative: "Continue privately.", observedAt: "2026-07-20T06:30:00.000Z" },
  });
  const proactiveAdvance = runtime.advance();
  await freezeStarted.promise;
  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "human-during-close",
    kind: "interaction",
    payload: { text: "I arrived while the activity was closing." },
  });
  releaseFreeze.resolve();

  assert.deepEqual(await proactiveAdvance, { disposition: "turn_completed" });
  assert.equal(runtime.status().activities.length, 0);
  const originalSegment = runtime.status().activeSegment?.id;
  assert.equal(originalSegment, segmentIds[0]);

  assert.deepEqual(await runtime.advance(), { disposition: "turn_completed" });
  assert.equal(runtime.status().activeSegment?.id, originalSegment);
});

test("discards a silent Opportunity Segment and restores the prior Main Agent state", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-silent-"));
  const requests: TurnRequest[] = [];
  const execution: AgentExecution = {
    start(request, control) {
      requests.push(request);
      control.prepareExecutionState(request.executionState ?? { branch: "provisional" });
      control.includeInput(request.inputs[0]!.id);
      return {
        result: Promise.resolve(executionResult(request, { branch: "silent-output" })),
        steer: async () => {},
        abort: async () => {},
      };
    },
  };
  const runtime = openRuntime({ root, execution });
  t.after(() => runtime.close());

  await runtime.acceptInput({
    source: "orientation",
    sourceId: "orientation-run-silent",
    kind: "opportunity",
    payload: {
      version: 1,
      narrative: "A possible point that can be left alone.",
      observedAt: "2026-07-20T06:30:00.000Z",
    },
  });
  assert.deepEqual(await runtime.advance(), { disposition: "turn_completed" });
  assert.equal(runtime.status().inputs[0]?.status, "consumed");
  assert.equal(runtime.status().activeSegment, undefined);

  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "human-after-silence",
    kind: "interaction",
    payload: { text: "hello after silence" },
  });
  assert.deepEqual(await runtime.advance(), { disposition: "turn_completed" });
  assert.equal(requests[1]?.executionState, undefined);
});

test("discards an Orientation result when human Input wins the idle race", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-proactive-race-"));
  let resolveOrientation!: (value: {
    outcome: "opportunity";
    runId: string;
    narrative: string;
    whyNow: string;
    evidence: string[];
  }) => void;
  const result = new Promise<{
    outcome: "opportunity";
    runId: string;
    narrative: string;
    whyNow: string;
    evidence: string[];
  }>(resolve => {
    resolveOrientation = resolve;
  });
  const runtime = openRuntime({
    root,
    orientation: { form: async () => result },
  });
  t.after(() => runtime.close());

  const forming = runtime.formOpportunity();
  await runtime.acceptInput({
    source: "test-channel",
    sourceId: "human-1",
    kind: "interaction",
    payload: { text: "I arrived while Orientation was looking." },
  });
  resolveOrientation({
    outcome: "opportunity",
    runId: "orientation-run-raced",
    narrative: "This result is stale.",
    whyNow: "It was grounded before the human arrived.",
    evidence: ["old evidence"],
  });

  assert.deepEqual(await forming, {
    disposition: "stale",
    runId: "orientation-run-raced",
  });
  assert.deepEqual(runtime.status().inputs.map(input => ({
    source: input.source,
    sourceId: input.sourceId,
    kind: input.kind,
  })), [{ source: "test-channel", sourceId: "human-1", kind: "interaction" }]);
});

function executionResult(request: TurnRequest, executionState: JsonValue) {
  return {
    outcome: "completed" as const,
    inputAnchors: request.inputs.map(input => ({
      inputId: input.id,
      transcriptAnchor: { sessionId: "session-test", entryId: `input-${input.id}` },
    })),
    transcriptAnchor: { sessionId: "session-test", entryId: `turn-${request.turnId}` },
    executionState,
    executionRecord: { kind: "test" },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
