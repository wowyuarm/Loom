import assert from "node:assert/strict";
import test from "node:test";

import {
  createProcessDriver,
  type LoomInstance,
  type LoomInstanceRunResult,
} from "../../src/instance/index.js";
import type { RuntimeInput } from "../../src/runtime/index.js";

test("wakes a waiting Instance immediately after accepting new Input", async () => {
  const inputs: RuntimeInput[] = [];
  const waits: Array<Date | undefined> = [];
  let runs = 0;
  let closes = 0;
  const instance = fakeInstance({
    acceptInput: async input => {
      inputs.push(input);
      return { disposition: "accepted", inputId: "input-1" };
    },
    runOnce: async () => {
      runs += 1;
      return runs === 1
        ? { disposition: "waiting", nextRunAt: "2026-07-22T11:00:00.000Z" }
        : { disposition: "idle" };
    },
    close: () => {
      closes += 1;
    },
  });
  const driver = createProcessDriver({
    instance,
    now: () => new Date("2026-07-22T10:00:00.000Z"),
    wait: async (until, signal) => {
      waits.push(until);
      await aborted(signal);
    },
  });

  driver.start();
  await eventually(() => waits.length === 1);
  assert.equal(waits[0]?.toISOString(), "2026-07-22T11:00:00.000Z");
  assert.deepEqual(driver.status().lastRun, {
    observedAt: "2026-07-22T10:00:00.000Z",
    result: {
      disposition: "waiting",
      nextRunAt: "2026-07-22T11:00:00.000Z",
    },
  });

  await driver.acceptInput({
    source: "test-channel",
    sourceId: "wake-input",
    kind: "interaction",
    payload: { text: "hello" },
  });
  await eventually(() => runs === 2 && waits.length === 2);

  assert.equal(inputs.length, 1);
  assert.equal(waits[1], undefined);
  await driver.stop();
  assert.equal(closes, 1);
});

test("does not lose Input wakeups that arrive while runOnce is active", async t => {
  const firstRun = deferred<LoomInstanceRunResult>();
  let runs = 0;
  const instance = fakeInstance({
    runOnce: async () => {
      runs += 1;
      return runs === 1 ? firstRun.promise : { disposition: "idle" };
    },
  });
  const driver = createProcessDriver({
    instance,
    now: () => new Date("2026-07-22T10:00:00.000Z"),
    wait: abortedWait,
  });
  t.after(() => driver.stop());

  driver.start();
  await eventually(() => runs === 1);
  await driver.acceptInput({
    source: "test-channel",
    sourceId: "during-run",
    kind: "interaction",
    payload: { text: "arrived during the turn" },
  });
  firstRun.resolve({ disposition: "waiting", nextRunAt: "2026-07-22T11:00:00.000Z" });

  await eventually(() => runs === 2);
});

test("waits for the active runOnce before closing on stop", async () => {
  const activeRun = deferred<LoomInstanceRunResult>();
  let started = false;
  let closed = false;
  const driver = createProcessDriver({
    instance: fakeInstance({
      runOnce: async () => {
        started = true;
        return activeRun.promise;
      },
      close: () => {
        closed = true;
      },
    }),
  });

  driver.start();
  await eventually(() => started);
  const stopping = driver.stop();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(closed, false);

  activeRun.resolve({ disposition: "idle" });
  await stopping;
  assert.equal(closed, true);
});

test("keeps an unexpected run failure visible and schedules process recovery", async t => {
  const waits: Array<Date | undefined> = [];
  let runs = 0;
  const driver = createProcessDriver({
    instance: fakeInstance({
      runOnce: async () => {
        runs += 1;
        if (runs === 1) throw new Error("provider connection failed");
        return { disposition: "idle" };
      },
    }),
    now: () => new Date("2026-07-22T10:00:00.000Z"),
    wait: async (until, signal) => {
      waits.push(until);
      await aborted(signal);
    },
  });
  t.after(() => driver.stop());

  driver.start();
  await eventually(() => waits.length === 1);

  assert.deepEqual(driver.status(), {
    state: "waiting",
    nextRunAt: "2026-07-22T10:00:30.000Z",
    lastError: {
      occurredAt: "2026-07-22T10:00:00.000Z",
      message: "provider connection failed",
    },
  });

  driver.wake();
  await eventually(() => runs === 2 && waits.length === 2);
});

test("retries transient busy results without polling other deferred work", async t => {
  const waits: Array<Date | undefined> = [];
  const driver = createProcessDriver({
    instance: fakeInstance({
      runOnce: async () => ({
        disposition: "busy",
        nextRunAt: "2026-07-22T11:00:00.000Z",
      }),
    }),
    now: () => new Date("2026-07-22T10:00:00.000Z"),
    wait: async (until, signal) => {
      waits.push(until);
      await aborted(signal);
    },
  });
  t.after(() => driver.stop());

  driver.start();
  await eventually(() => waits.length === 1);

  assert.equal(waits[0]?.toISOString(), "2026-07-22T10:00:01.000Z");
});

function fakeInstance(overrides: Partial<LoomInstance>): LoomInstance {
  return {
    acceptInput: async () => ({ disposition: "accepted", inputId: "input" }),
    runOnce: async (): Promise<LoomInstanceRunResult> => ({ disposition: "idle" }),
    formOpportunity: async () => ({ disposition: "busy" }),
    status: () => { throw new Error("status is not used by process driver tests"); },
    close: () => {},
    ...overrides,
  };
}

async function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function abortedWait(_until: Date | undefined, signal: AbortSignal): Promise<void> {
  await aborted(signal);
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}
