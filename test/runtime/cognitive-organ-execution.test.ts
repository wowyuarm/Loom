import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CognitiveOrganExecution } from "../../src/runtime/cognitive-organ-execution.js";

const SOFT = 10 * 60_000;
const BACKOFF_1 = 60_000;
const BACKOFF_2 = 5 * 60_000;
const TOTAL = 45 * 60_000;

function openLedger(now: () => Date): { ledger: CognitiveOrganExecution; db: DatabaseSync } {
  const dir = mkdtempSync(path.join(tmpdir(), "cog-organ-test-"));
  const db = new DatabaseSync(path.join(dir, "runtime.db"));
  let seq = 0;
  const ledger = new CognitiveOrganExecution({
    database: db,
    now,
    nextId: () => `id-${++seq}`,
  });
  return { ledger, db };
}

test("begin creates running work with first attempt and fixed deadlines", () => {
  let now = new Date("2026-08-07T10:00:00.000Z");
  const { ledger } = openLedger(() => now);
  const { work, attempt } = ledger.begin("life-recorder", "activity:abc", "rev-1");

  assert.equal(work.status, "running");
  assert.equal(work.attemptCount, 1);
  assert.equal(work.totalDeadlineAt, "2026-08-07T10:45:00.000Z");
  assert.equal(attempt.status, "running");
  assert.equal(attempt.attemptNumber, 1);
  assert.equal(attempt.modelRevision, "rev-1");
  assert.equal(attempt.softDeadlineAt, "2026-08-07T10:10:00.000Z");
  assert.equal(ledger.attempts(work.id).length, 1);
});

test("complete attempt records refs and completes the work", () => {
  let now = new Date("2026-08-07T10:00:00.000Z");
  const { ledger } = openLedger(() => now);
  const { work, attempt } = ledger.begin("attention-maintainer", "place:p", "rev-1");

  ledger.completeAttempt(work.id, {
    transcriptRef: "transcripts/main/2026-08-07/agent.jsonl:run-1",
    resultRef: "attention.md",
  });

  const done = ledger.work(work.id)!;
  assert.equal(done.status, "completed");
  const attemptDone = ledger.attempts(work.id)[0]!;
  assert.equal(attemptDone.status, "completed");
  assert.equal(attemptDone.transcriptRef, "transcripts/main/2026-08-07/agent.jsonl:run-1");
  assert.equal(attemptDone.resultRef, "attention.md");
  assert.equal(attemptDone.endedAt, "2026-08-07T10:00:00.000Z");
  assert.equal(ledger.work(work.id)!.id, work.id);
  assert.equal(attempt.id, attempt.id);
});

test("first failure backs off 1 minute, second failure backs off 5 minutes", () => {
  let now = new Date("2026-08-07T10:00:00.000Z");
  const { ledger } = openLedger(() => now);
  const { work } = ledger.begin("memory-reflector", "day:2026-08-07", "rev-1");

  const first = ledger.failAttempt(work.id, { failureCategory: "provider", error: "429" })!;
  assert.equal(first.workStatus, "retry_wait");
  assert.equal(first.reason, "backoff");
  assert.equal(first.nextAttemptAt, "2026-08-07T10:01:00.000Z");
  assert.equal(ledger.work(work.id)!.status, "retry_wait");
  assert.equal(ledger.work(work.id)!.lastFailureCategory, "provider");

  now = new Date("2026-08-07T10:01:00.000Z");
  const attempt2 = ledger.beginNextAttempt(work.id, "rev-2")!;
  assert.equal(attempt2.attemptNumber, 2);
  assert.equal(attempt2.modelRevision, "rev-2");
  assert.equal(ledger.work(work.id)!.status, "running");

  const second = ledger.failAttempt(work.id, { failureCategory: "provider" })!;
  assert.equal(second.nextAttemptAt, "2026-08-07T10:06:00.000Z");

  now = new Date("2026-08-07T10:06:00.000Z");
  const attempt3 = ledger.beginNextAttempt(work.id, "rev-3")!;
  assert.equal(attempt3.attemptNumber, 3);
  const third = ledger.failAttempt(work.id, { failureCategory: "provider" })!;
  assert.equal(third.workStatus, "blocked");
  assert.equal(third.reason, "attempts_exhausted");
  assert.equal(ledger.work(work.id)!.status, "blocked");
  assert.deepEqual(ledger.attempts(work.id).map(a => a.status), ["failed", "failed", "failed"]);
});

