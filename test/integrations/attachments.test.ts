import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openAttachmentStore } from "../../src/integrations/attachments/index.js";

test("persists immutable attachment content across store reopen", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-attachments-"));
  const content = Buffer.from("durable image bytes", "utf8");
  const first = await openAttachmentStore({ root });

  const attachment = await first.put({
    kind: "image",
    mediaType: "image/png",
    fileName: "arrival.png",
    content,
  });

  assert.match(attachment.id, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(attachment, {
    version: 1,
    id: attachment.id,
    kind: "image",
    mediaType: "image/png",
    byteSize: content.length,
    fileName: "arrival.png",
  });

  const reopened = await openAttachmentStore({ root });
  assert.deepEqual(await reopened.read(attachment), content);

  const duplicate = await reopened.put({
    kind: "image",
    mediaType: "image/png",
    fileName: "arrival.png",
    content,
  });
  assert.equal(duplicate.id, attachment.id);
});

test("copies a retained attachment only into the Agent Workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-attachments-"));
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  const store = await openAttachmentStore({ root: path.join(root, "store") });
  const attachment = await store.put({
    kind: "file",
    mediaType: "text/plain",
    fileName: "notes.txt",
    content: Buffer.from("keep this", "utf8"),
  });

  const copied = await store.copyToWorkspace(attachment.id, {
    workspaceRoot,
    destination: "inbox/notes.txt",
  });

  assert.equal(copied, path.join(workspaceRoot, "inbox", "notes.txt"));
  assert.equal(await readFile(copied, "utf8"), "keep this");
  await assert.rejects(
    store.copyToWorkspace(attachment.id, { workspaceRoot, destination: "../outside.txt" }),
    /inside the Agent Workspace/,
  );
});

test("deletes attachment content 30 days after its last active reference ends", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-attachments-"));
  let now = new Date("2026-07-01T00:00:00.000Z");
  const store = await openAttachmentStore({ root, now: () => now });
  const attachment = await store.put({
    kind: "image",
    mediaType: "image/png",
    content: Buffer.from("temporary image", "utf8"),
  });

  now = new Date("2026-08-15T00:00:00.000Z");
  await store.reconcileRetention({ activeAttachmentIds: [attachment.id], observedAt: now });
  assert.equal((await store.read(attachment)).toString("utf8"), "temporary image");

  await store.reconcileRetention({ activeAttachmentIds: [], observedAt: now });
  now = new Date("2026-09-13T23:59:59.999Z");
  await store.reconcileRetention({ activeAttachmentIds: [], observedAt: now });
  assert.equal((await store.read(attachment)).toString("utf8"), "temporary image");

  now = new Date("2026-09-14T00:00:00.000Z");
  await store.reconcileRetention({ activeAttachmentIds: [], observedAt: now });
  await assert.rejects(store.read(attachment), /is unavailable/);
});
