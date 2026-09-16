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
  transientBackoffMs: 10 * 60_000,
  transientWindowMs: 2 * 60 * 60_000,
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
  /** Park after one transient provider failure inside its episode window. */
  readonly transientBackoffMs: number;
  /** Wall-clock length of a transient episode before it escalates to a human. */
  readonly transientWindowMs: number;
}

/** Budget fields carried by an organ domain row. */
export interface OrganBudgetFields {
  attempts: number;
  nextEligibleAt: string | null;
  lastError: string | null;
  needsHuman: boolean;
  /**
   * Start of the current transient episode, if the row is riding one out.
   * Decoupled from attempts so transient and real failures never pollute
   * each other's thresholds; cleared by any success, real failure, or quota
   * outcome, and by the human approve path.
   */
  transientSince: string | null;
}

/** How a failed run should be classified by the caller. */
export type OrganFailureClass = "failure" | "quota" | "transient";

const QUOTA_ERROR_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|usage limit reached|insufficient_quota|quota exceeded|billing/i;

// Transient provider distress: rate limits, overloaded or temporarily
// unavailable upstreams, and gateway/timeout wording. The status code only
// counts at the start of the string or after an "http" prefix — a bare
// number elsewhere is as likely a UUID fragment as a status.
const TRANSIENT_STATUS_PATTERN = /(^|\bhttp\s+)(429|500|502|503|504)\b/i;
const TRANSIENT_TYPE_PATTERN =
  /"(type|code)"\s*:\s*"[^"]*(rate_limit|rate_limited|overloaded|server_error|temporarily_unavailable|timeout)[^"]*"/i;
const TRANSIENT_WORDING_PATTERN =
  /temporarily unavailable|try again|rate[\s_-]*limit|overloaded|service unavailable|bad gateway|gateway timeout|temporarily overloaded|timeout|timed\s*out/i;

/**
 * Quota exhaustion (provider usage limits) is an environment fact, not an
 * organ fault: it parks the row instead of consuming the attempt budget.
 * Transient provider distress is likewise not an organ fault, but unlike
 * quota it is expected to clear on its own: it parks briefly without
 * consuming attempts, and only a wall-clock window of continuous transient
 * failure escalates. Anything else is a real failure.
 */
export function organFailureClass(error: unknown): OrganFailureClass {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (QUOTA_ERROR_PATTERN.test(message)) return "quota";
  if (
    TRANSIENT_STATUS_PATTERN.test(message)
    || TRANSIENT_TYPE_PATTERN.test(message)
    || TRANSIENT_WORDING_PATTERN.test(message)
  ) {
    return "transient";
  }
  return "failure";
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
    transientSince: null,
  };
}

/**
 * Budget fields after a failed run. `quota` parks the row until the provider
 * reset time (or the default park) without consuming the attempt budget:
 * quota exhaustion is an environment fact, not an organ fault. `transient`
 * likewise consumes no attempts: the row parks briefly and retries, and only
 * a wall-clock window of continuous transient failure escalates to a human.
 * A real failure after transients still counts from the preserved attempts,
 * and any non-transient outcome ends the episode. While needs_human is set,
 * every failure stays in cooldown and merely moves the next eligible time —
 * the mechanical retry is bounded by the cadence, not by human attention.
 */
export function failureBudget(
  now: Date,
  previous: Pick<OrganBudgetFields, "attempts" | "needsHuman"> & { transientSince?: string | null },
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
      transientSince: null,
    };
  }
  if (previous.needsHuman) {
    return {
      attempts: previous.attempts,
      nextEligibleAt: after(now, policy.cooldownMs),
      lastError: failure.error,
      needsHuman: true,
      transientSince: previous.transientSince ?? null,
    };
  }
  if (failure.class === "transient") {
    return transientBudget(now, previous, failure, policy);
  }
  const attempts = previous.attempts + 1;
  if (attempts >= policy.maxAttempts) {
    return {
      attempts,
      nextEligibleAt: after(now, policy.cooldownMs),
      lastError: failure.error,
      needsHuman: true,
      transientSince: null,
    };
  }
  return {
    attempts,
    nextEligibleAt: after(now, backoffMs(policy, attempts)),
    lastError: failure.error,
    needsHuman: false,
    transientSince: null,
  };
}

/**
 * Budget fields after a transient provider failure inside its episode
 * window. Attempts are untouched; the episode start rides along so the next
 * transient can tell a fresh blip from a window-long outage. A provider
 * reset moment in the error shortens or extends the park to match it.
 */
function transientBudget(
  now: Date,
  previous: { attempts: number; transientSince?: string | null },
  failure: { error: string; quotaResetAt?: string | null },
  policy: OrganBudgetPolicy,
): OrganBudgetFields {
  const sinceMs = Date.parse(previous.transientSince ?? "");
  const since = Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : now.toISOString();
  if (now.getTime() - Date.parse(since) >= policy.transientWindowMs) {
    return {
      attempts: previous.attempts,
      nextEligibleAt: after(now, policy.cooldownMs),
      lastError: failure.error,
      needsHuman: true,
      transientSince: since,
    };
  }
  const resetMs = failure.quotaResetAt
    ? Date.parse(failure.quotaResetAt) - now.getTime()
    : Number.NaN;
  const parkMs = Number.isFinite(resetMs) && resetMs > 0 ? resetMs : policy.transientBackoffMs;
  return {
    attempts: previous.attempts,
    nextEligibleAt: after(now, parkMs),
    lastError: failure.error,
    needsHuman: false,
    transientSince: since,
  };
}

function backoffMs(policy: OrganBudgetPolicy, attempts: number): number {
  const backoff = policy.retryBackoffMs;
  return backoff[Math.min(Math.max(0, attempts - 1), backoff.length - 1)]!;
}

function after(from: Date, ms: number): string {
  return new Date(from.getTime() + ms).toISOString();
}
