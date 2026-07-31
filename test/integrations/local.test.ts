import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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
        actor: "human",
        source: input.source,
        inputIds: [inputId],
        content: input.payload,
      }, {
        id: "effect:effect-1",
        at: "2026-07-31T10:00:01.000Z",
        actor: "individual",
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
      actor: "individual",
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
