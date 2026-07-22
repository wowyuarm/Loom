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
