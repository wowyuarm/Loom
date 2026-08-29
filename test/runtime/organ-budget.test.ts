import assert from "node:assert/strict";
import test from "node:test";

import {
  failureBudget,
  ORGAN_BUDGET_POLICY,
  successBudget,
  type OrganBudgetFields,
} from "../../src/runtime/organ-budget.js";

const now = new Date("2026-08-29T00:00:00.000Z");
const fresh: Pick<OrganBudgetFields, "attempts" | "needsHuman"> = { attempts: 0, needsHuman: false };

test("success clears the budget and applies the next cadence", () => {
  const fields = successBudget(now, { cadenceMs: 30 * 60_000 });
  assert.deepEqual(fields, {
    attempts: 0,
    nextEligibleAt: "2026-08-29T00:30:00.000Z",
    lastError: null,
    needsHuman: false,
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
});