test("total deadline is fixed at begin and blocks late retries", () => {
  let now = new Date("2026-08-07T10:00:00.000Z");
  const { ledger } = openLedger(() => now);
  const { work } = ledger.begin("orientation", "pulse:1", "rev-1");

  // After one failure the backoff is 1 minute; advance past the total deadline (never reset by queueing).
  const first = ledger.failAttempt(work.id, { failureCategory: "provider" })!;
  assert.equal(first.nextAttemptAt, "2026-08-07T10:01:00.000Z");

  now = new Date("2026-08-07T10:50:00.000Z"); // past the 10:45 total deadline
  const attempt = ledger.beginNextAttempt(work.id, "rev-2");
  assert.equal(attempt, undefined);
  assert.equal(ledger.work(work.id)!.status, "blocked");
  assert.equal(ledger.work(work.id)!.lastFailureCategory, "provider");
});

test("failure exactly at total deadline is blocked with reason total_deadline", () => {
  let now = new Date("2026-08-07T10:00:00.000Z");
  const { ledger } = openLedger(() => now);
  const { work } = ledger.begin("thread-maintainer", "thread:t", "rev-1");

  now = new Date("2026-08-07T10:45:00.000Z");
  const decision = ledger.failAttempt(work.id, { failureCategory: "provider" })!;
  assert.equal(decision.workStatus, "blocked");
  assert.equal(decision.reason, "total_deadline");
});

test("cancel marks the attempt, work stays in grace window until released", () => {
  let now = new Date("2026-08-07T10:00:00.000Z");
  const { ledger } = openLedger(() => now);
  const { work } = ledger.begin("life-recorder", "activity:abc", "rev-1");

  ledger.cancel(work.id, "new_human_input");
  // Attempt is cancelled; work stays running (grace window awaiting organ release).
  assert.equal(ledger.attempts(work.id)[0]!.status, "cancelled");
  assert.equal(ledger.attempts(work.id)[0]!.cancelReason, "new_human_input");
  assert.equal(ledger.work(work.id)!.status, "running");
  assert.equal(ledger.work(work.id)!.lastCancelReason, "new_human_input");

  // Organ releases within grace → finishCancelled terminates as cancelled.
  ledger.finishCancelled(work.id);
  assert.equal(ledger.work(work.id)!.status, "cancelled");
  // beginNextAttempt has no effect after cancel (work is not retry_wait).
  now = new Date("2026-08-07T10:10:00.000Z");
  assert.equal(ledger.beginNextAttempt(work.id, "rev-2"), undefined);
});

test("complete after cancel is a no-op (race safety)", () => {
  let now = new Date("2026-08-07T10:00:00.000Z");
  const { ledger } = openLedger(() => now);
  const { work } = ledger.begin("memory-reflector", "day:2026-08-07", "rev-1");

  ledger.cancel(work.id, "new_human_input");
  // Organ "completes" within grace — the result is dropped (attempt already cancelled).
  ledger.completeAttempt(work.id, { resultRef: "memory.md" });
  assert.equal(ledger.attempts(work.id)[0]!.status, "cancelled");
  assert.equal(ledger.work(work.id)!.status, "running");
  ledger.finishCancelled(work.id);
  assert.equal(ledger.work(work.id)!.status, "cancelled");
});

test("intervention_required persists when cancel grace expires", () => {
  let now = new Date("2026-08-07T10:00:00.000Z");
  const { ledger } = openLedger(() => now);
  const { work } = ledger.begin("attention-maintainer", "place:p", "rev-1");

  ledger.cancel(work.id, "new_human_input");
  ledger.markInterventionRequired(work.id, "cancel grace expired");
  const held = ledger.work(work.id)!;
  assert.equal(held.status, "intervention_required");
  assert.equal(held.lastCancelReason, "cancel grace expired");
  assert.equal(ledger.attempts(work.id)[0]!.status, "intervention_required");
});

