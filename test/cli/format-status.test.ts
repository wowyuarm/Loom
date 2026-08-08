import assert from "node:assert/strict";
import test from "node:test";

import { formatStatus } from "../../src/cli.js";
import type { LoomStatusReport } from "../../src/host/index.js";

const base: Extract<LoomStatusReport, { runId: string }> = {
  schemaVersion: 1,
  observedAt: "2026-08-08T10:00:00.000Z",
  runId: "run-1",
  host: { state: "running", version: "0.0.0", startedAt: "2026-08-08T09:00:00.000Z" },
  model: { state: "active", revisionId: "rev-1", activatedAt: "2026-08-08T09:00:00.000Z" },
  runtime: {
    activeTurn: false,
    pendingInputs: 0,
    pendingEffects: 0,
    deliveriesNeedingAttention: 0,
    integrityWarnings: [],
  },
  agents: [],
  cognitiveOrganWork: [],
  channels: [],
  integrations: [],
};

test("formatStatus reports an overdue active Segment with its blocker and next check", () => {
  const report: LoomStatusReport = {
    ...base,
    runtime: {
      ...base.runtime,
      activityOverdueSince: "2026-08-08T09:00:00.000Z",
      activityOverdueReason: { kind: "main_agent_turn", turnId: "turn-1" },
      activityOverdueNextCheckAt: "2026-08-08T09:15:00.000Z",
    },
  };
  const text = formatStatus(report);
  assert.match(text, /Active Segment overdue since 2026-08-08T09:00:00\.000Z: main_agent_turn \(turn turn-1\)/);
  assert.match(text, /needs attention, next check 2026-08-08T09:15:00\.000Z/);
});

test("formatStatus shows pending Input and delivery blockers with identifiers", () => {
  const pendingReport: LoomStatusReport = {
    ...base,
    runtime: {
      ...base.runtime,
      activityOverdueSince: "2026-08-08T09:00:00.000Z",
      activityOverdueReason: { kind: "pending_input", inputId: "input-9" },
    },
  };
  assert.match(formatStatus(pendingReport), /pending_input \(input input-9\)/);

  const deliveryReport: LoomStatusReport = {
    ...base,
    runtime: {
      ...base.runtime,
      activityOverdueSince: "2026-08-08T09:00:00.000Z",
      activityOverdueReason: { kind: "delivery", attemptId: "attempt-3" },
    },
  };
  assert.match(formatStatus(deliveryReport), /delivery \(attempt attempt-3\)/);
});

test("formatStatus omits overdue fields when the Segment is not overdue", () => {
  const text = formatStatus(base);
  assert.doesNotMatch(text, /overdue/);
});
