import assert from "node:assert/strict";
import test from "node:test";

import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";

import { createCognitiveOrganFinish } from "../../src/agents/session/finish.js";

test("does not publish a finished result when durable commit fails", async () => {
  const finish = createCognitiveOrganFinish<{ outcome: "updated" }>({
    organ: "test-organ",
    validateAndCommit: async () => {
      throw new Error("durable commit failed");
    },
  });

  await assert.rejects(finish.tool.execute("finish-1", {}, undefined, undefined, {} as never), /durable commit failed/);
  assert.equal(finish.finished, false);
  assert.equal(finish.result, undefined);
  assert.match(finish.fatalError?.message ?? "", /durable commit failed/);
  assert.deepEqual(finish.beforeToolCall(toolContext("read", ["read"])), {
    block: true,
    reason: "Cognitive Organ stopped after a fatal tool outcome",
  });
});

test("keeps a rejected finish open and latches the first committed result", async () => {
  let attempts = 0;
  const finish = createCognitiveOrganFinish<{ outcome: "no_change" }>({
    organ: "test-organ",
    validateAndCommit: async () => {
      attempts += 1;
      return attempts === 1
        ? { state: "rejected", error: "read the missing evidence" }
        : { state: "committed", result: { outcome: "no_change" } };
    },
  });

  await assert.rejects(finish.tool.execute("finish-1", {}, undefined, undefined, {} as never), /read the missing evidence/);
  assert.equal(finish.finished, false);
  const committed = await finish.tool.execute("finish-2", {}, undefined, undefined, {} as never);
  assert.equal(committed.terminate, true);
  assert.equal(finish.finished, true);
  assert.deepEqual(finish.result, { outcome: "no_change" });
  await assert.rejects(finish.tool.execute("finish-3", {}, undefined, undefined, {} as never), /already|unavailable|finished/i);
  assert.equal(attempts, 2);
});

test("rejected writes remain correctable while uncertain writes make finish fatal", async () => {
  const correctable = createCognitiveOrganFinish<{ outcome: "no_change" }>({
    organ: "test-organ",
    validateAndCommit: async () => ({ state: "committed", result: { outcome: "no_change" } }),
  });
  assert.throws(
    () => correctable.acceptWrite({ state: "rejected", error: "trim one byte" }),
    /trim one byte/,
  );
  await correctable.tool.execute("finish-after-rejection", {}, undefined, undefined, {} as never);
  assert.equal(correctable.finished, true);

  const fatal = createCognitiveOrganFinish<{ outcome: "no_change" }>({
    organ: "test-organ",
    validateAndCommit: async () => ({ state: "committed", result: { outcome: "no_change" } }),
  });
  assert.throws(
    () => fatal.acceptWrite({ state: "uncertain", error: "rename outcome unknown" }),
    /rename outcome unknown/,
  );
  await assert.rejects(
    fatal.tool.execute("finish-after-uncertain", {}, undefined, undefined, {} as never),
    /fatal|unavailable/i,
  );
  assert.equal(fatal.finished, false);
});

function toolContext(name: string, names: string[]): BeforeToolCallContext {
  return {
    assistantMessage: {
      role: "assistant",
      content: names.map((toolName, index) => ({
        type: "toolCall" as const,
        id: `tool-${index}`,
        name: toolName,
        arguments: {},
      })),
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 0,
    },
    toolCall: {
      type: "toolCall",
      id: "current-tool",
      name,
      arguments: {},
    },
    args: {},
    context: {
      systemPrompt: "",
      messages: [],
      tools: [],
    },
  };
}
