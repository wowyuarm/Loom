import assert from "node:assert/strict";
import { test } from "node:test";

import type { RuntimeCognitiveOrganWorkStatus, RuntimeStatus } from "../../src/runtime/index.js";
import {
  createHarnessConditionSource,
  type HarnessConditionStore,
} from "../../src/instance/harness-conditions.js";

class MemoryStore implements HarnessConditionStore {
  readonly presented = new Map<string, number>();
  presentedRefs(): string[] {
    return [...this.presented.keys()];
  }
  markPresented(ref: string, at: Date): void {
    this.presented.set(ref, at.getTime());
  }
  trimPresented(keep: number): void {
    const ordered = [...this.presented.entries()]
      .sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0]));
    for (const [ref] of ordered.slice(keep)) this.presented.delete(ref);
  }
}

function runtimeStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    inputs: [],
    turns: [],
    effects: [],
    deliveries: [],
    activities: [],
    threadMaintenance: [],
    cognitiveOrganWork: [],
    integrityWarnings: [],
    ...overrides,
  };
}

function blockedWork(overrides: Partial<RuntimeCognitiveOrganWorkStatus> = {}): RuntimeCognitiveOrganWorkStatus {
  return {
    workId: "thread-maintainer-12",
    organ: "thread-maintainer",
    domainRef: "activity:741b2ac7-8473-4b8e-923d-1d79cde4aa59",
    status: "blocked",
    attemptCount: 3,
    createdAt: "2026-08-11T09:40:28.288Z",
    lastFailureCategory: "turn_limit",
    lastFailureAt: "2026-08-11T09:55:00.000Z",
    ...overrides,
  };
}

test("capture projects a blocked organ work as a narrow condition", async () => {
  const store = new MemoryStore();
  const source = createHarnessConditionSource({
    runtimeStatus: () => runtimeStatus({ cognitiveOrganWork: [blockedWork()] }),
    channelStatuses: () => ({}),
    store,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
  });
  const evidence = await source.capture();
  assert.ok(evidence);
  assert.equal(evidence.conditions.length, 1);
  const condition = evidence.conditions[0]!;
  assert.equal(condition.ref, "organ-blocked:thread-maintainer:activity:741b2ac7-8473-4b8e-923d-1d79cde4aa59:turn_limit");
  assert.equal(condition.capability, "Thread maintenance");
  assert.equal(condition.impact, "blocked after retries exhausted");
  assert.equal(condition.impact, "blocked after retries exhausted");
  assert.equal(condition.since, "2026-08-11T09:55:00.000Z");
  assert.deepEqual(JSON.parse(evidence.revision), [condition.ref]);
});

test("capture projects permanent channel ingress failure as a condition", async () => {
  const store = new MemoryStore();
  const source = createHarnessConditionSource({
    runtimeStatus: () => runtimeStatus(),
    channelStatuses: () => ({
      raft: {
        state: "connected",
        ingress: { pending: 0, retrying: 0, failed: 3, spooled: 0, oldestOutstandingAt: "2026-08-11T08:00:00.000Z", lastFailureCategory: "invalid_message", failedItemIds: ["wake-1", "wake-2"] },
      },
    }),
    store,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
  });
  const evidence = await source.capture();
  assert.ok(evidence);
  assert.equal(evidence.conditions[0]!.ref, "channel-ingress-failed:raft:invalid_message");
  assert.doesNotMatch(evidence.conditions[0]!.ref, /wake-/);
  assert.equal(evidence.conditions[0]!.since, undefined);
  assert.equal(evidence.conditions[0]!.lastFailureAt, undefined);
  assert.match(evidence.conditions[0]!.impact, /3 inbound item\(s\) permanently failed/);
});

test("retrying and non-blocked work are excluded", async () => {
  const store = new MemoryStore();
  const source = createHarnessConditionSource({
    runtimeStatus: () => runtimeStatus({
      cognitiveOrganWork: [
        blockedWork(),
        blockedWork({
          workId: "life-recorder-4",
          organ: "life-recorder",
          domainRef: "activity:other-1111",
          status: "retry_wait",
          lastFailureCategory: "provider",
        }),
      ],
    }),
    channelStatuses: () => ({
      raft: {
        state: "connected",
        ingress: { pending: 0, retrying: 2, failed: 0, spooled: 0 },
      },
    }),
    store,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
  });
  const evidence = await source.capture();
  assert.ok(evidence);
  assert.equal(evidence.conditions.length, 1);
  assert.equal(evidence.conditions[0]!.ref, "organ-blocked:thread-maintainer:activity:741b2ac7-8473-4b8e-923d-1d79cde4aa59:turn_limit");
});

