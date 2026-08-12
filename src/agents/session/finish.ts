import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { WorkspaceWriteOutcome } from "../../workspace/workspace-mutation.js";

export type CognitiveOrganFinishDecision<Result> =
  | { state: "rejected"; error: string }
  | { state: "committed"; result: Result };

export interface CognitiveOrganFinishController<Result> {
  readonly tool: ToolDefinition;
  readonly result: Result | undefined;
  readonly fatalError: Error | undefined;
  readonly finished: boolean;
  acceptWrite(outcome: WorkspaceWriteOutcome): void;
  beforeToolCall(context: BeforeToolCallContext): BeforeToolCallResult | undefined;
  skipSibling(toolCallId: string): boolean;
}

type FinishPhase = "open" | "committing" | "finished" | "fatal";

/**
 * Owns the one model-visible finish capability used by every writing organ.
 * The organ supplies its completion rules and durable commit; it never owns a
 * second finish latch or publishes a result before this controller commits.
 */
export function createCognitiveOrganFinish<Result>(options: {
  organ: string;
  validateAndCommit: () => Promise<CognitiveOrganFinishDecision<Result>>;
}): CognitiveOrganFinishController<Result> {
  let phase: FinishPhase = "open";
  let result: Result | undefined;
  let fatalError: Error | undefined;
  const finishBatchSiblings = new Set<string>();

  const tool = defineTool({
    name: "finish",
    label: "Finish Cognitive Organ Run",
    description: [
      "Validate and durably commit this Cognitive Organ run.",
      "Call finish after all reads and writes are complete.",
      "A rejected finish stays in this Pi session so you can correct the run.",
    ].join(" "),
    parameters: Type.Object({}),
    executionMode: "sequential",
    execute: async () => {
      if (phase !== "open") {
        throw new Error(`Cognitive Organ finish is unavailable while the run is ${phase}`);
      }
      phase = "committing";
      let decision: CognitiveOrganFinishDecision<Result>;
      try {
        decision = await options.validateAndCommit();
      } catch (error) {
        fatalError = asError(error);
        phase = "fatal";
        throw fatalError;
      }
      if (decision.state === "rejected") {
        phase = "open";
        throw new Error(decision.error);
      }
      result = decision.result;
      phase = "finished";
      const details = {
        type: "loom.cognitive-organ-finished",
        version: 1,
        organ: options.organ,
        result,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(details) }],
        details,
        terminate: true,
      };
    },
  });

  return {
    tool,
    get result() {
      return result;
    },
    get fatalError() {
      return fatalError;
    },
    get finished() {
      return phase === "finished";
    },
    acceptWrite(outcome) {
      if (phase !== "open") {
        throw new Error(`Cognitive Organ write is unavailable while the run is ${phase}`);
      }
      if (outcome.state === "applied") return;
      if (outcome.state === "rejected") throw new Error(outcome.error);
      fatalError = new Error(outcome.error);
      phase = "fatal";
      throw fatalError;
    },
    beforeToolCall(context) {
      const calls = context.assistantMessage.content.filter(item => item.type === "toolCall");
      if (calls.some(call => call.name === "finish")) {
        for (const call of calls) {
          if (call.name !== "finish") finishBatchSiblings.add(call.id);
        }
      }
      // A sibling after finish has committed must reach the guarded wrapper so
      // it returns a terminating no-op. Blocking it here would make Pi request
      // another provider turn even though finish already succeeded.
      if (finishBatchSiblings.has(context.toolCall.id)) return undefined;
      if (phase === "fatal") {
        return { block: true, reason: "Cognitive Organ stopped after a fatal tool outcome" };
      }
      if (phase === "committing" || phase === "finished") {
        return { block: true, reason: `Cognitive Organ tools are unavailable while the run is ${phase}` };
      }
      return undefined;
    },
    skipSibling(toolCallId) {
      return finishBatchSiblings.has(toolCallId);
    },
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