test("late fail after cancel is a no-op and does not consume retry budget", () => {
  let now = new Date("2026-08-07T10:00:00.000Z");
  const { ledger } = openLedger(() => now);
  const { work } = ledger.begin("life-recorder", "activity:abc", "rev-1");

  ledger.cancel(work.id, "new_human_input");
  // Organ reports failure after cancel — a late failure must be a no-op: the work
  // stays in its grace window, no retry is scheduled, the attempt stays cancelled.
  const late = ledger.failAttempt(work.id, { failureCategory: "provider" });
  assert.equal(late, undefined);
  assert.equal(ledger.work(work.id)!.status, "running");
  assert.equal(ledger.work(work.id)!.nextAttemptAt, undefined);
  assert.equal(ledger.attempts(work.id)[0]!.status, "cancelled");

  // The grace window is closed by finishCancelled / markInterventionRequired.
  ledger.finishCancelled(work.id);
  assert.equal(ledger.work(work.id)!.status, "cancelled");
});

test("requeue rejects non-recoverable states and accepts blocked / intervention_required", () => {
  let now = new Date("2026-08-07T10:00:00.000Z");
  const { ledger } = openLedger(() => now);

  const running = ledger.begin("orientation", "pulse:1", "rev-1").work;
  assert.throws(() => ledger.requeue(running.id, "rev-2"), /in state running/);

  const waiting = ledger.begin("attention-maintainer", "place:p", "rev-1").work;
  ledger.failAttempt(waiting.id, { failureCategory: "provider" });
  assert.equal(ledger.work(waiting.id)!.status, "retry_wait");
  assert.throws(() => ledger.requeue(waiting.id, "rev-2"), /in state retry_wait/);

  const completed = ledger.begin("memory-reflector", "day:2026-08-07", "rev-1").work;
  ledger.completeAttempt(completed.id);
  assert.throws(() => ledger.requeue(completed.id, "rev-2"), /in state completed/);

  const cancelled = ledger.begin("thread-maintainer", "thread:t", "rev-1").work;
  ledger.cancel(cancelled.id, "new_human_input");
  ledger.finishCancelled(cancelled.id);
  assert.throws(() => ledger.requeue(cancelled.id, "rev-2"), /in state cancelled/);

  // blocked and intervention_required can be requeued.
  const blocked = ledger.begin("life-recorder", "activity:abc", "rev-1").work;
  ledger.failAttempt(blocked.id, { failureCategory: "provider" });
  now = new Date("2026-08-07T10:01:00.000Z");
  ledger.beginNextAttempt(blocked.id, "rev-2");
  ledger.failAttempt(blocked.id, { failureCategory: "provider" });
  now = new Date("2026-08-07T10:06:00.000Z");
  ledger.beginNextAttempt(blocked.id, "rev-3");
  ledger.failAttempt(blocked.id, { failureCategory: "provider" });
  assert.equal(ledger.work(blocked.id)!.status, "blocked");
  const successor = ledger.requeue(blocked.id, "rev-4");
  assert.equal(successor.work.requeuedFrom, blocked.id);

  const held = ledger.begin("attention-maintainer", "place:q", "rev-1").work;
  ledger.cancel(held.id, "new_human_input");
  ledger.markInterventionRequired(held.id, "cancel grace expired");
  const successor2 = ledger.requeue(held.id, "rev-2");
  assert.equal(successor2.work.requeuedFrom, held.id);
});