test("already presented refs are not captured again until marked", async () => {
  const store = new MemoryStore();
  const source = createHarnessConditionSource({
    runtimeStatus: () => runtimeStatus({ cognitiveOrganWork: [blockedWork()] }),
    channelStatuses: () => ({}),
    store,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
  });
  const first = await source.capture();
  assert.ok(first);
  await source.markPresented(first.revision);
  assert.equal(await source.capture(), undefined);
});

test("a new ref is captured after a different ref was presented", async () => {
  const store = new MemoryStore();
  let organ: "thread-maintainer" | "memory-reflector" = "thread-maintainer";
  const source = createHarnessConditionSource({
    runtimeStatus: () => runtimeStatus({
      cognitiveOrganWork: [blockedWork({ organ, domainRef: `activity:${organ}-activity` })],
    }),
    channelStatuses: () => ({}),
    store,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
  });
  const first = await source.capture();
  assert.ok(first);
  await source.markPresented(first.revision);
  organ = "memory-reflector";
  const second = await source.capture();
  assert.ok(second);
  assert.match(second.conditions[0]!.ref, /^organ-blocked:memory-reflector:/);
});

test("the same organ blocked again for a different cause is presentable once more", async () => {
  const store = new MemoryStore();
  let failureCategory = "turn_limit";
  const source = createHarnessConditionSource({
    runtimeStatus: () => runtimeStatus({
      cognitiveOrganWork: [blockedWork({ lastFailureCategory: failureCategory, lastFailureAt: "2026-08-11T09:55:00.000Z" })],
    }),
    channelStatuses: () => ({}),
    store,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
  });
  const first = await source.capture();
  assert.ok(first);
  assert.match(first.revision, /turn_limit"\]$/);
  await source.markPresented(first.revision);
  failureCategory = "provider";
  const second = await source.capture();
  assert.ok(second);
  assert.match(second.conditions[0]!.ref, /:provider$/);
});

test("a channel failing again for a different cause is presentable once more", async () => {
  const store = new MemoryStore();
  let category: "invalid_message" | "remote_unavailable" = "invalid_message";
  const source = createHarnessConditionSource({
    runtimeStatus: () => runtimeStatus(),
    channelStatuses: () => ({
      raft: {
        state: "connected",
        ingress: { pending: 0, retrying: 0, failed: 1, spooled: 0, lastFailureCategory: category, failedItemIds: ["wake-1"] },
      },
    }),
    store,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
  });
  const first = await source.capture();
  assert.ok(first);
  await source.markPresented(first.revision);
  category = "remote_unavailable";
  const second = await source.capture();
  assert.ok(second);
  assert.equal(second.conditions[0]!.ref, "channel-ingress-failed:raft:remote_unavailable");
});

test("a later batch of the same cause on the same channel is presentable once more", async () => {
  const store = new MemoryStore();
  let failedItemIds = ["wake-1", "wake-2"];
  const source = createHarnessConditionSource({
    runtimeStatus: () => runtimeStatus(),
    channelStatuses: () => ({
      raft: {
        state: "connected",
        ingress: { pending: 0, retrying: 0, failed: failedItemIds.length, spooled: 0, lastFailureCategory: "invalid_message", failedItemIds },
      },
    }),
    store,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
  });
  const first = await source.capture();
  assert.ok(first);
  assert.deepEqual(JSON.parse(first.revision), ["channel-ingress-failed:raft:invalid_message", "channel-item:raft:invalid_message:wake-1", "channel-item:raft:invalid_message:wake-2"]);
  await source.markPresented(first.revision);
  failedItemIds = ["wake-3", "wake-4"];
  const second = await source.capture();
  assert.ok(second);
  // Aggregated ref stays stable; a new failed item under the same cause
  // presents it once more, with the item token only in the revision.
  assert.equal(second.conditions[0]!.ref, "channel-ingress-failed:raft:invalid_message");
  assert.deepEqual(JSON.parse(second.revision), ["channel-ingress-failed:raft:invalid_message", "channel-item:raft:invalid_message:wake-3", "channel-item:raft:invalid_message:wake-4"]);
  assert.doesNotMatch(second.revision, /wake-1/);
});

test("partial clearing of a presented batch does not re-present the remainder", async () => {
  const store = new MemoryStore();
  let failedItemIds = ["wake-1", "wake-2"];
  const source = createHarnessConditionSource({
    runtimeStatus: () => runtimeStatus(),
    channelStatuses: () => ({
      raft: {
        state: "connected",
        ingress: { pending: 0, retrying: 0, failed: failedItemIds.length, spooled: 0, lastFailureCategory: "invalid_message", failedItemIds },
      },
    }),
    store,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
  });
  const first = await source.capture();
  assert.ok(first);
  await source.markPresented(first.revision);
  failedItemIds = ["wake-2"];
  assert.equal(await source.capture(), undefined);
});


test("unknown organ failure categories fold to unknown in ref and impact", async () => {
  const store = new MemoryStore();
  const source = createHarnessConditionSource({
    runtimeStatus: () => runtimeStatus({
      cognitiveOrganWork: [blockedWork({ lastFailureCategory: "weird_custom_cause", lastFailureAt: "2026-08-11T09:55:00.000Z" })],
    }),
    channelStatuses: () => ({}),
    store,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
  });
  const evidence = await source.capture();
  assert.ok(evidence);
  assert.match(evidence.conditions[0]!.ref, /:unknown$/);
  assert.equal(evidence.conditions[0]!.impact, "blocked after retries exhausted");
  assert.doesNotMatch(evidence.conditions[0]!.ref, /weird_custom_cause/);
});

test("capture returns undefined when nothing is active", async () => {
  const store = new MemoryStore();
  const source = createHarnessConditionSource({
    runtimeStatus: () => runtimeStatus(),
    channelStatuses: () => ({}),
    store,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
  });
  assert.equal(await source.capture(), undefined);
});

test("capture returns undefined when the only active refs are already presented", async () => {
  const store = new MemoryStore();
  store.markPresented(
    "organ-blocked:thread-maintainer:activity:741b2ac7-8473-4b8e-923d-1d79cde4aa59:turn_limit",
    new Date("2026-08-11T09:00:00.000Z"),
  );
  const source = createHarnessConditionSource({
    runtimeStatus: () => runtimeStatus({ cognitiveOrganWork: [blockedWork()] }),
    channelStatuses: () => ({}),
    store,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
  });
  assert.equal(await source.capture(), undefined);
});

test("item ids containing separators do not split the revision", async () => {
  const store = new MemoryStore();
  const source = createHarnessConditionSource({
    runtimeStatus: () => runtimeStatus(),
    channelStatuses: () => ({
      raft: {
        state: "connected",
        ingress: { pending: 0, retrying: 0, failed: 1, spooled: 0, lastFailureCategory: "invalid_message", failedItemIds: ["weird|id"] },
      },
    }),
    store,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
  });
  const evidence = await source.capture();
  assert.ok(evidence);
  assert.deepEqual(JSON.parse(evidence.revision), ["channel-ingress-failed:raft:invalid_message", "channel-item:raft:invalid_message:weird|id"]);
  await source.markPresented(evidence.revision);
  assert.equal(await source.capture(), undefined);
});

test("prototype properties are not treated as known causes", async () => {
  const store = new MemoryStore();
  const source = createHarnessConditionSource({
    runtimeStatus: () => runtimeStatus({
      cognitiveOrganWork: [blockedWork({ lastFailureCategory: "constructor", lastFailureAt: "2026-08-11T09:55:00.000Z" })],
    }),
    channelStatuses: () => ({}),
    store,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
  });
  const evidence = await source.capture();
  assert.ok(evidence);
  assert.match(evidence.conditions[0]!.ref, /:unknown$/);
});

test("item ids with surrounding whitespace are acknowledged verbatim", async () => {
  const store = new MemoryStore();
  const source = createHarnessConditionSource({
    runtimeStatus: () => runtimeStatus(),
    channelStatuses: () => ({
      raft: {
        state: "connected",
        ingress: { pending: 0, retrying: 0, failed: 1, spooled: 0, lastFailureCategory: "invalid_message", failedItemIds: ["opaque|id "] },
      },
    }),
    store,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
  });
  const first = await source.capture();
  assert.ok(first);
  assert.deepEqual(JSON.parse(first.revision), [
    "channel-ingress-failed:raft:invalid_message",
    "channel-item:raft:invalid_message:opaque|id ",
  ]);
  await source.markPresented(first.revision);
  assert.equal(await source.capture(), undefined);
});

test("channel condition carries provable first and last failure times", async () => {
  const store = new MemoryStore();
  const source = createHarnessConditionSource({
    runtimeStatus: () => runtimeStatus(),
    channelStatuses: () => ({
      raft: {
        state: "connected",
        ingress: {
          pending: 0, retrying: 0, failed: 2, spooled: 0,
          lastFailureCategory: "invalid_message",
          failedItemIds: ["wake-1", "wake-2"],
          firstFailureAt: "2026-08-11T08:30:00.000Z",
          lastFailureAt: "2026-08-11T09:15:00.000Z",
        },
      },
    }),
    store,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
  });
  const evidence = await source.capture();
  assert.ok(evidence);
  // Earliest failure maps to the existing since slot; the most recent failure
  // is carried separately so the model sees both.
  assert.equal(evidence.conditions[0]!.since, "2026-08-11T08:30:00.000Z");
  assert.equal(evidence.conditions[0]!.lastFailureAt, "2026-08-11T09:15:00.000Z");
});
