import assert from "node:assert/strict";
import test from "node:test";

import {
  failureBudget,
  ORGAN_BUDGET_POLICY,
  organFailureClass,
  successBudget,
  type OrganBudgetFields,
} from "../../src/runtime/organ-budget.js";

const now = new Date("2026-08-29T00:00:00.000Z");
const fresh: Pick<OrganBudgetFields, "attempts" | "needsHuman"> = { attempts: 0, needsHuman: false };
// The 09-14 provider error, verbatim from the persisted run record.
const RATE_LIMIT_ERROR =
  '429: {"message":"Upstream model provider is temporarily unavailable. Please try again in a moment.","type":"rate_limit_error"}';

test("success clears the budget and applies the next cadence", () => {
  const fields = successBudget(now, { cadenceMs: 30 * 60_000 });
  assert.deepEqual(fields, {
    attempts: 0,
    nextEligibleAt: "2026-08-29T00:30:00.000Z",
    lastError: null,
    needsHuman: false,
    transientSince: null,
  });
});

test("success without a cadence is immediately due again", () => {
  const fields = successBudget(now);
  assert.equal(fields.nextEligibleAt, null);
  assert.equal(fields.needsHuman, false);
});

test("real failures back off 1 minute then 5 minutes", () => {
  const first = failureBudget(now, fresh, { class: "failure", error: "boom" });
  assert.equal(first.attempts, 1);
  assert.equal(first.needsHuman, false);
  assert.equal(first.nextEligibleAt, "2026-08-29T00:01:00.000Z");

  const second = failureBudget(now, first, { class: "failure", error: "boom" });
  assert.equal(second.attempts, 2);
  assert.equal(second.needsHuman, false);
  assert.equal(second.nextEligibleAt, "2026-08-29T00:05:00.000Z");
});

test("the third real failure needs a human and enters the 24h cooldown", () => {
  const second: Pick<OrganBudgetFields, "attempts" | "needsHuman"> = { attempts: 2, needsHuman: false };
  const third = failureBudget(now, second, { class: "failure", error: "boom" });
  assert.equal(third.attempts, 3);
  assert.equal(third.needsHuman, true);
  assert.equal(third.nextEligibleAt, "2026-08-30T00:00:00.000Z");
});

test("a cooldown failure stays needs_human and moves the next eligible time only", () => {
  const held: Pick<OrganBudgetFields, "attempts" | "needsHuman"> = { attempts: 3, needsHuman: true };
  const retried = failureBudget(now, held, { class: "failure", error: "still broken" });
  assert.equal(retried.attempts, 3);
  assert.equal(retried.needsHuman, true);
  assert.equal(retried.nextEligibleAt, "2026-08-30T00:00:00.000Z");
  assert.equal(retried.lastError, "still broken");
});

test("quota parks without consuming the attempt budget", () => {
  const parked = failureBudget(now, { attempts: 1, needsHuman: false }, {
    class: "quota",
    error: "usage limit",
    quotaResetAt: "2026-08-29T03:00:00.000Z",
  });
  assert.equal(parked.attempts, 1);
  assert.equal(parked.needsHuman, false);
  assert.equal(parked.nextEligibleAt, "2026-08-29T03:00:00.000Z");
});

test("quota parks for the default duration when no reset time exists", () => {
  const parked = failureBudget(now, fresh, { class: "quota", error: "usage limit" });
  assert.equal(parked.attempts, 0);
  assert.equal(parked.nextEligibleAt, "2026-08-29T06:00:00.000Z");
});

test("quota park never clears needs_human", () => {
  const held: Pick<OrganBudgetFields, "attempts" | "needsHuman"> = { attempts: 3, needsHuman: true };
  const parked = failureBudget(now, held, { class: "quota", error: "usage limit" });
  assert.equal(parked.needsHuman, true);
  assert.equal(parked.attempts, 3);
});

test("policy constants match the agreed contract", () => {
  assert.equal(ORGAN_BUDGET_POLICY.maxAttempts, 3);
  assert.deepEqual(ORGAN_BUDGET_POLICY.retryBackoffMs, [60_000, 5 * 60_000]);
  assert.equal(ORGAN_BUDGET_POLICY.cooldownMs, 24 * 60 * 60_000);
  assert.equal(ORGAN_BUDGET_POLICY.transientBackoffMs, 10 * 60_000);
  assert.equal(ORGAN_BUDGET_POLICY.transientWindowMs, 2 * 60 * 60_000);
});

