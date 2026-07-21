import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadDailyContext } from "../../src/main-agent/daily-context.js";
import { AgentWorkspace } from "../../src/workspace/agent-workspace.js";

test("keeps the previous Daily when the current logical day has no narrative", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-daily-context-"));
  await mkdir(path.join(root, "daily"), { recursive: true });
  await writeFile(
    path.join(root, "daily", "2026-07-18.md"),
    "# 2026-07-18\n\nprevious narrative\n",
    "utf8",
  );

  const message = await loadDailyContext(new AgentWorkspace(root), "2026-07-19");
  assert.ok(message?.role === "user");
  assert.ok(Array.isArray(message.content));
  const text = message.content.find(block => block.type === "text")?.text ?? "";
  assert.match(text, /logical_date="2026-07-18"[\s\S]*previous narrative/);
  assert.match(text, /logical_date="2026-07-19" status="not_recorded"/);
});

test("omits Daily Context when neither logical day has a narrative", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-daily-context-empty-"));
  assert.equal(await loadDailyContext(new AgentWorkspace(root), "2026-07-19"), undefined);
});
