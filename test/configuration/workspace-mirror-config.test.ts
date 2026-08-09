import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { loadInstanceConfiguration } from "../../src/configuration/instance.js";

async function withConfig(yaml: string, fn: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "loom-instance-test-"));
  try {
    const file = path.join(dir, "instance.yaml");
    await writeFile(file, yaml, "utf8");
    await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const BASE = [
  "version: 1",
  "channels:",
  "  weixin:",
  "    enabled: false",
  "  raft:",
  "    enabled: true",
  "integrations:",
  "  web:",
  "    enabled: false",
  "  nmem:",
  "    enabled: false",
  "",
].join("\n");

test("workspaceMirror is undefined when not configured", async () => {
  await withConfig(BASE, async file => {
    const config = await loadInstanceConfiguration({ file });
    assert.equal(config.workspaceMirror, undefined);
  });
});

test("workspaceMirror parses enabled/remote/branch/intervalMinutes with defaults", async () => {
  const yaml = BASE + "workspaceMirror:\n  enabled: true\n  remote: git@github.com:wowyuarm/loom-hal-workspace.git\n";
  await withConfig(yaml, async file => {
    const config = await loadInstanceConfiguration({ file });
    assert.deepEqual(config.workspaceMirror, {
      enabled: true,
      remote: "git@github.com:wowyuarm/loom-hal-workspace.git",
      branch: "main",
      intervalMinutes: 30,
    });
  });
});

test("workspaceMirror honors explicit branch and intervalMinutes", async () => {
  const yaml = BASE + [
    "workspaceMirror:",
    "  enabled: true",
    "  remote: git@github.com:wowyuarm/loom-xi-workspace.git",
    "  branch: mirror",
    "  intervalMinutes: 60",
    "",
  ].join("\n");
  await withConfig(yaml, async file => {
    const config = await loadInstanceConfiguration({ file });
    assert.equal(config.workspaceMirror?.branch, "mirror");
    assert.equal(config.workspaceMirror?.intervalMinutes, 60);
  });
});

test("workspaceMirror rejects unknown keys and bad values", async () => {
  await withConfig(BASE + "workspaceMirror:\n  enabled: true\n  remote: r\n  extra: x\n", async file => {
    await assert.rejects(loadInstanceConfiguration({ file }), /workspaceMirror/);
  });
  await withConfig(BASE + "workspaceMirror:\n  enabled: true\n  remote: \"\"\n", async file => {
    await assert.rejects(loadInstanceConfiguration({ file }), /remote/);
  });
  await withConfig(BASE + "workspaceMirror:\n  enabled: \"yes\"\n  remote: r\n", async file => {
    await assert.rejects(loadInstanceConfiguration({ file }), /enabled/);
  });
  await withConfig(BASE + "workspaceMirror:\n  enabled: true\n  remote: r\n  intervalMinutes: 0\n", async file => {
    await assert.rejects(loadInstanceConfiguration({ file }), /intervalMinutes/);
  });
});
