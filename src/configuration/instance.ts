import { readFile } from "node:fs/promises";

import { parse } from "yaml";

import { createTimePolicy, type TimePolicy } from "./time-policy.js";

export interface InstanceConfiguration {
  version: 1;
  timePolicy: TimePolicy;
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
  assertOnlyKeys(document, ["version", "time"], "Instance Configuration");
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

  return {
    version: 1,
    timePolicy: createTimePolicy({
      timeZone: time.timeZone ?? machineTimeZone,
      ...(time.logicalDayStart !== undefined ? { logicalDayStart: time.logicalDayStart } : {}),
    }),
  };
}

function defaultConfiguration(machineTimeZone: string): InstanceConfiguration {
  return {
    version: 1,
    timePolicy: createTimePolicy({ timeZone: machineTimeZone }),
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
