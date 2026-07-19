import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  verifyPrimaryTranscriptEntry,
  verifyPrimaryTranscriptEvidence,
} from "../../src/main-agent/transcript.js";

test("verifies an entry on the selected continuous transcript branch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-transcript-"));
  const transcriptFile = path.join(root, "agent.jsonl");
  await writeFile(transcriptFile, [
    JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-07-18T00:00:00.000Z", cwd: root }),
    JSON.stringify({ type: "custom", customType: "loom.input.v1", data: { inputId: "input-1" }, id: "annotation-1", parentId: null, timestamp: "2026-07-18T00:00:01.000Z" }),
    JSON.stringify({ type: "message", id: "user-1", parentId: "annotation-1", timestamp: "2026-07-18T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } }),
    JSON.stringify({ type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-07-18T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 } }),
    "",
  ].join("\n"), "utf8");

  assert.deepEqual(await verifyPrimaryTranscriptEntry({
    transcriptFile,
    sessionId: "session-1",
    entryId: "assistant-1",
  }), {
    sessionId: "session-1",
    entryId: "assistant-1",
  });
});

test("rejects Turn evidence with an incomplete tool interaction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-transcript-"));
  const transcriptFile = path.join(root, "agent.jsonl");
  await writeFile(transcriptFile, [
    JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-07-18T00:00:00.000Z", cwd: root }),
    JSON.stringify({ type: "custom", customType: "loom.input.v1", data: { inputId: "input-1" }, id: "annotation-1", parentId: null, timestamp: "2026-07-18T00:00:01.000Z" }),
    JSON.stringify({ type: "message", id: "user-1", parentId: "annotation-1", timestamp: "2026-07-18T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } }),
    JSON.stringify({ type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-07-18T00:00:03.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "note.md" } }], stopReason: "toolUse", timestamp: 2 } }),
    "",
  ].join("\n"), "utf8");

  await assert.rejects(verifyPrimaryTranscriptEvidence({
    transcriptFile,
    sessionId: "session-1",
    inputs: [{ inputId: "input-1", annotationEntryId: "annotation-1" }],
  }), /incomplete tool interaction/);
});
