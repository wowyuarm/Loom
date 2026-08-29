// Shared retry budget for Cognitive Organ domain rows.
//
// Domain facts are the only durable queue. This module only computes the
// budget fields a caller writes back to one domain row after a run; it holds
// no state and performs no I/O. There is no execution ledger and no persisted
// "running": an aborted or crashed run writes nothing — the row simply stays
// as it was, and the work becomes due again by its own fields.

export const ORGAN_BUDGET_POLICY: OrganBudgetPolicy = Object.freeze({
  maxAttempts: 3,
  retryBackoffMs: [60_000, 5 * 60_000],
  cooldownMs: 24 * 60 * 60_000,
  defaultQuotaParkMs: 6 * 60 * 60_000,
});

export interface OrganBudgetPolicy {
  /** Real organ-level failures allowed before the row needs a human. */
  readonly maxAttempts: number;
  /** Backoff after the Nth real failure; index 0 = first failure. */
  readonly retryBackoffMs: readonly number[];
  /** Cooldown retry cadence while needs_human is set. */
  readonly cooldownMs: number;
  /** Quota park duration when the provider reset time cannot be parsed. */
  readonly defaultQuotaParkMs: number;
}

/** Budget fields carried by an organ domain row. */
export interface OrganBudgetFields {
  attempts: number;
  nextEligibleAt: string | null;
  lastError: string | null;
  needsHuman: boolean;
}

/** How a failed run should be classified by the caller. */
export type OrganFailureClass = "failure" | "quota";

const QUOTA_ERROR_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|usage limit reached|insufficient_quota|quota exceeded|billing/i;

/**
 * Quota exhaustion (provider usage limits) is an environment fact, not an
 * organ fault: it parks the row instead of consuming the attempt budget.
 */
export function organFailureClass(error: unknown): OrganFailureClass {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return QUOTA_ERROR_PATTERN.test(message) ? "quota" : "failure";
}

/** Extract a provider quota reset timestamp from an error, when one exists. */
export function quotaResetAt(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))/.exec(message);
  if (!match) return null;
  const parsed = Date.parse(match[1]!);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function successBudget(
  now: Date,
  options: { policy?: OrganBudgetPolicy; cadenceMs?: number } = {},
): OrganBudgetFields {
  const cadenceMs = options.cadenceMs;
  return {
    attempts: 0,
    nextEligibleAt: cadenceMs && cadenceMs > 0 ? after(now, cadenceMs) : null,
    lastError: null,
    needsHuman: false,
  };
}

/**
 * Budget fields after a failed run. `quota` parks the row until the provider
 * reset time (or the default park) without consuming the attempt budget:
 * quota exhaustion is an environment fact, not an organ fault. While
 * needs_human is set, every real failure stays in cooldown and merely moves
 * the next eligible time — the mechanical retry is bounded by the cadence,
 * not by human attention.
 */
export function failureBudget(
  now: Date,
  previous: Pick<OrganBudgetFields, "attempts" | "needsHuman">,
  failure: { class: OrganFailureClass; error: string; quotaResetAt?: string | null },
  options: { policy?: OrganBudgetPolicy } = {},
): OrganBudgetFields {
  const policy = options.policy ?? ORGAN_BUDGET_POLICY;
  if (failure.class === "quota") {
    const resetMs = failure.quotaResetAt
      ? Date.parse(failure.quotaResetAt) - now.getTime()
      : Number.NaN;
    const parkMs = Number.isFinite(resetMs) && resetMs > 0 ? resetMs : policy.defaultQuotaParkMs;
    return {
      attempts: previous.attempts,
      nextEligibleAt: after(now, parkMs),
      lastError: failure.error,
      needsHuman: previous.needsHuman,
    };
  }
  if (previous.needsHuman) {
    return {
      attempts: previous.attempts,
      nextEligibleAt: after(now, policy.cooldownMs),
      lastError: failure.error,
      needsHuman: true,
    };
  }
  const attempts = previous.attempts + 1;
  if (attempts >= policy.maxAttempts) {
    return {
      attempts,
      nextEligibleAt: after(now, policy.cooldownMs),
      lastError: failure.error,
      needsHuman: true,
    };
  }
  return {
    attempts,
    nextEligibleAt: after(now, backoffMs(policy, attempts)),
    lastError: failure.error,
    needsHuman: false,
  };
}

function backoffMs(policy: OrganBudgetPolicy, attempts: number): number {
  const backoff = policy.retryBackoffMs;
  return backoff[Math.min(Math.max(0, attempts - 1), backoff.length - 1)]!;
}

function after(from: Date, ms: number): string {
  return new Date(from.getTime() + ms).toISOString();
}
