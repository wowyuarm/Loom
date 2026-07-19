import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";

import type { JsonValue, TranscriptAnchor } from "../runtime/index.js";
import { isRawCompactableToolResult } from "./tool-trace.js";

export interface ContextWindowState {
  version: 1;
  id: string;
  frozenSeed: JsonValue[];
  committedTrace: JsonValue[];
  transcriptAnchor?: TranscriptAnchor;
}

export function parseContextWindowState(value: JsonValue | undefined): ContextWindowState | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Main Agent execution state is not a Context Window");
  }
  const state = value as Record<string, JsonValue>;
  const anchor = state.transcriptAnchor;
  if (state.version !== 1
    || typeof state.id !== "string"
    || !state.id
    || !Array.isArray(state.frozenSeed)
    || !Array.isArray(state.committedTrace)
    || (anchor !== undefined && (!anchor
      || typeof anchor !== "object"
      || Array.isArray(anchor)
      || typeof anchor.sessionId !== "string"
      || !anchor.sessionId
      || typeof anchor.entryId !== "string"
      || !anchor.entryId))) {
    throw new Error("Main Agent execution state contains an invalid Context Window");
  }
  return structuredClone(value) as unknown as ContextWindowState;
}

export function serializeContextWindowState(state: ContextWindowState): JsonValue {
  return JSON.parse(JSON.stringify(state)) as JsonValue;
}

export function assertContextWindowReplacement(
  expected: ContextWindowState,
  replacement: ContextWindowState,
): void {
  if (replacement.id !== expected.id
    || !isDeepStrictEqual(replacement.frozenSeed, expected.frozenSeed)
    || !isDeepStrictEqual(replacement.transcriptAnchor, expected.transcriptAnchor)) {
    throw new Error(`Context replacement must preserve window ${expected.id} identity and anchors`);
  }
}

export function completeContextWindow(
  prepared: ContextWindowState,
  appendedTrace: JsonValue[],
  transcriptAnchor: TranscriptAnchor,
): ContextWindowState {
  if (prepared.transcriptAnchor
    && prepared.transcriptAnchor.sessionId !== transcriptAnchor.sessionId) {
    throw new Error(`Context Window ${prepared.id} cannot cross transcript sessions`);
  }
  return {
    version: 1,
    id: prepared.id,
    frozenSeed: prepared.frozenSeed,
    committedTrace: [...prepared.committedTrace, ...appendedTrace],
    transcriptAnchor,
  };
}

export const DEFAULT_CONTEXT_BUDGET = {
  hardContext: 262_000,
  normalMaterial: 150_000,
  outputReserve: 24_000,
  safetyMargin: 8_000,
  toolTraceReservation: 100_000,
} as const;

export interface ContextBudget {
  hardContext: number;
  normalMaterial: number;
  outputReserve: number;
  safetyMargin: number;
  toolTraceReservation: number;
}

export interface ContextPlanDecision {
  material: "current" | "turn-live" | "window-frozen" | "active-trace";
  unitId: string;
  action: "kept" | "dropped";
  reason: "required_current" | "protected_trace" | "within_budget" | "hard_limit" | "normal_limit";
  estimatedTokens: number;
}

export interface ContextPlanRecord {
  version: 1;
  budget: {
    hardContext: number;
    normalMaterial: number;
    outputReserve: number;
    safetyMargin: number;
    toolTraceReservation: number;
    fixedTokens: number;
    selectedMaterialTokens: number;
    estimatedContextTokens: number;
    compactionRequired: boolean;
  };
  decisions: ContextPlanDecision[];
}

export interface MaterializeTurnContextInput {
  currentInput: AgentMessage;
  turnLive: AgentMessage[];
  windowFrozen: AgentMessage[];
  committedTrace: AgentMessage[];
  fixedTokens: {
    system: number;
    toolSchemas: number;
  };
  budget?: Partial<ContextBudget>;
}

export interface MaterializedTurnContext {
  messages: AgentMessage[];
  plan: ContextPlanRecord;
}

interface PlannedUnit {
  material: ContextPlanDecision["material"];
  id: string;
  messages: AgentMessage[];
  estimatedTokens: number;
  toolInteraction: boolean;
}

