import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openLoomHost } from "../../src/host/index.js";

test("holds exclusive live ownership of one prepared Instance Root", async t => {
  const root = await preparedInstanceRoot();
  const first = await openLoomHost({ root, machineTimeZone: "UTC" });
  t.after(() => first.stop());

  first.start();
  await eventually(() => first.status().driver.state === "waiting");
  assert.equal(first.status().state, "running");
  assert.equal(first.status().instance.models.state, "blocked");

  await assert.rejects(
    openLoomHost({ root, machineTimeZone: "UTC" }),
    /Instance Root is already owned by a live Loom Host/,
  );

  await first.stop();
  assert.equal(first.status().state, "stopped");
  assert.equal(first.status().driver.state, "stopped");

  const replacement = await openLoomHost({ root, machineTimeZone: "UTC" });
  await replacement.stop();
});

test("accepts channel Input only through a running Host", async t => {
  const root = await preparedInstanceRoot();
  const host = await openLoomHost({ root, machineTimeZone: "UTC" });
  t.after(() => host.stop());

  await assert.rejects(
    async () => host.acceptInput({
      source: "test-channel",
      sourceId: "before-start",
      kind: "interaction",
      payload: { text: "too early" },
    }),
    /cannot accept Input while open/,
  );

  host.start();
  const accepted = await host.acceptInput({
    source: "test-channel",
    sourceId: "host-input",
    kind: "interaction",
    payload: { text: "hello" },
  });
  await eventually(() => host.status().instance.runtime.inputs.length === 1);

  assert.equal(accepted.disposition, "accepted");
  assert.equal(host.status().instance.runtime.inputs[0]?.sourceId, "host-input");
  assert.equal(host.status().instance.runtime.inputs[0]?.status, "pending");
});

test("releases Instance Root ownership when Instance opening fails", async () => {
  const root = await preparedInstanceRoot();
  const configuration = path.join(root, "configuration", "instance.yaml");
  await mkdir(path.dirname(configuration), { recursive: true });
  await writeFile(configuration, "version: [malformed", "utf8");

  await assert.rejects(openLoomHost({ root }), /Instance Configuration could not be read/);
  await rm(configuration);

  const recovered = await openLoomHost({ root });
  await recovered.stop();
});

async function preparedInstanceRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "loom-host-"));
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "behavior"), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, "facts.json"), JSON.stringify({
      version: 1,
      individual: { name: "Rowan", languages: ["en"] },
      human: { name: "Alex", languages: ["en"] },
    }), "utf8"),
    writeFile(path.join(workspace, "identity.md"), "Rowan is a continuing AI Individual.\n", "utf8"),
    writeFile(path.join(workspace, "memory.md"), "No durable memories yet.\n", "utf8"),
    writeFile(path.join(workspace, "attention.md"), "Nothing is currently foregrounded.\n", "utf8"),
    writeFile(path.join(workspace, "behavior", "interaction.md"), "Meet direct interaction as Rowan.\n", "utf8"),
    writeFile(path.join(workspace, "behavior", "background.md"), "Background time belongs to Rowan.\n", "utf8"),
  ]);
  return root;
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}
