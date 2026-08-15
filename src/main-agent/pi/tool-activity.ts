import { estimateTokens, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { JsonValue, TurnControl } from "../../runtime/index.js";
import { emitOperationalEvent, operationalTimestamp, type OperationalEventObserver } from "../../operational-events.js";

const MAX_CONSECUTIVE_TOOL_ERRORS = 5;

export interface ToolErrorCircuit {
  consecutiveErrors: number;
  opened: boolean;
  lastFailedTool?: string;
  lastFailedToolCallId?: string;
  openedAtConsecutiveErrors?: number;
}

/**
 * The Context Planner only runs before a Turn starts.  Pi appends tool calls
 * and their results between provider requests, so retain a separate latch for
 * the live part of that same Turn.
 */
export interface ContextLimitCircuit {
  opened: boolean;
  estimatedTokens?: number;
  limit?: number;
}

export function createToolActivityExtension(
  control: TurnControl,
  ordinaryToolNames: Set<string>,
  observe: OperationalEventObserver | undefined,
  circuit: ToolErrorCircuit,
  contextLimitCircuit: ContextLimitCircuit,
): InlineExtension {
  const calls = new Map<string, { toolName: string; args?: JsonValue; startedAt: number }>();
  return { name: "loom-tool-activity", factory: pi => {
    pi.on("context", (event, ctx) => {
      // An abort is advisory to providers.  A provider can still return a
      // tool call, causing Pi to attempt another request.  Once this guard
      // opens, every such request must receive the bounded stop context.
      if (contextLimitCircuit.opened) return stoppedContext();
      const limit = contextLimitCircuit.limit;
      if (limit === undefined) return;
      const estimatedTokens = event.messages.reduce((total, message) => total + estimateTokens(message), 0);
      if (estimatedTokens <= limit) return;
      contextLimitCircuit.opened = true;
      contextLimitCircuit.estimatedTokens = estimatedTokens;
      ctx.abort();
      // Pi's extension API does not propagate an exception from this hook to
      // the agent loop.  Replace the provider context as well as aborting so
      // a provider that starts despite the already-aborted signal never sees
      // the over-limit tool trace.
      return stoppedContext();
    });
    pi.on("tool_execution_start", event => {
      calls.set(event.toolCallId, { toolName: event.toolName, startedAt: performance.now(),
        ...(ordinaryToolNames.has(event.toolName) ? { args: serializeValue(event.args) } : {}) });
      emitOperationalEvent(observe, { event: "agent.tool.started", at: operationalTimestamp(), toolCallId: event.toolCallId, toolName: event.toolName });
    });
    pi.on("tool_execution_end", (event, ctx) => {
      const call = calls.get(event.toolCallId); calls.delete(event.toolCallId); if (!call) return;
      const failed = event.isError || event.toolName !== call.toolName;
      if (failed && !circuit.opened) {
        circuit.consecutiveErrors += 1; circuit.lastFailedTool = event.toolName; circuit.lastFailedToolCallId = event.toolCallId;
        if (circuit.consecutiveErrors >= MAX_CONSECUTIVE_TOOL_ERRORS) {
          circuit.opened = true; circuit.openedAtConsecutiveErrors = circuit.consecutiveErrors;
          emitOperationalEvent(observe, { event: "agent.tool.error-circuit-opened", at: operationalTimestamp(), toolCallId: event.toolCallId, toolName: event.toolName, consecutiveErrors: circuit.consecutiveErrors });
          ctx.abort(); return;
        }
      } else if (!failed && !circuit.opened) { circuit.consecutiveErrors = 0; delete circuit.lastFailedTool; delete circuit.lastFailedToolCallId; }
      emitOperationalEvent(observe, { event: "agent.tool.completed", at: operationalTimestamp(), toolCallId: event.toolCallId, toolName: event.toolName, durationMs: Math.round(Math.max(0, performance.now() - call.startedAt)), status: failed ? "error" : "ok" });
      if (!failed && call.args !== undefined) control.recordToolActivity({ toolCallId: event.toolCallId, toolName: event.toolName, callArguments: call.args, result: withoutImagePixels(serializeValue(event.result)) });
    });
  } };
}

function stoppedContext() {
  return {
    messages: [{
      role: "user" as const,
      content: [{ type: "text" as const, text: "This Turn has exceeded Loom's context budget and is stopping." }],
      timestamp: Date.now(),
    }],
  };
}

function serializeValue(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }

export function withoutImagePixels(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(withoutImagePixels);
  if (!value || typeof value !== "object") return value;
  if (value.type === "image") return { type: "image", ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}), pixelContentOmitted: true };
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, withoutImagePixels(nested)]));
}
