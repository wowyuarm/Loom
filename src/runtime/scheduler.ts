import type { AdvanceResult, Runtime } from "./types.js";

export const DEFAULT_ACTIVITY_IDLE_MS = 30 * 60 * 1_000;

export interface SchedulerOptions {
  runtime: Runtime;
  activityIdleMs?: number;
}

export type SchedulerRunResult =
  | { disposition: "idle" }
  | { disposition: "waiting"; nextRunAt: string }
  | { disposition: "busy" }
  | {
      disposition: "deferred";
      reason:
        | "activity_recording_failed"
        | "delivery_not_sent"
        | "delivery_requires_reconciliation";
    };

export interface Scheduler {
  runOnce(observedAt: Date): Promise<SchedulerRunResult>;
}

class RuntimeScheduler implements Scheduler {
  readonly #runtime: Runtime;
  readonly #activityIdleMs: number;

  constructor(options: SchedulerOptions) {
    const activityIdleMs = options.activityIdleMs ?? DEFAULT_ACTIVITY_IDLE_MS;
    if (!Number.isFinite(activityIdleMs) || activityIdleMs <= 0) {
      throw new Error("Scheduler activityIdleMs must be a positive finite number");
    }
    this.#runtime = options.runtime;
    this.#activityIdleMs = activityIdleMs;
  }

  async runOnce(observedAt: Date): Promise<SchedulerRunResult> {
    if (!Number.isFinite(observedAt.getTime())) throw new Error("Scheduler requires a valid observedAt");

    while (true) {
      const advanced = await this.#runtime.advance();
      const terminal = deferredResult(advanced);
      if (terminal) return terminal;
      if (advanced.disposition === "busy") return { disposition: "busy" };
      if (advanced.disposition !== "idle") continue;

      const active = this.#runtime.status().activeSegment;
      if (!active) return { disposition: "idle" };
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

function deferredResult(result: AdvanceResult): SchedulerRunResult | undefined {
  switch (result.disposition) {
    case "activity_recording_failed":
    case "delivery_not_sent":
    case "delivery_requires_reconciliation":
      return { disposition: "deferred", reason: result.disposition };
    default:
      return undefined;
  }
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  return new RuntimeScheduler(options);
}
