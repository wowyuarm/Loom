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

test("rejects a missing Instance Configuration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-configuration-default-"));
  const file = path.join(root, "missing-instance.yaml");

  await assert.rejects(
    loadInstanceConfiguration({ file, machineTimeZone: "Asia/Tokyo" }),
    /Instance Configuration could not be read:.*ENOENT.*missing-instance\.yaml/,
  );
});

test("loads model roles with whole-policy inheritance from the default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-model-configuration-"));
  const file = path.join(root, "instance.yaml");
  await writeFile(file, [
    "version: 1",
    "models:",
    "  default:",
    "    - provider: provider-a",
    "      model: model-a",
    "      thinkingLevel: medium",
    "  orientation:",
    "    - provider: provider-b",
    "      model: model-b",
    "      thinkingLevel: high",
    "",
  ].join("\n"), "utf8");

  const configuration = await loadInstanceConfiguration({
    file,
    machineTimeZone: "UTC",
  });

  assert.deepEqual(configuration.modelPolicy?.roles["main-interaction"], [{
    provider: "provider-a",
    model: "model-a",
    thinkingLevel: "medium",
  }]);
  assert.deepEqual(configuration.modelPolicy?.roles.orientation, [{
    provider: "provider-b",
    model: "model-b",
    thinkingLevel: "high",
  }]);
});

test("loads the default Interaction Route as a trimmed opaque reference", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-interaction-configuration-"));
  const file = path.join(root, "instance.yaml");
  await writeFile(file, [
    "version: 1",
    "interaction:",
    "  defaultRoute: \"  primary-route  \"",
    "",
  ].join("\n"), "utf8");

  const configuration = await loadInstanceConfiguration({ file, machineTimeZone: "UTC" });

  assert.equal(configuration.defaultInteractionRoute, "primary-route");
});

test("requires explicit Integration enablement and keeps Integrations disabled by default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-integration-configuration-"));
  const file = path.join(root, "instance.yaml");
  await writeFile(file, [
    "version: 1",
    "integrations:",
    "  local:",
    "    enabled: true",
    "  weixin:",
    "    enabled: false",
    "  raft:",
    "    enabled: true",
    "  web:",
    "    enabled: true",
    "  nmem:",
    "    enabled: true",
    "",
  ].join("\n"), "utf8");

  const configured = await loadInstanceConfiguration({ file, machineTimeZone: "UTC" });
  const defaultsFile = path.join(root, "defaults.yaml");
  await writeFile(defaultsFile, "version: 1\n", "utf8");
  const defaults = await loadInstanceConfiguration({ file: defaultsFile, machineTimeZone: "UTC" });

  assert.deepEqual(configured.integrations, { local: true, weixin: false, raft: true, web: true, nmem: true });
  assert.deepEqual(defaults.integrations, { local: false, weixin: false, raft: false, web: false, nmem: false });
});

test("loads the proactive Pulse schedule with Harness defaults and explicit overrides", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-schedule-configuration-"));
  const file = path.join(root, "instance.yaml");
  await writeFile(file, [
    "version: 1",
    "schedule:",
    "  proactivePulse:",
    "    intervalMinutes: 45",
    "    quietHours:",
    "      start: \"23:30\"",
    "      end: \"06:15\"",
    "      intervalMinutes: 120",
    "",
  ].join("\n"), "utf8");

  const configured = await loadInstanceConfiguration({ file, machineTimeZone: "UTC" });
  const defaultsFile = path.join(root, "defaults.yaml");
  await writeFile(defaultsFile, "version: 1\n", "utf8");
  const defaults = await loadInstanceConfiguration({ file: defaultsFile, machineTimeZone: "UTC" });

  assert.deepEqual(configured.schedule.proactivePulse, {
    intervalMinutes: 45,
    quietHours: { start: "23:30", end: "06:15", intervalMinutes: 120 },
  });
  assert.deepEqual(defaults.schedule.proactivePulse, {
    intervalMinutes: 30,
    quietHours: { start: "01:00", end: "07:00", intervalMinutes: 90 },
  });
  assert.deepEqual(defaults.schedule.attentionMaintenance, { intervalMinutes: 360 });
});

