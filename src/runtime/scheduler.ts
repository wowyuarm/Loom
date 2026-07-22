import type { AdvanceResult, Runtime } from "./types.js";

export const DEFAULT_ACTIVITY_IDLE_MS = 30 * 60 * 1_000;
export const DEFAULT_PULSE_RETRY_MS = 5 * 60 * 1_000;

export interface SchedulerPulsePolicy {
  timeZone: string;
  intervalMs: number;
  quietHours: {
    start: string;
    end: string;
    intervalMs: number;
  };
  initialDelayMs?: number;
  retryDelayMs?: number;
}

export interface SchedulerOptions {
  runtime: Runtime;
  activityIdleMs?: number;
  admitAgentWork?: () => boolean | Promise<boolean>;
  proactivePulse?: SchedulerPulsePolicy;
}

export type SchedulerRunResult =
  | { disposition: "idle" }
  | { disposition: "waiting"; nextRunAt: string }
  | { disposition: "busy" }
  | {
      disposition: "deferred";
      reason:
        | "activity_recording_failed"
        | "agent_work_not_admitted"
        | "delivery_not_sent"
        | "delivery_requires_reconciliation";
    }
  | {
      disposition: "deferred";
      reason: "orientation_failed";
      nextRunAt: string;
      error: string;
    };

export interface Scheduler {
  runOnce(observedAt: Date): Promise<SchedulerRunResult>;
}

class RuntimeScheduler implements Scheduler {
  readonly #runtime: Runtime;
  readonly #activityIdleMs: number;
  readonly #admitAgentWork: () => boolean | Promise<boolean>;
  readonly #proactivePulse: SchedulerPulsePolicy | undefined;

  constructor(options: SchedulerOptions) {
    const activityIdleMs = options.activityIdleMs ?? DEFAULT_ACTIVITY_IDLE_MS;
    if (!Number.isFinite(activityIdleMs) || activityIdleMs <= 0) {
      throw new Error("Scheduler activityIdleMs must be a positive finite number");
    }
    this.#runtime = options.runtime;
    this.#activityIdleMs = activityIdleMs;
    this.#admitAgentWork = options.admitAgentWork ?? (() => true);
    this.#proactivePulse = options.proactivePulse;
    if (this.#proactivePulse) validatePulsePolicy(this.#proactivePulse);
  }

  async runOnce(observedAt: Date): Promise<SchedulerRunResult> {
    if (!Number.isFinite(observedAt.getTime())) throw new Error("Scheduler requires a valid observedAt");

    if (this.#proactivePulse) {
      await this.#runtime.runOpportunityPulse({
        observedAt,
        initialDelayMs: this.#proactivePulse.initialDelayMs ?? this.#proactivePulse.intervalMs,
        cadenceMs: pulseCadenceFor(observedAt, this.#proactivePulse),
        retryDelayMs: this.#proactivePulse.retryDelayMs ?? DEFAULT_PULSE_RETRY_MS,
        agentWork: "defer",
      });
    }

    while (true) {
      const agentWork = await this.#admitAgentWork() ? "allow" : "defer";
      const advanced = await this.#runtime.advance({ agentWork });
      const terminal = deferredResult(advanced);
      if (terminal) return terminal;
      if (advanced.disposition === "busy") return { disposition: "busy" };
      if (advanced.disposition !== "idle") continue;

      const active = this.#runtime.status().activeSegment;
      if (!active) {
        if (!this.#proactivePulse) return { disposition: "idle" };
        const pulse = await this.#runtime.runOpportunityPulse({
          observedAt,
          initialDelayMs: this.#proactivePulse.initialDelayMs ?? this.#proactivePulse.intervalMs,
          cadenceMs: pulseCadenceFor(observedAt, this.#proactivePulse),
          retryDelayMs: this.#proactivePulse.retryDelayMs ?? DEFAULT_PULSE_RETRY_MS,
          agentWork,
        });
        if (pulse.disposition === "accepted" || pulse.disposition === "stale") continue;
        if (pulse.disposition === "waiting" || pulse.disposition === "none") {
          return { disposition: "waiting", nextRunAt: pulse.nextRunAt };
        }
        if (pulse.disposition === "agent_work_deferred") {
          return { disposition: "deferred", reason: "agent_work_not_admitted" };
        }
        if (pulse.disposition === "failed") {
          return {
            disposition: "deferred",
            reason: "orientation_failed",
            nextRunAt: pulse.nextRunAt,
            error: pulse.error,
          };
        }
        return { disposition: "busy" };
      }
      const nextRunAt = new Date(
        new Date(active.lastActivityAt).getTime() + this.#activityIdleMs,
      );
      if (observedAt < nextRunAt) {
        return { disposition: "waiting", nextRunAt: nextRunAt.toISOString() };
      }

      const inactiveBefore = new Date(observedAt.getTime() - this.#activityIdleMs).toISOString();
      const closed = await this.#runtime.closeActivity({ inactiveBefore });
      if (closed.disposition === "busy") return { disposition: "busy" };
      if (closed.disposition === "not_due") {
        return {
          disposition: "waiting",
          nextRunAt: new Date(
            new Date(closed.lastActivityAt).getTime() + this.#activityIdleMs,
          ).toISOString(),
        };
      }
      if (closed.disposition === "no_activity") return { disposition: "idle" };
    }
  }
}

function validatePulsePolicy(policy: SchedulerPulsePolicy): void {
  assertPositiveDuration(policy.intervalMs, "intervalMs");
  assertPositiveDuration(policy.quietHours.intervalMs, "quietHours.intervalMs");
  if (policy.initialDelayMs !== undefined) assertPositiveDuration(policy.initialDelayMs, "initialDelayMs");
  if (policy.retryDelayMs !== undefined) assertPositiveDuration(policy.retryDelayMs, "retryDelayMs");
  parseClock(policy.quietHours.start, "quietHours.start");
  parseClock(policy.quietHours.end, "quietHours.end");
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: policy.timeZone }).format(new Date(0));
  } catch {
    throw new Error(`Scheduler proactivePulse timeZone is invalid: ${policy.timeZone}`);
  }
}

function pulseCadenceFor(observedAt: Date, policy: SchedulerPulsePolicy): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: policy.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(observedAt);
  const hour = Number(parts.find(part => part.type === "hour")?.value);
  const minute = Number(parts.find(part => part.type === "minute")?.value);
  const current = hour * 60 + minute;
  const start = parseClock(policy.quietHours.start, "quietHours.start");
  const end = parseClock(policy.quietHours.end, "quietHours.end");
  const quiet = start < end
    ? current >= start && current < end
    : current >= start || current < end;
  return quiet ? policy.quietHours.intervalMs : policy.intervalMs;
}

function parseClock(value: string, label: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`Scheduler proactivePulse ${label} must use 24-hour HH:MM format`);
  }
  const [hour, minute] = value.split(":").map(Number);
  return hour! * 60 + minute!;
}

function assertPositiveDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Scheduler proactivePulse ${label} must be a positive finite number`);
  }
}

function deferredResult(result: AdvanceResult): SchedulerRunResult | undefined {
  switch (result.disposition) {
    case "activity_recording_failed":
    case "delivery_not_sent":
    case "delivery_requires_reconciliation":
      return { disposition: "deferred", reason: result.disposition };
    case "agent_work_deferred":
      return { disposition: "deferred", reason: "agent_work_not_admitted" };
    default:
      return undefined;
  }
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  return new RuntimeScheduler(options);
}
