import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadInstanceConfiguration } from "../../src/configuration/index.js";

test("loads an explicit time policy across a daylight-saving transition", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-configuration-"));
  const file = path.join(root, "instance.yaml");
  await writeFile(file, [
    "version: 1",
    "time:",
    "  timeZone: Europe/Berlin",
    "  logicalDayStart: \"03:00\"",
    "",
  ].join("\n"), "utf8");

  const configuration = await loadInstanceConfiguration({
    file,
    machineTimeZone: "UTC",
  });

  assert.equal(configuration.timePolicy.timeZone, "Europe/Berlin");
  assert.equal(configuration.timePolicy.logicalDayStart, "03:00");
  assert.equal(
    configuration.timePolicy.formatLocalTime(new Date("2026-10-25T01:30:00.000Z")),
    "2026-10-25 02:30 +01:00",
  );
  assert.equal(
    configuration.timePolicy.recordingDay(new Date("2026-10-25T01:30:00.000Z")),
    "2026-10-24",
  );
});

test("uses the machine time zone and Harness logical-day default when config is absent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-configuration-default-"));
  const configuration = await loadInstanceConfiguration({
    file: path.join(root, "missing-instance.yaml"),
    machineTimeZone: "Asia/Tokyo",
  });

  assert.equal(configuration.timePolicy.timeZone, "Asia/Tokyo");
  assert.equal(configuration.timePolicy.logicalDayStart, "03:00");
  assert.equal(
    configuration.timePolicy.recordingDay(new Date("2026-07-21T17:30:00.000Z")),
    "2026-07-21",
  );
});

test("rejects invalid Instance time configuration before Runtime starts", async () => {
  const cases = [
    {
      name: "unknown field",
      source: "version: 1\ntime:\n  calendar: lunar\n",
      error: /unknown fields: calendar/,
    },
    {
      name: "invalid time zone",
      source: "version: 1\ntime:\n  timeZone: Moon\/Tranquility\n",
      error: /not a valid IANA time zone/,
    },
    {
      name: "invalid logical day",
      source: "version: 1\ntime:\n  logicalDayStart: \"3am\"\n",
      error: /24-hour HH:MM format/,
    },
  ];

  for (const candidate of cases) {
    const root = await mkdtemp(path.join(tmpdir(), "loom-configuration-invalid-"));
    const file = path.join(root, "instance.yaml");
    await writeFile(file, candidate.source, "utf8");
    await assert.rejects(
      loadInstanceConfiguration({ file, machineTimeZone: "UTC" }),
      candidate.error,
      candidate.name,
    );
  }
});