test("attempt terminal state is immutable to late calls", () => {
  let now = new Date("2026-08-07T10:00:00.000Z");
  const { ledger } = openLedger(() => now);
  const { work } = ledger.begin("orientation", "pulse:1", "rev-1");
  ledger.completeAttempt(work.id, { resultRef: "pulse.md" });

  const before = ledger.attempts(work.id)[0]!;
  assert.equal(before.status, "completed");
  assert.equal(before.endedAt, "2026-08-07T10:00:00.000Z");

  // All late calls against a terminal attempt are no-ops: status, ended_at, and refs are never overwritten.
  ledger.completeAttempt(work.id, { resultRef: "other.md" });
  ledger.failAttempt(work.id, { failureCategory: "provider" });
  ledger.cancel(work.id, "new_human_input");
  const after = ledger.attempts(work.id)[0]!;
  assert.equal(after.status, "completed");
  assert.equal(after.endedAt, "2026-08-07T10:00:00.000Z");
  assert.equal(after.resultRef, "pulse.md");
  assert.equal(after.cancelReason, undefined);
  assert.equal(ledger.work(work.id)!.status, "completed");
});

test("requeue creates successor budget cycle referencing the same domain object", () => {
  let now = new Date("2026-08-07T10:00:00.000Z");
  const { ledger } = openLedger(() => now);
  const { work } = ledger.begin("life-recorder", "activity:abc", "rev-1");
  ledger.failAttempt(work.id, { failureCategory: "provider" });
  now = new Date("2026-08-07T10:01:00.000Z");
  ledger.beginNextAttempt(work.id, "rev-2");
  ledger.failAttempt(work.id, { failureCategory: "provider" });
  now = new Date("2026-08-07T10:06:00.000Z");
  ledger.beginNextAttempt(work.id, "rev-3");
  ledger.failAttempt(work.id, { failureCategory: "provider" });
  assert.equal(ledger.work(work.id)!.status, "blocked");

  now = new Date("2026-08-07T11:00:00.000Z");
  const next = ledger.requeue(work.id, "rev-4");
  assert.notEqual(next.work.id, work.id);
  assert.equal(next.work.requeuedFrom, work.id);
  assert.equal(next.work.domainRef, "activity:abc");
  assert.equal(next.work.organ, "life-recorder");
  assert.equal(next.work.attemptCount, 1);
  assert.equal(next.work.totalDeadlineAt, "2026-08-07T11:45:00.000Z");
  assert.equal(next.attempt.attemptNumber, 1);
  assert.equal(next.attempt.modelRevision, "rev-4");
  // Old attempt history is preserved (append-only).
  assert.deepEqual(ledger.attempts(work.id).map(a => a.status), ["failed", "failed", "failed"]);
});

test("reconcile marks interrupted attempts and schedules retry or blocked", () => {
  let now = new Date("2026-08-07T10:00:00.000Z");
  const { ledger } = openLedger(() => now);
  const { work: w1 } = ledger.begin("orientation", "pulse:1", "rev-1");
  const { work: w2 } = ledger.begin("life-recorder", "activity:abc", "rev-1");
  ledger.failAttempt(w1.id, { failureCategory: "provider" });

  now = new Date("2026-08-07T10:10:00.000Z"); // after simulated restart
  ledger.reconcile(now);

  // w1 is already retry_wait and is untouched.
  assert.equal(ledger.work(w1.id)!.status, "retry_wait");
  // w2 left running → failed as interrupted → retry_wait (quota not exhausted).
  const w2After = ledger.work(w2.id)!;
  assert.equal(w2After.status, "retry_wait");
  assert.equal(w2After.nextAttemptAt, "2026-08-07T10:11:00.000Z");
  assert.equal(ledger.attempts(w2.id)[0]!.status, "failed");
  assert.equal(ledger.attempts(w2.id)[0]!.failureCategory, "interrupted");
});

