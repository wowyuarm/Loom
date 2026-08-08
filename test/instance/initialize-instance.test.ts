import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { initializeLoomInstance } from "../../src/instance/index.js";

test("creates an Instance scaffold without inventing Individual material", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "loom-init-"));
  const root = path.join(parent, ".loom");

  const result = await initializeLoomInstance({ root, channels: ["weixin", "raft"] });

  assert.deepEqual(result, {
    root,
    createdFiles: [
      "configuration/instance.yaml",
      "workspace/behavior/interactivity.md",
      "workspace/behavior/proactivity.md",
    ],
    requiredIndividualMaterials: [
      { path: "workspace/facts.json" },
      { path: "workspace/identity.md" },
      { path: "workspace/memory.md" },
      { path: "workspace/attention.md" },
    ],
  });
  assert.match(
    await readFile(path.join(root, "workspace", "behavior", "interactivity.md"), "utf8"),
    /ongoing relationship/,
  );
  assert.match(
    await readFile(path.join(root, "workspace", "behavior", "proactivity.md"), "utf8"),
    /Proactivity time belongs to the Agent Individual/,
  );
  assert.equal(await readFile(path.join(root, "configuration", "instance.yaml"), "utf8"), [
    "version: 1",
    "channels:",
    "  weixin:",
    "    enabled: true",
    "  raft:",
    "    enabled: true",
    "integrations:",
    "  web:",
    "    enabled: false",
    "  nmem:",
    "    enabled: false",
    "",
  ].join("\n"));
  assert.equal((await stat(path.join(root, "configuration", "pi"))).isDirectory(), true);
  await assert.rejects(access(path.join(root, "templates")));
  await assert.rejects(access(path.join(root, "workspace", "identity.md")));
  await assert.rejects(access(path.join(root, "workspace", "facts.json")));
  await assert.rejects(access(path.join(root, "workspace", "memory.md")));
  await assert.rejects(access(path.join(root, "workspace", "attention.md")));
});

test("preserves every existing scaffold file when initialization is repeated", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "loom-reinit-"));
  const root = path.join(parent, ".loom");
  await initializeLoomInstance({ root, channels: ["raft"] });
  const interaction = path.join(root, "workspace", "behavior", "interactivity.md");
  const configuration = path.join(root, "configuration", "instance.yaml");
  await Promise.all([
    writeFile(interaction, "Individual interaction behavior.\n", "utf8"),
    writeFile(configuration, "version: 1\ntime:\n  logicalDayStart: 04:00\n", "utf8"),
  ]);

  const result = await initializeLoomInstance({ root, channels: ["raft"] });

  assert.deepEqual(result.createdFiles, []);
  assert.equal(await readFile(interaction, "utf8"), "Individual interaction behavior.\n");
  assert.match(await readFile(configuration, "utf8"), /logicalDayStart: 04:00/);
});

test("requires at least one enabled Interaction Channel and deduplicates repeated names", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "loom-init-channels-"));
  const root = path.join(parent, ".loom");

  await assert.rejects(
    initializeLoomInstance({ root, channels: [] }),
    /at least one enabled Interaction Channel/,
  );
  await assert.rejects(
    initializeLoomInstance({ root, channels: ["raft", "weixin", "slack" as never] }),
    /Unsupported Interaction Channel: slack/,
  );

  const result = await initializeLoomInstance({ root, channels: ["raft", "raft"] });
  assert.match(
    await readFile(path.join(root, "configuration", "instance.yaml"), "utf8"),
    /channels:\n  weixin:\n    enabled: false\n  raft:\n    enabled: true/,
  );
  assert.deepEqual(result.createdFiles, [
    "configuration/instance.yaml",
    "workspace/behavior/interactivity.md",
    "workspace/behavior/proactivity.md",
  ]);
});

test("does not follow a partial Instance scaffold outside its root", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "loom-init-boundary-"));
  const root = path.join(parent, ".loom");
  const outside = path.join(parent, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  await symlink(outside, path.join(root, "workspace"));

  await assert.rejects(
    initializeLoomInstance({ root, channels: ["raft"] }),
    /Instance scaffold path must stay inside the Instance Root/,
  );
  await assert.rejects(access(path.join(outside, "behavior", "interactivity.md")));
});
