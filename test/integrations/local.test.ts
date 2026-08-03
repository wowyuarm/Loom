import assert from "node:assert/strict";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createConnection } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import {
  LOCAL_INTERACTION_ROUTE,
  openLocalInteractionChannel,
  readLocalInteractionHistory,
  sendLocalChat,
} from "../../src/integrations/local/index.js";
import type {
  InteractionViewEntry,
  InteractionViewOptions,
  InteractionViewPage,
  RuntimeInput,
  RuntimeInputOutcome,
} from "../../src/runtime/index.js";

test("uses a Unix socket as transport while history remains Harness-owned", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-local-channel-"));
  const socketPath = path.join(root, "runtime", "local.sock");
  const channel = openLocalInteractionChannel({ socketPath, waitIntervalMs: 1, waitTimeoutMs: 1_000 });
  t.after(() => channel.stop());
  const entries: InteractionViewEntry[] = [];
  const outcomes = new Map<string, RuntimeInputOutcome>();
  const acceptedInputs: RuntimeInput[] = [];
  await channel.start({
    acceptInput: async input => {
      acceptedInputs.push(input);
      const inputId = "input-1";
      entries.push({
        id: `input:${inputId}`,
        at: "2026-07-31T10:00:00.000Z",
        actorRef: "human",
        source: input.source,
        inputIds: [inputId],
        content: input.payload,
      }, {
        id: "effect:effect-1",
        at: "2026-07-31T10:00:01.000Z",
        actorRef: "individual",
        source: LOCAL_INTERACTION_ROUTE,
        inputIds: [inputId],
        content: { text: "hello from the Individual" },
      });
      outcomes.set(inputId, { state: "completed", outcome: "completed" });
      return { disposition: "accepted", inputId };
    },
    interactionView: options => interactionPage(entries, options),
    inputOutcome: inputId => outcomes.get(inputId) ?? { state: "pending" },
  });

  const chat = await sendLocalChat({ socketPath, sourceId: "local-client-1", text: "hello" });
  assert.deepEqual(acceptedInputs, [{
    source: "local",
    sourceId: "local-client-1",
    kind: "interaction",
    payload: { text: "hello" },
  }]);
  assert.deepEqual(chat, {
    inputId: "input-1",
    outcome: { state: "completed", outcome: "completed" },
    entries: [{
      id: "effect:effect-1",
      at: "2026-07-31T10:00:01.000Z",
      actorRef: "individual",
      source: "local",
      inputIds: ["input-1"],
      content: { text: "hello from the Individual" },
    }],
  });

  const history = await readLocalInteractionHistory({ socketPath, limit: 10 });
  assert.deepEqual(history.entries, entries);
  assert.equal(history.hasMore, false);
  assert.equal(channel.status().state, "listening");
  assert.deepEqual(await channel.deliver({
    attemptId: "attempt-1",
    effectId: "effect-1",
    kind: "message",
    payload: { text: "hello from the Individual" },
    routeRef: LOCAL_INTERACTION_ROUTE,
    idempotencyKey: "delivery-1",
  }), { status: "delivered", remoteId: "local:effect-1" });

  await channel.stop();
  await assert.rejects(access(socketPath));
});

test("waits without a deadline for a valid long-running Input", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-local-long-turn-"));
  const socketPath = path.join(root, "local.sock");
  const channel = openLocalInteractionChannel({
    socketPath,
    waitIntervalMs: 1,
    waitTimeoutMs: null,
  });
  t.after(() => channel.stop());
  let completed = false;
  await channel.start({
    acceptInput: async () => {
      setTimeout(() => { completed = true; }, 30);
      return { disposition: "accepted", inputId: "slow-input" };
    },
    interactionView: () => ({ entries: [], hasMore: false }),
    inputOutcome: () => completed
      ? { state: "completed", outcome: "no_reply" }
      : { state: "pending" },
  });

  const chat = await sendLocalChat({ socketPath, text: "slow but valid" });

  assert.deepEqual(chat, {
    inputId: "slow-input",
    outcome: { state: "completed", outcome: "no_reply" },
    entries: [],
  });
});

test("stops waiting when a Local client disconnects", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-local-disconnect-"));
  const socketPath = path.join(root, "local.sock");
  const channel = openLocalInteractionChannel({ socketPath, waitIntervalMs: 1 });
  t.after(() => channel.stop());
  let polls = 0;
  let resolveAccepted!: () => void;
  const accepted = new Promise<void>(resolve => { resolveAccepted = resolve; });
  await channel.start({
    acceptInput: async () => {
      resolveAccepted();
      return { disposition: "accepted", inputId: "disconnected-input" };
    },
    interactionView: () => ({ entries: [], hasMore: false }),
    inputOutcome: () => {
      polls += 1;
      return { state: "pending" };
    },
  });

  const socket = createConnection(socketPath);
  await once(socket, "connect");
  socket.write(`${JSON.stringify({
    type: "chat",
    sourceId: "disconnect-client",
    text: "accepted before disconnect",
  })}\n`);
  await accepted;
  const closed = once(socket, "close");
  socket.destroy();
  await closed;
  await delay(10);
  const pollsAfterDisconnect = polls;
  await delay(10);

  assert.equal(polls, pollsAfterDisconnect);
});

test("explains when the Local Host is unavailable instead of exposing a socket error", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "loom-local-unavailable-"));
  const socketPath = path.join(root, "local.sock");
  await writeFile(socketPath, "stale socket placeholder", "utf8");

  await assert.rejects(
    readLocalInteractionHistory({ socketPath }),
    /Loom Host is not running; start it with `loom run` before using Local chat or history/,
  );
  await assert.rejects(
    sendLocalChat({ socketPath, text: "hello" }),
    /Loom Host is not running; start it with `loom run` before using Local chat or history/,
  );
});

function interactionPage(
  entries: InteractionViewEntry[],
  options: InteractionViewOptions = {},
): InteractionViewPage {
  const after = options.after ? Number(options.after.slice(3)) : 0;
  const limit = options.limit ?? 100;
  const selected = entries.slice(after, after + limit);
  const cursor = after + selected.length;
  return {
    entries: selected,
    ...(cursor > 0 ? { cursor: `v1:${cursor}` } : {}),
    hasMore: after + selected.length < entries.length,
  };
}