test("reconcile blocks work whose attempts are exhausted", () => {
  let now = new Date("2026-08-07T10:00:00.000Z");
  const { ledger } = openLedger(() => now);
  const { work } = ledger.begin("memory-reflector", "day:2026-08-07", "rev-1");
  ledger.failAttempt(work.id, { failureCategory: "provider" });
  now = new Date("2026-08-07T10:01:00.000Z");
  ledger.beginNextAttempt(work.id, "rev-2");
  ledger.failAttempt(work.id, { failureCategory: "provider" });
  now = new Date("2026-08-07T10:06:00.000Z");
  ledger.beginNextAttempt(work.id, "rev-3");
  // attempt 3 left running (unfinished before restart) → quota exhausted → blocked.
  now = new Date("2026-08-07T10:20:00.000Z");
  ledger.reconcile(now);
  assert.equal(ledger.work(work.id)!.status, "blocked");
  assert.deepEqual(ledger.attempts(work.id).map(a => a.status), ["failed", "failed", "failed"]);
});

test("nextDue returns only due retry_wait works", () => {
  let now = new Date("2026-08-07T10:00:00.000Z");
  const { ledger } = openLedger(() => now);
  const { work: a } = ledger.begin("orientation", "pulse:1", "rev-1");
  const { work: b } = ledger.begin("attention-maintainer", "place:p", "rev-1");
  ledger.failAttempt(a.id, { failureCategory: "provider" });
  ledger.failAttempt(b.id, { failureCategory: "provider" });

  assert.deepEqual(ledger.nextDue(new Date("2026-08-07T10:00:59.999Z")), []);
  assert.deepEqual(ledger.nextDue(new Date("2026-08-07T10:01:00.000Z")), [a.id, b.id]);
});

test("independent works of different organs do not interfere (concurrency boundary)", () => {
  let now = new Date("2026-08-07T10:00:00.000Z");
  const { ledger } = openLedger(() => now);
  const { work: a } = ledger.begin("life-recorder", "activity:abc", "rev-1");
  const { work: b } = ledger.begin("attention-maintainer", "place:p", "rev-1");

  ledger.completeAttempt(a.id, { resultRef: "daily.md" });
  ledger.failAttempt(b.id, { failureCategory: "provider" });

  assert.equal(ledger.work(a.id)!.status, "completed");
  assert.equal(ledger.work(b.id)!.status, "retry_wait");
  assert.equal(ledger.attempts(b.id)[0]!.status, "failed");
});

test("attempt numbers are unique per work", () => {
  let now = new Date("2026-08-07T10:00:00.000Z");
  const { ledger } = openLedger(() => now);
  const { work } = ledger.begin("orientation", "pulse:1", "rev-1");
  ledger.failAttempt(work.id, { failureCategory: "provider" });
  now = new Date("2026-08-07T10:01:00.000Z");
  const attempt2 = ledger.beginNextAttempt(work.id, "rev-2")!;
  assert.equal(attempt2.attemptNumber, 2);
  assert.notEqual(attempt2.id, ledger.attempts(work.id)[0]!.id);
});

test("persisted ledger survives reopen (restart boundary)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cog-organ-reopen-"));
  const dbPath = path.join(dir, "runtime.db");
  let now = new Date("2026-08-07T10:00:00.000Z");
  let seq = 0;
  const db = new DatabaseSync(dbPath);
  const ledger = new CognitiveOrganExecution({
    database: db,
    now: () => now,
    nextId: () => `id-${++seq}`,
  });
  const { work } = ledger.begin("memory-reflector", "day:2026-08-07", "rev-1");
  ledger.failAttempt(work.id, { failureCategory: "provider" });
  const workId = work.id;
  db.close();

  // Reopen (simulated restart).
  now = new Date("2026-08-07T10:01:30.000Z");
  const db2 = new DatabaseSync(dbPath);
  const ledger2 = new CognitiveOrganExecution({ database: db2, now: () => now, nextId: () => `id-${++seq}` });
  assert.equal(ledger2.work(workId)!.status, "retry_wait");
  assert.equal(ledger2.work(workId)!.nextAttemptAt, "2026-08-07T10:01:00.000Z");
  const attempt2 = ledger2.beginNextAttempt(workId, "rev-2")!;
  assert.equal(attempt2.attemptNumber, 2);
  assert.equal(attempt2.modelRevision, "rev-2");
  db2.close();
  rmSync(dir, { recursive: true, force: true });
});
