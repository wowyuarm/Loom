import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { WorkspaceWriteOutcome } from "../../workspace/workspace-mutation.js";
import {
  createCognitiveOrganFinish,
  type CognitiveOrganFinishDecision,
} from "./finish.js";

/** Pi owns the model/tool loop; Loom only bounds one organ run. */
export const COGNITIVE_ORGAN_MAX_TURNS = 50;

interface NaturalCompletionOptions {
  completion: "natural";
  completeNaturally: (message: AgentMessage) => Promise<boolean> | boolean;
  incompleteReminder?: string;
}

interface FinishCompletionOptions<Result> {
  completion: "finish";
  organ: string;
  finishReminder: string;
  validateAndCommit: () => Promise<CognitiveOrganFinishDecision<Result>>;
}

export type PiCognitiveOrganSessionOptions<Result> =
  | NaturalCompletionOptions
  | FinishCompletionOptions<Result>;

export interface PiCognitiveOrganSessionResult<Result> {
  turns: number;
  result: Result | undefined;
}

export interface PiCognitiveOrganSession<Result> {
  /** Add the common finish protocol and guard every organ tool in one place. */
  bindTools(tools: ToolDefinition[]): ToolDefinition[];
  /** Consume this before a writing tool updates its receipt or local state. */
  acceptWrite(outcome: WorkspaceWriteOutcome): void;
  run(session: AgentSession, prompt: string): Promise<PiCognitiveOrganSessionResult<Result>>;
}

export class PiCognitiveOrganTurnLimitError extends Error {
  constructor() {
    super(`Cognitive Organ exceeded the ${COGNITIVE_ORGAN_MAX_TURNS}-turn Pi limit`);
    this.name = "PiCognitiveOrganTurnLimitError";
  }
}

class PiCognitiveOrganFatalError extends Error {
  constructor() {
    super("Cognitive Organ stopped after a fatal tool outcome");
    this.name = "PiCognitiveOrganFatalError";
  }
}

/**
 * Runs one Pi-native Cognitive Organ session. Writing organs share the finish
 * controller; natural organs share only the turn, reminder, and stop policy.
 */
export function createPiCognitiveOrganSession<Result = never>(
  options: PiCognitiveOrganSessionOptions<Result>,
): PiCognitiveOrganSession<Result> {
  const finish = options.completion === "finish"
    ? createCognitiveOrganFinish({
        organ: options.organ,
        validateAndCommit: options.validateAndCommit,
      })
    : undefined;

  return {
    bindTools(tools) {
      if (!finish) return tools;
      return [
        ...tools.map(tool => guardWritingTool(tool, finish)),
        finish.tool,
      ];
    },
    acceptWrite(outcome) {
      if (!finish) throw new Error("Natural Cognitive Organ sessions cannot write Workspace state");
      finish.acceptWrite(outcome);
    },
    async run(session, prompt) {
      let turns = 0;
      let naturalComplete = false;
      let turnLimit = false;
      let terminalError: Error | undefined;
      const turnLimitMessage = new PiCognitiveOrganTurnLimitError().message;
      const fatalStopMessage = new PiCognitiveOrganFatalError().message;

      const unsubscribe = session.agent.subscribe(async event => {
        if (event.type !== "turn_end" || event.message.role !== "assistant") return;
        if (event.message.errorMessage === turnLimitMessage || event.message.errorMessage === fatalStopMessage) return;
        turns += 1;
        if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
          terminalError = new Error(event.message.errorMessage ?? `Pi session stopped with ${event.message.stopReason}`);
          return;
        }
        if (finish?.finished || naturalComplete) return;
        if (event.toolResults.length === 0 && options.completion === "natural") {
          naturalComplete = await options.completeNaturally(event.message);
          if (naturalComplete) return;
        }
        if (event.toolResults.length === 0 && turns < COGNITIVE_ORGAN_MAX_TURNS) {
          session.agent.followUp({
            role: "user",
            content: [{
              type: "text",
              text: options.completion === "finish"
                ? options.finishReminder
                : options.incompleteReminder
                  ?? "This Cognitive Organ run is incomplete. Return its required terminal result before stopping.",
            }],
            timestamp: Date.now(),
          });
        }
      });

      const previousBeforeToolCall = session.agent.beforeToolCall;
      session.agent.beforeToolCall = async (context, signal) => {
        const gate = finish?.beforeToolCall(context);
        if (gate?.block) return gate;
        const prior = await previousBeforeToolCall?.(context, signal);
        if (prior?.block) return prior;
        return prior;
      };

      const previousPrepare = session.agent.prepareNextTurnWithContext;
      session.agent.prepareNextTurnWithContext = async (context, signal) => {
        if (finish?.fatalError) throw new PiCognitiveOrganFatalError();
        if (turns >= COGNITIVE_ORGAN_MAX_TURNS && !finish?.finished && !naturalComplete) {
          turnLimit = true;
          throw new PiCognitiveOrganTurnLimitError();
        }
        return previousPrepare?.(context, signal);
      };

      try {
        await session.prompt(prompt, { expandPromptTemplates: false });
      } finally {
        unsubscribe();
        if (previousBeforeToolCall) {
          session.agent.beforeToolCall = previousBeforeToolCall;
        } else {
          delete session.agent.beforeToolCall;
        }
        if (previousPrepare) {
          session.agent.prepareNextTurnWithContext = previousPrepare;
        } else {
          delete session.agent.prepareNextTurnWithContext;
        }
      }

      if (finish?.fatalError) throw finish.fatalError;
      if (turnLimit) throw new PiCognitiveOrganTurnLimitError();
      if (terminalError) throw terminalError;
      if (options.completion === "finish" && !finish?.finished) {
        throw new Error("Cognitive Organ stopped without a successful finish");
      }
      if (options.completion === "natural" && !naturalComplete) {
        throw new Error("Cognitive Organ stopped without a valid terminal result");
      }
      return { turns, result: finish?.result };
    },
  };
}

function guardWritingTool<Result>(
  tool: ToolDefinition,
  finish: ReturnType<typeof createCognitiveOrganFinish<Result>>,
): ToolDefinition {
  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal, onUpdate, context) => {
      if (finish.skipSibling(toolCallId)) {
        const details = {
          type: "loom.cognitive-organ-tool-skipped",
          version: 1,
          tool: tool.name,
          reason: "finish was requested in the same Pi turn",
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details) }],
          details,
          terminate: true,
        };
      }
      return execute(toolCallId, params, signal, onUpdate, context);
    },
  };
}

export type { CognitiveOrganFinishDecision } from "./finish.js";
