import { readFile } from "node:fs/promises";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parse } from "yaml";

import { createTimePolicy, type TimePolicy } from "./time-policy.js";

export interface InstanceConfiguration {
  version: 1;
  timePolicy: TimePolicy;
  schedule: ScheduleConfiguration;
  modelPolicy?: ModelPolicy;
  defaultInteractionRoute?: string;
}

export interface ScheduleConfiguration {
  proactivePulse: ProactivePulseConfiguration;
  attentionMaintenance: AttentionMaintenanceConfiguration;
  memoryReflection: MemoryReflectionConfiguration;
}

export interface AttentionMaintenanceConfiguration {
  intervalMinutes: number;
}

export interface MemoryReflectionConfiguration {
  delayMinutes: number;
}

export interface ProactivePulseConfiguration {
  intervalMinutes: number;
  quietHours: {
    start: string;
    end: string;
    intervalMinutes: number;
  };
}

export const DEFAULT_SCHEDULE: ScheduleConfiguration = Object.freeze({
  proactivePulse: Object.freeze({
    intervalMinutes: 30,
    quietHours: Object.freeze({
      start: "01:00",
      end: "07:00",
      intervalMinutes: 90,
    }),
  }),
  attentionMaintenance: Object.freeze({ intervalMinutes: 360 }),
  memoryReflection: Object.freeze({ delayMinutes: 15 }),
});

export const MODEL_ROLES = [
  "main-interaction",
  "main-background",
  "tool-trace-compactor",
  "orientation",
  "life-recorder",
  "attention-maintainer",
  "thread-maintainer",
  "memory-reflector",
] as const;

export type ModelRole = typeof MODEL_ROLES[number];

export interface ModelCandidate {
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
}

export interface ModelPolicy {
  roles: Readonly<Record<ModelRole, readonly ModelCandidate[]>>;
}

export interface LoadInstanceConfigurationOptions {
  file: string;
  machineTimeZone?: string;
}

export async function loadInstanceConfiguration(
  options: LoadInstanceConfigurationOptions,
): Promise<InstanceConfiguration> {
  const machineTimeZone = options.machineTimeZone ?? currentMachineTimeZone();
  let document: unknown;
  try {
    document = parse(await readFile(options.file, "utf8"), { uniqueKeys: true });
  } catch (error) {
    if (isMissingFile(error)) {
      return defaultConfiguration(machineTimeZone);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Instance Configuration could not be read: ${message}`);
  }

  if (!isObject(document)) throw new Error("Instance Configuration must be a YAML object");
  assertOnlyKeys(document, ["version", "time", "models", "interaction", "schedule"], "Instance Configuration");
  if (document.version !== 1) throw new Error("Instance Configuration requires version: 1");

  const time = document.time ?? {};
  if (!isObject(time)) throw new Error("Instance Configuration time must be an object");
  assertOnlyKeys(time, ["timeZone", "logicalDayStart"], "Instance Configuration time");
  if (time.timeZone !== undefined && typeof time.timeZone !== "string") {
    throw new Error("Instance Configuration time.timeZone must be a string");
  }
  if (time.logicalDayStart !== undefined && typeof time.logicalDayStart !== "string") {
    throw new Error("Instance Configuration time.logicalDayStart must be a string");
  }

  const modelPolicy = document.models === undefined
    ? undefined
    : parseModelPolicy(document.models);
  const defaultInteractionRoute = parseInteraction(document.interaction);
  const schedule = parseSchedule(document.schedule);
  return {
    version: 1,
    timePolicy: createTimePolicy({
      timeZone: time.timeZone ?? machineTimeZone,
      ...(time.logicalDayStart !== undefined ? { logicalDayStart: time.logicalDayStart } : {}),
    }),
    schedule,
    ...(modelPolicy ? { modelPolicy } : {}),
    ...(defaultInteractionRoute ? { defaultInteractionRoute } : {}),
  };
}

function parseInteraction(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error("Instance Configuration interaction must be an object");
  assertOnlyKeys(value, ["defaultRoute"], "Instance Configuration interaction");
  if (typeof value.defaultRoute !== "string" || !value.defaultRoute.trim()) {
    throw new Error("Instance Configuration interaction.defaultRoute must be a non-empty string");
  }
  return value.defaultRoute.trim();
}

function parseSchedule(value: unknown): ScheduleConfiguration {
  if (value === undefined) return DEFAULT_SCHEDULE;
  if (!isObject(value)) throw new Error("Instance Configuration schedule must be an object");
  assertOnlyKeys(
    value,
    ["proactivePulse", "attentionMaintenance", "memoryReflection"],
    "Instance Configuration schedule",
  );
  const pulse = value.proactivePulse;
  if (pulse !== undefined && !isObject(pulse)) {
    throw new Error("Instance Configuration schedule.proactivePulse must be an object");
  }
  const pulseObject = pulse ?? {};
  assertOnlyKeys(pulseObject, ["intervalMinutes", "quietHours"], "Instance Configuration schedule.proactivePulse");
  const intervalMinutes = parsePositiveMinutes(pulseObject.intervalMinutes, "schedule.proactivePulse.intervalMinutes", 30);
  const quietHours = pulseObject.quietHours === undefined ? DEFAULT_SCHEDULE.proactivePulse.quietHours : pulseObject.quietHours;
  if (!isObject(quietHours)) {
    throw new Error("Instance Configuration schedule.proactivePulse.quietHours must be an object");
  }
  assertOnlyKeys(
    quietHours,
    ["start", "end", "intervalMinutes"],
    "Instance Configuration schedule.proactivePulse.quietHours",
  );
  const start = parseClock(quietHours.start ?? "01:00", "schedule.proactivePulse.quietHours.start");
  const end = parseClock(quietHours.end ?? "07:00", "schedule.proactivePulse.quietHours.end");
  if (start === end) {
    throw new Error("Instance Configuration schedule.proactivePulse quiet hours must not cover an ambiguous full day");
  }
  const quietIntervalMinutes = parsePositiveMinutes(
    quietHours.intervalMinutes,
    "schedule.proactivePulse.quietHours.intervalMinutes",
    90,
  );
  const attention = value.attentionMaintenance;
  if (attention !== undefined && !isObject(attention)) {
    throw new Error("Instance Configuration schedule.attentionMaintenance must be an object");
  }
  const attentionObject = attention ?? {};
  assertOnlyKeys(attentionObject, ["intervalMinutes"], "Instance Configuration schedule.attentionMaintenance");
  const attentionIntervalMinutes = parsePositiveMinutes(
    attentionObject.intervalMinutes,
    "schedule.attentionMaintenance.intervalMinutes",
    DEFAULT_SCHEDULE.attentionMaintenance.intervalMinutes,
  );
  const reflection = value.memoryReflection;
  if (reflection !== undefined && !isObject(reflection)) {
    throw new Error("Instance Configuration schedule.memoryReflection must be an object");
  }
  const reflectionObject = reflection ?? {};
  assertOnlyKeys(reflectionObject, ["delayMinutes"], "Instance Configuration schedule.memoryReflection");
  const reflectionDelayMinutes = parseNonNegativeMinutes(
    reflectionObject.delayMinutes,
    "schedule.memoryReflection.delayMinutes",
    DEFAULT_SCHEDULE.memoryReflection.delayMinutes,
  );
  return Object.freeze({
    proactivePulse: Object.freeze({
      intervalMinutes,
      quietHours: Object.freeze({ start, end, intervalMinutes: quietIntervalMinutes }),
    }),
    attentionMaintenance: Object.freeze({ intervalMinutes: attentionIntervalMinutes }),
    memoryReflection: Object.freeze({ delayMinutes: reflectionDelayMinutes }),
  });
}

function parsePositiveMinutes(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Instance Configuration ${label} must be a positive integer`);
  }
  return value;
}

