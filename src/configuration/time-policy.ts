import { Temporal } from "@js-temporal/polyfill";

export interface TimePolicy {
  readonly timeZone: string;
  readonly logicalDayStart: string;
  formatLocalTime(instant: Date): string;
  recordingDay(instant: Date): string;
  nextRecordingDay(recordingDay: string): string;
  logicalDayEnd(recordingDay: string): Date;
}

export interface TimePolicyOptions {
  timeZone: string;
  logicalDayStart?: string;
}

class TemporalTimePolicy implements TimePolicy {
  readonly timeZone: string;
  readonly logicalDayStart: string;
  readonly #boundary: Temporal.PlainTime;

  constructor(options: TimePolicyOptions) {
    this.timeZone = validateTimeZone(options.timeZone);
    this.logicalDayStart = validateLogicalDayStart(options.logicalDayStart ?? "03:00");
    this.#boundary = Temporal.PlainTime.from(this.logicalDayStart);
  }

  formatLocalTime(instant: Date): string {
    const local = toZonedDateTime(instant, this.timeZone);
    const date = local.toPlainDate().toString();
    const time = `${pad(local.hour)}:${pad(local.minute)}`;
    return `${date} ${time} ${local.offset}`;
  }

  recordingDay(instant: Date): string {
    const local = toZonedDateTime(instant, this.timeZone);
    const date = local.toPlainDate();
    return (Temporal.PlainTime.compare(local.toPlainTime(), this.#boundary) < 0
      ? date.subtract({ days: 1 })
      : date).toString();
  }

  nextRecordingDay(recordingDay: string): string {
    return parseRecordingDay(recordingDay).add({ days: 1 }).toString();
  }

  logicalDayEnd(recordingDay: string): Date {
    const boundaryDate = parseRecordingDay(recordingDay).add({ days: 1 });
    return new Date(Temporal.ZonedDateTime.from({
      timeZone: this.timeZone,
      year: boundaryDate.year,
      month: boundaryDate.month,
      day: boundaryDate.day,
      hour: this.#boundary.hour,
      minute: this.#boundary.minute,
      second: this.#boundary.second,
    }).epochMilliseconds);
  }
}

export function createTimePolicy(options: TimePolicyOptions): TimePolicy {
  return new TemporalTimePolicy(options);
}

export function createHostTimePolicy(): TimePolicy {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timeZone) throw new Error("Host machine did not expose an IANA time zone");
  return createTimePolicy({ timeZone });
}

function validateTimeZone(value: string): string {
  if (!value.trim()) throw new Error("Instance timeZone cannot be blank");
  try {
    Temporal.ZonedDateTime.from({
      timeZone: value,
      year: 2000,
      month: 1,
      day: 1,
      hour: 0,
    });
    return value;
  } catch {
    throw new Error(`Instance timeZone is not a valid IANA time zone: ${value}`);
  }
}

function validateLogicalDayStart(value: string): string {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error("Instance logicalDayStart must use 24-hour HH:MM format");
  }
  return value;
}

function toZonedDateTime(instant: Date, timeZone: string): Temporal.ZonedDateTime {
  const milliseconds = instant.getTime();
  if (!Number.isFinite(milliseconds)) throw new Error("Time Policy requires a valid instant");
  return Temporal.Instant.fromEpochMilliseconds(milliseconds).toZonedDateTimeISO(timeZone);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function parseRecordingDay(value: string): Temporal.PlainDate {
  try {
    return Temporal.PlainDate.from(value);
  } catch {
    throw new Error(`Recording day is not a logical date: ${value}`);
  }
}
