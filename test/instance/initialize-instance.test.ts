import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { initializeLoomInstance } from "../../src/instance/index.js";

test("creates an Instance scaffold without inventing Individual material", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "loom-init-"));
  const root = path.join(parent, ".loom");

  const result = await initializeLoomInstance({ root });

  assert.deepEqual(result, {
    root,
    createdFiles: [
      "configuration/instance.yaml",
      "templates/workspace/attention.md",
      "templates/workspace/facts.json",
      "templates/workspace/identity.md",
      "templates/workspace/memory.md",
      "workspace/behavior/background.md",
      "workspace/behavior/interaction.md",
    ],
    requiredIndividualMaterials: [
      { path: "workspace/facts.json", template: "templates/workspace/facts.json" },
      { path: "workspace/identity.md", template: "templates/workspace/identity.md" },
      { path: "workspace/memory.md", template: "templates/workspace/memory.md" },
      { path: "workspace/attention.md", template: "templates/workspace/attention.md" },
    ],
  });
  assert.match(
    await readFile(path.join(root, "workspace", "behavior", "interaction.md"), "utf8"),
    /ongoing relationship/,
  );
  assert.match(
    await readFile(path.join(root, "workspace", "behavior", "background.md"), "utf8"),
    /Background time belongs to the Agent Individual/,
  );
  assert.equal(await readFile(path.join(root, "configuration", "instance.yaml"), "utf8"), "version: 1\n");
  assert.equal((await stat(path.join(root, "configuration", "pi"))).isDirectory(), true);
  assert.match(await readFile(path.join(root, "templates", "workspace", "identity.md"), "utf8"), /initial self-understanding/);
  await assert.rejects(access(path.join(root, "workspace", "identity.md")));
  await assert.rejects(access(path.join(root, "workspace", "facts.json")));
  await assert.rejects(access(path.join(root, "workspace", "memory.md")));
  await assert.rejects(access(path.join(root, "workspace", "attention.md")));
});

test("preserves every existing scaffold file when initialization is repeated", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "loom-reinit-"));
  const root = path.join(parent, ".loom");
  await initializeLoomInstance({ root });
  const interaction = path.join(root, "workspace", "behavior", "interaction.md");
  const configuration = path.join(root, "configuration", "instance.yaml");
  const identityTemplate = path.join(root, "templates", "workspace", "identity.md");
  await Promise.all([
    writeFile(interaction, "Individual interaction behavior.\n", "utf8"),
    writeFile(configuration, "version: 1\ntime:\n  logicalDayStart: 04:00\n", "utf8"),
    writeFile(identityTemplate, "Deployment-owned identity seed.\n", "utf8"),
  ]);

  const result = await initializeLoomInstance({ root });

  assert.deepEqual(result.createdFiles, []);
  assert.equal(await readFile(interaction, "utf8"), "Individual interaction behavior.\n");
  assert.match(await readFile(configuration, "utf8"), /logicalDayStart: 04:00/);
  assert.equal(await readFile(identityTemplate, "utf8"), "Deployment-owned identity seed.\n");
});

test("does not follow a partial Instance scaffold outside its root", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "loom-init-boundary-"));
  const root = path.join(parent, ".loom");
  const outside = path.join(parent, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  await symlink(outside, path.join(root, "workspace"));

  await assert.rejects(
    initializeLoomInstance({ root }),
    /Instance scaffold path must stay inside the Instance Root/,
  );
  await assert.rejects(access(path.join(outside, "behavior", "interaction.md")));
});