test("classifies the 09-14 rate-limit string as transient", () => {
  assert.equal(organFailureClass(new Error(RATE_LIMIT_ERROR)), "transient");
});

test("quota wording still wins over a 429 status", () => {
  assert.equal(organFailureClass(new Error(
    "429 GoUsageLimitError: usage limit reached for https://opencode.ai/workspace/example/go",
  )), "quota");
});

test("ordinary errors stay real failures", () => {
  assert.equal(organFailureClass(new Error("grounding failed")), "failure");
  assert.equal(organFailureClass(new TypeError("schema mismatch")), "failure");
});

test("a 429 buried in an id is not a status code", () => {
  assert.equal(organFailureClass(new Error(
    "delivery 9f429c1e-d4a6-4898-8a79-271b275d380c ended without a receipt",
  )), "failure");
});

test("timeout wording counts as transient", () => {
  assert.equal(organFailureClass(new Error("ConnectTimeoutError: Connect Timeout Error")), "transient");
  assert.equal(organFailureClass(new Error("fetch failed: operation timed out after 15000ms")), "transient");
  assert.equal(organFailureClass(new Error("http 503 service unavailable")), "transient");
});

test("three transient failures inside the window never page and park briefly", () => {
  const first = failureBudget(new Date("2026-09-14T20:25:00.000Z"), fresh, {
    class: "transient",
    error: RATE_LIMIT_ERROR,
  });
  assert.equal(first.attempts, 0);
  assert.equal(first.needsHuman, false);
  assert.equal(first.nextEligibleAt, "2026-09-14T20:35:00.000Z");
  assert.equal(first.transientSince, "2026-09-14T20:25:00.000Z");

  const second = failureBudget(new Date("2026-09-14T20:26:00.000Z"), first, {
    class: "transient",
    error: RATE_LIMIT_ERROR,
  });
  assert.equal(second.attempts, 0);
  assert.equal(second.needsHuman, false);
  assert.equal(second.nextEligibleAt, "2026-09-14T20:36:00.000Z");
  assert.equal(second.transientSince, "2026-09-14T20:25:00.000Z");

  const third = failureBudget(new Date("2026-09-14T21:16:00.000Z"), second, {
    class: "transient",
    error: RATE_LIMIT_ERROR,
  });
  assert.equal(third.attempts, 0);
  assert.equal(third.needsHuman, false);
  assert.equal(third.nextEligibleAt, "2026-09-14T21:26:00.000Z");
  assert.equal(third.transientSince, "2026-09-14T20:25:00.000Z");
});

test("a transient episode past the wall-clock window escalates", () => {
  const streak = { attempts: 0, needsHuman: false, transientSince: "2026-09-14T20:25:00.000Z" };
  const late = failureBudget(new Date("2026-09-14T22:25:00.000Z"), streak, {
    class: "transient",
    error: RATE_LIMIT_ERROR,
  });
  assert.equal(late.attempts, 0);
  assert.equal(late.needsHuman, true);
  assert.equal(late.nextEligibleAt, "2026-09-15T22:25:00.000Z");
});

test("a real failure after transients counts from preserved attempts and ends the episode", () => {
  const transient = failureBudget(now, fresh, { class: "transient", error: RATE_LIMIT_ERROR });
  assert.equal(transient.transientSince, now.toISOString());
  const real = failureBudget(now, transient, { class: "failure", error: "boom" });
  assert.equal(real.attempts, 1);
  assert.equal(real.needsHuman, false);
  assert.equal(real.transientSince, null);
});

test("a transient with a provider reset moment parks until then", () => {
  const parked = failureBudget(now, fresh, {
    class: "transient",
    error: "upstream overloaded",
    quotaResetAt: "2026-08-29T00:07:00.000Z",
  });
  assert.equal(parked.attempts, 0);
  assert.equal(parked.needsHuman, false);
  assert.equal(parked.nextEligibleAt, "2026-08-29T00:07:00.000Z");
  assert.equal(parked.transientSince, now.toISOString());
});
