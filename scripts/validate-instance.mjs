#!/usr/bin/env node

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { openLoomInstance } from "../dist/src/instance/index.js";

const { command, options } = parseArguments(process.argv.slice(2));
const root = path.resolve(options.root ?? ".loom");
const observedAt = parseObservedAt(options.at);
const deliveryFile = path.join(root, "evaluation", "deliveries.jsonl");

const instance = await openLoomInstance({
  root,
  now: () => observedAt,
  outboundDelivery: {
    deliver: async attempt => {
      const observation = {
        status: "delivered",
        remoteId: `validation:${attempt.idempotencyKey}`,
      };
      await mkdir(path.dirname(deliveryFile), { recursive: true });
      await appendFile(deliveryFile, `${JSON.stringify({
        observedAt: observedAt.toISOString(),
        attempt,
        observation,
      })}\n`, "utf8");
      return observation;
    },
  },
});

try {
  let result;
  switch (command) {
    case "status":
      result = instance.status();
      break;
    case "input":
      result = await instance.acceptInput({
        source: "validation-human",
        sourceId: requiredOption(options, "id"),
        kind: "interaction",
        payload: { text: requiredOption(options, "text") },
      });
      break;
    case "run":
      result = await instance.runOnce(observedAt);
      break;
    case "opportunity":
      result = await instance.formOpportunity();
      break;
    default:
      throw new Error(`Unknown command: ${command ?? "<missing>"}\n${usage()}`);
  }
  const output = `${JSON.stringify({
    observedAt: observedAt.toISOString(),
    result,
    status: instance.status(),
  }, null, 2)}\n`;
  if (options.record) {
    const recordFile = path.resolve(options.record);
    await mkdir(path.dirname(recordFile), { recursive: true });
    await writeFile(recordFile, output, "utf8");
  }
  process.stdout.write(output);
} finally {
  instance.close();
}

function parseArguments(args) {
  const [command, ...rest] = args;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(usage());
    options[flag.slice(2)] = value;
  }
  return { command, options };
}

function parseObservedAt(value) {
  const observedAt = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(observedAt.getTime())) throw new Error(`Invalid --at value: ${value}`);
  return observedAt;
}

function requiredOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing --${name}\n${usage()}`);
  }
  return value;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/validate-instance.mjs status [--root .loom] [--at ISO] [--record FILE]",
    "  node scripts/validate-instance.mjs input --id ID --text TEXT [--root .loom] [--at ISO] [--record FILE]",
    "  node scripts/validate-instance.mjs run [--root .loom] [--at ISO] [--record FILE]",
    "  node scripts/validate-instance.mjs opportunity [--root .loom] [--at ISO] [--record FILE]",
  ].join("\n");
}
