import type { AdvanceResult, Runtime, RuntimeStatus } from "./types.js";

export const DEFAULT_ACTIVITY_IDLE_MS = 30 * 60 * 1_000;
export const DEFAULT_ACTIVITY_MAX_MS = 2 * 60 * 60 * 1_000;
export const DEFAULT_PULSE_RETRY_MS = 5 * 60 * 1_000;
export const DEFAULT_MAINTENANCE_RETRY_MS = 15 * 60 * 1_000;

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
  activityMaxMs?: number;
  admitAgentWork?: () => boolean | Promise<boolean>;
  proactivePulse?: SchedulerPulsePolicy;
  attentionMaintenance?: {
    intervalMs: number;
    initialDelayMs?: number;
    retryDelayMs?: number;
  };
  memoryReflection?: {
    delayMs: number;
    retryDelayMs?: number;
  };
}

export type SchedulerRunResult =
  | { disposition: "idle" }
  | { disposition: "waiting"; nextRunAt: string }
  | { disposition: "busy" }
  | {
      disposition: "deferred";
      reason:
        | "activity_recording_failed"
        | "thread_maintenance_failed"
        | "attention_maintenance_failed"
        | "memory_reflection_failed"
        | "agent_work_not_admitted"
        | "delivery_not_sent"
        | "delivery_requires_reconciliation";
      nextRunAt?: string;
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
  readonly #activityMaxMs: number;
  readonly #admitAgentWork: () => boolean | Promise<boolean>;
  readonly #proactivePulse: SchedulerPulsePolicy | undefined;
  readonly #attentionMaintenance: SchedulerOptions["attentionMaintenance"];
  readonly #memoryReflection: SchedulerOptions["memoryReflection"];

  constructor(options: SchedulerOptions) {
    const activityIdleMs = options.activityIdleMs ?? DEFAULT_ACTIVITY_IDLE_MS;
    const activityMaxMs = options.activityMaxMs ?? DEFAULT_ACTIVITY_MAX_MS;
    if (!Number.isFinite(activityIdleMs) || activityIdleMs <= 0) {
      throw new Error("Scheduler activityIdleMs must be a positive finite number");
    }
    if (!Number.isFinite(activityMaxMs) || activityMaxMs <= 0) {
      throw new Error("Scheduler activityMaxMs must be a positive finite number");
    }
    this.#runtime = options.runtime;
    this.#activityIdleMs = activityIdleMs;
    this.#activityMaxMs = activityMaxMs;
    this.#admitAgentWork = options.admitAgentWork ?? (() => true);
    this.#proactivePulse = options.proactivePulse;
    this.#attentionMaintenance = options.attentionMaintenance;
    this.#memoryReflection = options.memoryReflection;
    if (this.#proactivePulse) validatePulsePolicy(this.#proactivePulse);
    if (this.#attentionMaintenance) {
      assertPositiveDuration(this.#attentionMaintenance.intervalMs, "attentionMaintenance.intervalMs");
    }
    if (this.#memoryReflection) {
      if (!Number.isFinite(this.#memoryReflection.delayMs) || this.#memoryReflection.delayMs < 0) {
        throw new Error("Scheduler memoryReflection.delayMs must be a non-negative finite number");
      }
    }
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
    if (this.#attentionMaintenance) {
      await this.#runtime.runAttentionMaintenance({
        observedAt,
        initialDelayMs: this.#attentionMaintenance.initialDelayMs ?? this.#attentionMaintenance.intervalMs,
        cadenceMs: this.#attentionMaintenance.intervalMs,
        retryDelayMs: this.#attentionMaintenance.retryDelayMs ?? DEFAULT_MAINTENANCE_RETRY_MS,
        agentWork: "defer",
      });
    }
    if (this.#memoryReflection) {
      await this.#runtime.runMemoryReflection({
        observedAt,
        delayMs: this.#memoryReflection.delayMs,
        retryDelayMs: this.#memoryReflection.retryDelayMs ?? DEFAULT_MAINTENANCE_RETRY_MS,
        agentWork: "defer",
      });
    }

    while (true) {
      const agentWork = await this.#admitAgentWork() ? "allow" : "defer";
      const advanced = await this.#runtime.advance({ agentWork, observedAt });
      const terminal = deferredResult(advanced, observedAt);
      if (terminal) return terminal;
      if (advanced.disposition === "busy") return { disposition: "busy" };
      if (advanced.disposition !== "idle") continue;

      const afterChat = await this.#runtime.runAfterChatContinuation({ observedAt, agentWork });
      if (afterChat.disposition === "admitted" || afterChat.disposition === "expired") continue;
      if (afterChat.disposition === "agent_work_deferred") {
        return { disposition: "deferred", reason: "agent_work_not_admitted" };
      }
      if (afterChat.disposition === "busy") return { disposition: "busy" };
      const afterChatWaiting = afterChat.disposition === "waiting" ? afterChat : undefined;

      const status = this.#runtime.status();
      const deliveryWaiting = pendingDeliveryWaiting(status);
      const active = status.activeSegment;
      if (!active) {
        const maintenance = await this.#runAttentionMaintenance(observedAt, agentWork);
        if (maintenance && maintenance.disposition !== "waiting") return maintenance;
        const reflection = await this.#runMemoryReflection(observedAt, agentWork);
        if (reflection && reflection.disposition !== "waiting") return reflection;
        if (!this.#proactivePulse) {
          return earliestWaiting(maintenance, reflection, afterChatWaiting, deliveryWaiting)
            ?? { disposition: "idle" };
        }
        const pulse = await this.#runtime.runOpportunityPulse({
          observedAt,
          initialDelayMs: this.#proactivePulse.initialDelayMs ?? this.#proactivePulse.intervalMs,
          cadenceMs: pulseCadenceFor(observedAt, this.#proactivePulse),
          retryDelayMs: this.#proactivePulse.retryDelayMs ?? DEFAULT_PULSE_RETRY_MS,
          agentWork,
        });
        if (pulse.disposition === "accepted" || pulse.disposition === "stale") continue;
        if (pulse.disposition === "waiting" || pulse.disposition === "none") {
          return {
            disposition: "waiting",
            nextRunAt: earlierTime(
              pulse.nextRunAt,
              earliestWaiting(maintenance, reflection, afterChatWaiting, deliveryWaiting)?.nextRunAt,
            ),
          };
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
      const nextRunAt = new Date(Math.min(
        new Date(active.lastActivityAt).getTime() + this.#activityIdleMs,
        new Date(active.openedAt).getTime() + this.#activityMaxMs,
      ));
      if (observedAt < nextRunAt) {
        return earliestWaiting(
          { disposition: "waiting", nextRunAt: nextRunAt.toISOString() },
          afterChatWaiting,
          deliveryWaiting,
        )!;
      }

      const inactiveBefore = new Date(observedAt.getTime() - this.#activityIdleMs).toISOString();
      const openedBefore = new Date(observedAt.getTime() - this.#activityMaxMs).toISOString();
      const closed = await this.#runtime.closeActivity({ inactiveBefore, openedBefore });
      if (closed.disposition === "busy") return { disposition: "busy" };
      if (closed.disposition === "not_due") {
        return earliestWaiting(
          {
            disposition: "waiting",
            nextRunAt: new Date(Math.min(
              new Date(closed.lastActivityAt).getTime() + this.#activityIdleMs,
              new Date(closed.openedAt).getTime() + this.#activityMaxMs,
            )).toISOString(),
          },
          afterChatWaiting,
          deliveryWaiting,
        )!;
      }
      if (closed.disposition === "no_activity") return { disposition: "idle" };
    }
  }

  async #runAttentionMaintenance(
    observedAt: Date,
    agentWork: "allow" | "defer",
  ): Promise<SchedulerRunResult | undefined> {
    if (!this.#attentionMaintenance) return undefined;
    const result = await this.#runtime.runAttentionMaintenance({
      observedAt,
      initialDelayMs: this.#attentionMaintenance.initialDelayMs ?? this.#attentionMaintenance.intervalMs,
      cadenceMs: this.#attentionMaintenance.intervalMs,
      retryDelayMs: this.#attentionMaintenance.retryDelayMs ?? DEFAULT_MAINTENANCE_RETRY_MS,
      agentWork,
    });
    if (result.disposition === "completed") {
      return { disposition: "waiting", nextRunAt: result.nextRunAt };
    }
    if (result.disposition === "failed") {
      return {
        disposition: "deferred",
        reason: "attention_maintenance_failed",
        nextRunAt: result.nextRunAt,
      };
    }
    if (result.disposition === "agent_work_deferred") {
      return { disposition: "deferred", reason: "agent_work_not_admitted" };
    }
    if (result.disposition === "busy") return { disposition: "busy" };
    if (result.disposition === "waiting") return result;
    return undefined;
  }

  async #runMemoryReflection(
    observedAt: Date,
    agentWork: "allow" | "defer",
  ): Promise<SchedulerRunResult | undefined> {
    if (!this.#memoryReflection) return undefined;
    const result = await this.#runtime.runMemoryReflection({
      observedAt,
      delayMs: this.#memoryReflection.delayMs,
      retryDelayMs: this.#memoryReflection.retryDelayMs ?? DEFAULT_MAINTENANCE_RETRY_MS,
      agentWork,
    });
    if (result.disposition === "completed" || result.disposition === "waiting") {
      return { disposition: "waiting", nextRunAt: result.nextRunAt };
    }
    if (result.disposition === "failed") {
      return {
        disposition: "deferred",
        reason: "memory_reflection_failed",
        nextRunAt: result.nextRunAt,
      };
    }
    if (result.disposition === "agent_work_deferred") {
      return { disposition: "deferred", reason: "agent_work_not_admitted" };
    }
    return { disposition: "busy" };
  }
}