test("loads the Attention maintenance cadence independently from the proactive Pulse", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-attention-schedule-"));
  const file = path.join(root, "loom.yaml");
  await writeFile(file, [
    "version: 1",
    "schedule:",
    "  attentionMaintenance:",
    "    intervalMinutes: 240",
    "",
  ].join("\n"));

  const configuration = await loadInstanceConfiguration({ file, machineTimeZone: "UTC" });
  assert.deepEqual(configuration.schedule.attentionMaintenance, { intervalMinutes: 240 });
  assert.equal(configuration.schedule.proactivePulse.intervalMinutes, 30);
});

test("derives the next logical-day boundary and Memory reflection delay", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-reflection-schedule-"));
  const file = path.join(root, "loom.yaml");
  await writeFile(file, [
    "version: 1",
    "time:",
    "  timeZone: Europe/Berlin",
    "  logicalDayStart: 03:00",
    "schedule:",
    "  memoryReflection:",
    "    delayMinutes: 30",
    "",
  ].join("\n"));

  const configuration = await loadInstanceConfiguration({ file, machineTimeZone: "UTC" });
  assert.deepEqual(configuration.schedule.memoryReflection, { delayMinutes: 30 });
  assert.equal(configuration.timePolicy.nextRecordingDay("2026-10-24"), "2026-10-25");
  assert.equal(
    configuration.timePolicy.logicalDayEnd("2026-10-24").toISOString(),
    "2026-10-25T02:00:00.000Z",
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
    {
      name: "unknown model role",
      source: [
        "version: 1",
        "models:",
        "  default:",
        "    - provider: provider-a",
        "      model: model-a",
        "  narrator:",
        "    - provider: provider-b",
        "      model: model-b",
        "",
      ].join("\n"),
      error: /unknown fields: narrator/,
    },
    {
      name: "empty default model candidates",
      source: "version: 1\nmodels:\n  default: []\n",
      error: /models\.default must be a non-empty array/,
    },
    {
      name: "invalid thinking level",
      source: [
        "version: 1",
        "models:",
        "  default:",
        "    - provider: provider-a",
        "      model: model-a",
        "      thinkingLevel: enormous",
        "",
      ].join("\n"),
      error: /thinkingLevel is invalid/,
    },
    {
      name: "empty default Interaction Route",
      source: "version: 1\ninteraction:\n  defaultRoute: \"   \"\n",
      error: /interaction\.defaultRoute must be a non-empty string/,
    },
    {
      name: "unknown interaction field",
      source: "version: 1\ninteraction:\n  channel: private\n",
      error: /unknown fields: channel/,
    },
    {
      name: "invalid Integration enablement",
      source: "version: 1\nintegrations:\n  local:\n    enabled: yes\n",
      error: /integrations\.local\.enabled must be a boolean/,
    },
    {
      name: "invalid Pulse cadence",
      source: "version: 1\nschedule:\n  proactivePulse:\n    intervalMinutes: 0\n",
      error: /intervalMinutes must be a positive integer/,
    },
    {
      name: "invalid quiet hours",
      source: "version: 1\nschedule:\n  proactivePulse:\n    quietHours:\n      start: bedtime\n",
      error: /quietHours\.start must use 24-hour HH:MM format/,
    },
    {
      name: "ambiguous full-day quiet hours",
      source: [
        "version: 1",
        "schedule:",
        "  proactivePulse:",
        "    quietHours:",
        "      start: \"06:00\"",
        "      end: \"06:00\"",
        "",
      ].join("\n"),
      error: /quiet hours must not cover an ambiguous full day/,
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
