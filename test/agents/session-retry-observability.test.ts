import assert from "node:assert/strict";
import { test } from "node:test";

import {
  forwardPiAutoRetryEvents,
} from "../../src/agents/session/index.js";
import type { OperationalEvent } from "../../src/operational-events.js";

type SessionListener = (event: { type?: string } & Record<string, unknown>) => void;

function fakeSession() {
  const listeners: SessionListener[] = [];
  return {
    session: {
      subscribe(listener: SessionListener) {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
    },
    emit(event: { type?: string } & Record<string, unknown>): void {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount(): number {
      return listeners.length;
    },
  };
}

test("auto retry events are forwarded as bounded operational events", () => {
  const harness = fakeSession();
  const observed: OperationalEvent[] = [];
  const unsubscribe = forwardPiAutoRetryEvents(
    harness.session,
    event => observed.push(event),
    "life-recorder",
  );

  harness.emit({
    type: "auto_retry_start",
    attempt: 2,
    maxAttempts: 4,
    delayMs: 8000,
    errorMessage: "Stream ended without finish_reason",
  });
  harness.emit({ type: "auto_retry_end", success: true, attempt: 2 });

  assert.deepEqual(observed, [
    {
      event: "agent.retry.scheduled",
      at: observed[0]!.at,
      agentName: "life-recorder",
      attempt: 2,
      maxAttempts: 4,
      delayMs: 8000,
    },
    {
      event: "agent.retry.finished",
      at: observed[1]!.at,
      agentName: "life-recorder",
      success: true,
      attempt: 2,
    },
  ]);
  // Raw provider error text must not leak into the operational stream.
  assert.equal(JSON.stringify(observed).includes("finish_reason"), false);

  unsubscribe();
  harness.emit({ type: "auto_retry_start", attempt: 3, maxAttempts: 4, delayMs: 16_000 });
  assert.equal(observed.length, 2);
});

test("unrelated session events and missing observers are ignored", () => {
  const harness = fakeSession();
  const observed: OperationalEvent[] = [];

  forwardPiAutoRetryEvents(harness.session, event => observed.push(event), "orientation");
  harness.emit({ type: "turn_end", message: { role: "assistant" } });
  harness.emit({ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 1000 });
  assert.deepEqual(observed, []);
});