function earlierTime(primary: string, secondary: string | undefined): string {
  if (!secondary) return primary;
  return Date.parse(secondary) < Date.parse(primary) ? secondary : primary;
}

function earliestWaiting(
  ...results: Array<SchedulerRunResult | undefined>
): Extract<SchedulerRunResult, { disposition: "waiting" }> | undefined {
  const times = results
    .filter((value): value is Extract<SchedulerRunResult, { disposition: "waiting" }> =>
      value?.disposition === "waiting");
  if (times.length === 0) return undefined;
  return times.reduce((earliest, candidate) =>
    Date.parse(candidate.nextRunAt) < Date.parse(earliest.nextRunAt) ? candidate : earliest);
}

function pendingDeliveryWaiting(
  status: RuntimeStatus,
): Extract<SchedulerRunResult, { disposition: "waiting" }> | undefined {
  const nextRunAt = status.effects
    .filter(effect => effect.status === "pending" && effect.nextDeliveryAt)
    .map(effect => effect.nextDeliveryAt!)
    .reduce<string | undefined>((earliest, candidate) =>
      !earliest || Date.parse(candidate) < Date.parse(earliest) ? candidate : earliest, undefined);
  return nextRunAt ? { disposition: "waiting", nextRunAt } : undefined;
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

function deferredResult(result: AdvanceResult, observedAt: Date): SchedulerRunResult | undefined {
  switch (result.disposition) {
    case "activity_recording_failed":
    case "thread_maintenance_failed":
      return {
        disposition: "deferred",
        reason: result.disposition,
        nextRunAt: new Date(observedAt.getTime() + DEFAULT_MAINTENANCE_RETRY_MS).toISOString(),
      };
    case "delivery_not_sent":
      return {
        disposition: "deferred",
        reason: result.disposition,
        nextRunAt: result.nextRunAt,
      };
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
