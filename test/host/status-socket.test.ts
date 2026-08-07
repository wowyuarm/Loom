import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createLoomStatusServer } from "../../src/host/status-socket.js";

test("status socket sanitizes non-recovery failures and surfaces recovery errors", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-status-socket-sanitize-"));
  const server = createLoomStatusServer({
    socketPath: path.join(root, "status.sock"),
    read() {
      throw new Error("boom: raw provider detail");
    },
    requeueInput() {
      throw new Error("boom: Input is not blocked");
    },
    requeueCognitiveOrganWork() {
      throw new Error("boom: work is held");
    },
    retryChannelIngress: async () => 0,
    interactionView() {
      throw new Error("boom: raw history detail");
    },
  });
  await server.start();
  t.after(() => server.stop());

  // Status and history keep the stable generic failure; the raw internals
  // never reach the caller.
  const status = await send(path.join(root, "status.sock"), { type: "status" });
  assert.equal(status.ok, false);
  assert.equal(status.error, "Loom status is unavailable");
  assert.doesNotMatch(status.error!, /boom|provider|detail/);
  const history = await send(path.join(root, "status.sock"), { type: "history" });
  assert.equal(history.ok, false);
  assert.equal(history.error, "Loom status is unavailable");
  assert.doesNotMatch(history.error!, /boom|raw/);

  // Explicit recovery commands surface their operation error so rejections
  // stay distinguishable.
  const input = await send(path.join(root, "status.sock"), { type: "requeue_input", inputId: "input-1" });
  assert.equal(input.ok, false);
  assert.equal(input.error, "boom: Input is not blocked");
  const organ = await send(path.join(root, "status.sock"), {
    type: "requeue_cognitive_organ",
    workId: "attention-maintainer-1",
  });
  assert.equal(organ.ok, false);
  assert.equal(organ.error, "boom: work is held");
});

function send(socketPath: string, request: unknown): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.once("error", reject);
    socket.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)) as { ok: boolean; error?: string });
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
}
