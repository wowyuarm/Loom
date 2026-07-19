import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { materializeTurnContext } from "../../src/agent-execution/context.js";

test("rejects a required current Input that cannot fit the hard context limit", () => {
  assert.throws(() => materializeTurnContext({
    currentInput: userMessage("x".repeat(1_000)),
    turnLive: [],
    windowFrozen: [],
    committedTrace: [],
    fixedTokens: { system: 0, toolSchemas: 0 },
    budget: {
      hardContext: 40,
      normalMaterial: 20,
      outputReserve: 10,
      safetyMargin: 0,
      toolTraceReservation: 20,
    },
  }), /required current Input/i);
});

test("drops an over-limit tool call and result as one complete trace unit", () => {
  const toolCall = fauxAssistantMessage(
    fauxToolCall("read", { path: "x".repeat(1_000) }, { id: "call-1" }),
    { stopReason: "toolUse", timestamp: 2 },
  );
  const toolResult = {
    role: "toolResult" as const,
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text" as const, text: "y".repeat(1_000) }],
    isError: false,
    timestamp: 3,
  };
  const result = materializeTurnContext({
    currentInput: userMessage("current"),
    turnLive: [],
    windowFrozen: [],
    committedTrace: [
      userMessage("older message"),
      toolCall,
      toolResult,
      userMessage("newest message"),
    ],
    fixedTokens: { system: 0, toolSchemas: 0 },
    budget: {
      hardContext: 80,
      normalMaterial: 40,
      outputReserve: 10,
      safetyMargin: 0,
      toolTraceReservation: 50,
    },
  });

  const text = result.messages.map(message => JSON.stringify(message)).join("\n");
  assert.match(text, /newest message/);
  assert.doesNotMatch(text, /older message/);
  assert.doesNotMatch(text, /call-1/);
  assert.deepEqual(result.plan.decisions
    .filter(decision => decision.material === "active-trace")
    .map(({ estimatedTokens: _estimatedTokens, ...decision }) => decision), [
    {
      material: "active-trace",
      unitId: "active-trace:3-3",
      action: "kept",
      reason: "protected_trace",
    },
    {
      material: "active-trace",
      unitId: "active-trace:1-2",
      action: "dropped",
      reason: "hard_limit",
    },
    {
      material: "active-trace",
      unitId: "active-trace:0-0",
      action: "dropped",
      reason: "hard_limit",
    },
  ]);
});

test("keeps the planning record free of message content", () => {
  const result = materializeTurnContext({
    currentInput: userMessage("secret current"),
    turnLive: [userMessage("secret live")],
    windowFrozen: [userMessage("secret frozen")],
    committedTrace: [userMessage("secret trace")],
    fixedTokens: { system: 2, toolSchemas: 3 },
  });

  const record = JSON.stringify(result.plan);
  assert.doesNotMatch(record, /secret/);
  assert.match(record, /current:pending/);
  assert.match(record, /selectedMaterialTokens/);
});

function userMessage(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: 0,
  };
}
