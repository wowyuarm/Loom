import type { InlineExtension } from "@earendil-works/pi-coding-agent";
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

export function createToolActivityExtension(
  control: TurnControl,
  ordinaryToolNames: Set<string>,
  observe: OperationalEventObserver | undefined,
  circuit: ToolErrorCircuit,
): InlineExtension {
  const calls = new Map<string, { toolName: string; args?: JsonValue; startedAt: number }>();
  return { name: "loom-tool-activity", factory: pi => {
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

function serializeValue(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
function withoutImagePixels(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(withoutImagePixels);
  if (!value || typeof value !== "object") return value;
  if (value.type === "image") return { type: "image", ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}), pixelContentOmitted: true };
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, withoutImagePixels(nested)]));
}