function parseNonNegativeMinutes(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Instance Configuration ${label} must be a non-negative integer`);
  }
  return value;
}

function parseClock(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`Instance Configuration ${label} must use 24-hour HH:MM format`);
  }
  return value;
}

function parseModelPolicy(value: unknown): ModelPolicy {
  if (!isObject(value)) throw new Error("Instance Configuration models must be an object");
  assertOnlyKeys(value, ["default", ...MODEL_ROLES], "Instance Configuration models");
  const fallback = parseModelCandidates(value.default, "models.default");
  const roles = {} as Record<ModelRole, readonly ModelCandidate[]>;
  for (const role of MODEL_ROLES) {
    const candidates = value[role] === undefined
      ? fallback.map(candidate => ({ ...candidate }))
      : parseModelCandidates(value[role], `models.${role}`);
    roles[role] = Object.freeze(candidates.map(candidate => Object.freeze(candidate)));
  }
  return Object.freeze({ roles: Object.freeze(roles) });
}

function parseModelCandidates(value: unknown, label: string): ModelCandidate[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Instance Configuration ${label} must be a non-empty array`);
  }
  return value.map((candidate, index) => {
    const candidateLabel = `${label}[${index}]`;
    if (!isObject(candidate)) {
      throw new Error(`Instance Configuration ${candidateLabel} must be an object`);
    }
    assertOnlyKeys(
      candidate,
      ["provider", "model", "thinkingLevel"],
      `Instance Configuration ${candidateLabel}`,
    );
    if (typeof candidate.provider !== "string" || !candidate.provider.trim()) {
      throw new Error(`Instance Configuration ${candidateLabel}.provider must be a non-empty string`);
    }
    if (typeof candidate.model !== "string" || !candidate.model.trim()) {
      throw new Error(`Instance Configuration ${candidateLabel}.model must be a non-empty string`);
    }
    if (candidate.thinkingLevel !== undefined && !isThinkingLevel(candidate.thinkingLevel)) {
      throw new Error(`Instance Configuration ${candidateLabel}.thinkingLevel is invalid`);
    }
    return {
      provider: candidate.provider.trim(),
      model: candidate.model.trim(),
      ...(candidate.thinkingLevel !== undefined
        ? { thinkingLevel: candidate.thinkingLevel }
        : {}),
    };
  });
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string"
    && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

function defaultConfiguration(machineTimeZone: string): InstanceConfiguration {
  return {
    version: 1,
    timePolicy: createTimePolicy({ timeZone: machineTimeZone }),
    schedule: DEFAULT_SCHEDULE,
  };
}

function currentMachineTimeZone(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timeZone) throw new Error("Host machine did not expose an IANA time zone");
  return timeZone;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
): void {
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unknown fields: ${unexpected.join(", ")}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