export function materializeTurnContext(input: MaterializeTurnContextInput): MaterializedTurnContext {
  const budget = { ...DEFAULT_CONTEXT_BUDGET, ...input.budget };
  validateBudget(budget, input.fixedTokens);
  const fixedTokens = input.fixedTokens.system + input.fixedTokens.toolSchemas;
  const available = budget.hardContext - budget.outputReserve - budget.safetyMargin - fixedTokens;
  const currentTokens = messageTokens(input.currentInput);
  if (currentTokens > available) {
    throw new Error("Context Planner cannot fit the required current Input inside the hard context limit");
  }

  const liveUnits = messageUnits("turn-live", input.turnLive);
  const frozenUnits = messageUnits("window-frozen", input.windowFrozen);
  const traceUnits = activeTraceUnits(input.committedTrace);
  const selected = new Set<string>();
  const decisions: ContextPlanDecision[] = [{
    material: "current",
    unitId: "current:pending",
    action: "kept",
    reason: "required_current",
    estimatedTokens: currentTokens,
  }];
  let selectedMaterialTokens = currentTokens;
  let traceExhausted = false;

  for (const unit of [...traceUnits].reverse()) {
    if (traceExhausted || selectedMaterialTokens + unit.estimatedTokens > available) {
      traceExhausted = true;
      decide(unit, "dropped", "hard_limit");
      continue;
    }
    selected.add(unit.id);
    selectedMaterialTokens += unit.estimatedTokens;
    decide(unit, "kept", "protected_trace");
  }

  for (const units of [liveUnits, frozenUnits]) {
    for (const unit of [...units].reverse()) {
      if (selectedMaterialTokens + unit.estimatedTokens > available) {
        decide(unit, "dropped", "hard_limit");
      } else if (selectedMaterialTokens + unit.estimatedTokens > budget.normalMaterial) {
        decide(unit, "dropped", "normal_limit");
      } else {
        selected.add(unit.id);
        selectedMaterialTokens += unit.estimatedTokens;
        decide(unit, "kept", "within_budget");
      }
    }
  }

  const orderedUnits = [...liveUnits, ...frozenUnits, ...traceUnits];
  const messages = orderedUnits.filter(unit => selected.has(unit.id)).flatMap(unit => unit.messages);
  const toolTraceTokens = traceUnits
    .filter(unit => unit.toolInteraction)
    .reduce((total, unit) => total + unit.estimatedTokens, 0);
  return {
    messages,
    plan: {
      version: 1,
      budget: {
        ...budget,
        fixedTokens,
        selectedMaterialTokens,
        estimatedContextTokens: fixedTokens + selectedMaterialTokens,
        compactionRequired: toolTraceTokens >= budget.toolTraceReservation,
      },
      decisions,
    },
  };

  function decide(
    unit: PlannedUnit,
    action: ContextPlanDecision["action"],
    reason: ContextPlanDecision["reason"],
  ): void {
    decisions.push({
      material: unit.material,
      unitId: unit.id,
      action,
      reason,
      estimatedTokens: unit.estimatedTokens,
    });
  }
}

function messageTokens(message: AgentMessage): number {
  return Math.max(0, estimateTokens(message));
}

function validateBudget(budget: ContextBudget, fixed: MaterializeTurnContextInput["fixedTokens"]): void {
  for (const value of [...Object.values(budget), fixed.system, fixed.toolSchemas]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Context Planner budgets must be finite non-negative numbers");
    }
  }
}

function messageUnits(
  material: "turn-live" | "window-frozen",
  messages: AgentMessage[],
): PlannedUnit[] {
  return messages.map((message, index) => ({
    material,
    id: `${material}:${index}-${index}`,
    messages: [message],
    estimatedTokens: messageTokens(message),
    toolInteraction: false,
  }));
}

function activeTraceUnits(messages: AgentMessage[]): PlannedUnit[] {
  const units: PlannedUnit[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const callIds = toolCallIds(message);
    if (callIds.length === 0) {
      if (toolResultId(message)) {
        throw new Error("Context Window contains a tool result without its assistant call");
      }
      units.push(traceUnit(index, index, [message], false));
      continue;
    }

    const pending = new Set(callIds);
    const interaction = [message];
    let end = index;
    while (pending.size > 0) {
      end += 1;
      const result = messages[end];
      const resultId = result && toolResultId(result);
      if (!result || !resultId || !pending.delete(resultId)) {
        throw new Error(`Context Window contains an incomplete tool interaction ${[...pending].join(", ")}`);
      }
      interaction.push(result);
    }
    units.push(traceUnit(index, end, interaction, interaction.some(isRawCompactableToolResult)));
    index = end;
  }
  return units;
}

function traceUnit(
  start: number,
  end: number,
  messages: AgentMessage[],
  toolInteraction: boolean,
): PlannedUnit {
  return {
    material: "active-trace",
    id: `active-trace:${start}-${end}`,
    messages,
    estimatedTokens: messages.reduce((total, message) => total + messageTokens(message), 0),
    toolInteraction,
  };
}

function toolCallIds(message: AgentMessage): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.flatMap(block => block.type === "toolCall" && typeof block.id === "string" ? [block.id] : []);
}

function toolResultId(message: AgentMessage): string | undefined {
  return message.role === "toolResult" && typeof message.toolCallId === "string"
    ? message.toolCallId
    : undefined;
}
