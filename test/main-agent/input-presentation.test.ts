import assert from "node:assert/strict";
import test from "node:test";

import { presentInput } from "../../src/main-agent/pi/input.js";
import type { ExecutionInput } from "../../src/runtime/index.js";

function interactionInput(overrides: Partial<ExecutionInput> = {}): ExecutionInput {
  return {
    id: "input-1",
    kind: "interaction",
    payload: { text: "好多呢" },
    occurredAt: "2026-09-03T01:32:03.000Z",
    inclusionPosition: 2,
    interaction: {
      routeRef: "weixin-primary",
      signal: "direct_message",
      actor: { kind: "human", actorRef: "human" },
      place: { kind: "direct", placeRef: "weixin:place:1", visibility: "private" },
      audience: { visibility: "private", description: "private conversation" },
      references: [],
      destinations: [{
        destinationRef: "weixin:destination:1",
        routeRef: "weixin-primary",
        kind: "top_level",
      }],
    },
    ...overrides,
  };
}

test("annotates a late-steered input with re-evaluation and undelivered-text guidance", async () => {
  const presentation = await presentInput(
    interactionInput({ lateSteered: true }),
    {},
    undefined,
    true,
  );
  assert.match(presentation.text, /arrived after your previous user message but before the final reply was committed/);
  assert.match(presentation.text, /Re-evaluate the current reply with this message included/);
  assert.match(presentation.text, /its text was never delivered and the human has not seen it/);
});

test("omits the late-steered guidance from an ordinarily presented input", async () => {
  const presentation = await presentInput(interactionInput(), {}, undefined, true);
  assert.doesNotMatch(presentation.text, /never delivered/);
  assert.doesNotMatch(presentation.text, /Re-evaluate the current reply/);
});
