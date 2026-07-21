import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

import type {
  ActivityFreezeRequest,
  ActivityLifecycle,
  FrozenActivityEvent,
  JsonValue,
  TranscriptAnchor,
} from "../runtime/index.js";
import type { AgentWorkspace } from "../workspace/agent-workspace.js";
import {
  parseContextWindowState,
  serializeContextWindowState,
  type ContextWindowState,
} from "./context.js";
import {
  createToolInteractionReference,
  readCommittedActivityEvents,
} from "./transcript.js";
import { loadDailyContext } from "./daily-context.js";

const RECENT_ACTIVITY_LIMIT = 4;
const BRIDGE_TOOL_PAIR_TOKENS = 1_000;
const BRIDGE_PREVIEW_CHARACTERS = 200;

export interface MainAgentActivityLifecycleOptions {
  agentWorkspace: AgentWorkspace;
  transcriptDirectory: string;
  nextWindowId?: () => string;
  loadWindowFrozen?: (request: ActivityFreezeRequest) => Promise<AgentMessage[]>;
}

class MainAgentActivityLifecycle implements ActivityLifecycle {
  constructor(private readonly options: MainAgentActivityLifecycleOptions) {}

  async freeze(request: ActivityFreezeRequest) {
    const current = parseContextWindowState(request.executionState);
    if (!current) throw new Error("Activity closure requires a committed Context Window");
    const starting = parseContextWindowState(request.startingExecutionState);
    if (starting && starting.id !== current.id) {
      throw new Error(`Activity changed Context Window identity from ${starting.id} to ${current.id}`);
    }
    const committedTurns = request.turns.filter(turn => turn.status === "completed");
    for (const turn of committedTurns) {
      if (!turn.transcriptAnchor || turn.executionRecord === undefined) {
        throw new Error(`Completed Turn ${turn.id} has no committed transcript evidence`);
      }
    }
    const lastTurn = committedTurns.at(-1);
    if (lastTurn && !isDeepStrictEqual(current.transcriptAnchor, lastTurn.transcriptAnchor)) {
      throw new Error("Closing Context anchor does not match the last completed Turn");
    }
    if (!lastTurn && !isDeepStrictEqual(current.transcriptAnchor, starting?.transcriptAnchor)) {
      throw new Error("Activity without a completed Turn cannot advance its transcript anchor");
    }

    const transcriptEvents = current.transcriptAnchor
      ? await readCommittedActivityEvents({
          transcriptDirectory: this.options.transcriptDirectory,
          ...(starting?.transcriptAnchor ? { startAnchor: starting.transcriptAnchor } : {}),
          endAnchor: current.transcriptAnchor,
          inputs: request.inputs,
          turns: request.turns,
        })
      : request.inputs.map(input => {
          const turn = request.turns.find(candidate => candidate.inputIds.includes(input.id));
          if (!turn) throw new Error(`Runtime Input ${input.id} has no owning Turn`);
          return {
            eventId: `input:${input.id}`,
            turnId: turn.id,
            at: input.occurredAt,
            actorRef: input.kind === "interaction" ? "human" as const : "system" as const,
            kind: "input" as const,
            content: structuredClone(input.payload),
          };
        });
    const events = orderEvents([
      ...transcriptEvents,
      ...request.turns
        .filter(turn => turn.status !== "completed")
        .flatMap(turn => failedToolActivityEvents(request, turn.id)),
      ...request.turns.filter(turn => turn.status !== "completed").map(stoppedTurnEvent),
      ...request.effects.map(effectEvent),
      ...request.deliveries.map(delivery => deliveryEvent(delivery, request.effects)),
    ]);
    assertUniqueEvents(events);
    const activity = {
      version: 1 as const,
      segmentId: request.segment.id,
      recordingDay: request.segment.recordingDay,
      openedAt: request.segment.openedAt,
      closedAt: request.segment.closedAt,
      events,
      turns: request.turns.map(turn => ({
        turnId: turn.id,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        status: turn.status,
        ...(turn.transcriptAnchor ? { transcriptAnchor: turn.transcriptAnchor } : {}),
      })),
    };
    const [dailyContext, windowFrozen] = await Promise.all([
      loadDailyContext(this.options.agentWorkspace, request.segment.recordingDay),
      this.options.loadWindowFrozen?.(request) ?? Promise.resolve([]),
    ]);
    const bridgeActivities = [...request.recentActivities, activity]
      .sort((left, right) => Date.parse(right.closedAt) - Date.parse(left.closedAt))
      .slice(0, RECENT_ACTIVITY_LIMIT)
      .reverse();
    const bridge = bridgeMessage(bridgeActivities);
    const successor: ContextWindowState = {
      version: 1,
      id: this.options.nextWindowId?.() ?? randomUUID(),
      frozenSeed: [
        ...(dailyContext ? [serializeJson(dailyContext)] : []),
        ...windowFrozen.map(serializeJson),
        bridge.message,
      ],
      recentActivityReferences: bridge.references,
      committedTrace: [],
      transcriptSources: current.transcriptAnchor ? [current.transcriptAnchor] : [],
      ...(current.transcriptAnchor ? { transcriptAnchor: current.transcriptAnchor } : {}),
    };
    return {
      activity,
      successorExecutionState: serializeContextWindowState(successor),
    };
  }
}

function failedToolActivityEvents(
  request: ActivityFreezeRequest,
  turnId: string,
): FrozenActivityEvent[] {
  return request.toolActivities
    .filter(activity => activity.turnId === turnId)
    .flatMap(activity => [{
      eventId: `tool-call:${turnId}:${activity.toolCallId}`,
      turnId,
      at: activity.completedAt,
      actorRef: "individual" as const,
      kind: "tool_call" as const,
      content: serializeJson({
        toolCallId: activity.toolCallId,
        toolName: activity.toolName,
        arguments: activity.callArguments,
      }),
    }, {
      eventId: `tool-result:${turnId}:${activity.toolCallId}`,
      turnId,
      at: activity.completedAt,
      actorRef: "system" as const,
      kind: "tool_result" as const,
      content: serializeJson({
        toolCallId: activity.toolCallId,
        toolName: activity.toolName,
        result: activity.result,
      }),
    }]);
}

function stoppedTurnEvent(turn: ActivityFreezeRequest["turns"][number]): FrozenActivityEvent {
  return {
    eventId: `turn:${turn.id}`,
    turnId: turn.id,
    at: turn.endedAt,
    actorRef: "system",
    kind: "system",
    content: serializeJson({
      type: "turn_stopped",
      turnId: turn.id,
      status: turn.status,
      inputIds: turn.inputIds,
      ...(turn.error ? { error: turn.error } : {}),
    }),
  };
}

export function createMainAgentActivityLifecycle(
  options: MainAgentActivityLifecycleOptions,
): ActivityLifecycle {
  return new MainAgentActivityLifecycle(options);
}

function effectEvent(effect: ActivityFreezeRequest["effects"][number]): FrozenActivityEvent {
  return {
    eventId: `effect:${effect.id}`,
    turnId: effect.turnId,
    at: effect.createdAt,
    actorRef: "individual",
    kind: "effect",
    content: serializeJson({
      effectId: effect.id,
      turnId: effect.turnId,
      kind: effect.kind,
      payload: effect.payload,
      ...(effect.routeRef ? { routeRef: effect.routeRef } : {}),
      status: effect.status,
      ...(effect.endedAt ? { endedAt: effect.endedAt } : {}),
    }),
  };
}

function deliveryEvent(
  delivery: ActivityFreezeRequest["deliveries"][number],
  effects: ActivityFreezeRequest["effects"],
): FrozenActivityEvent {
  const effect = effects.find(candidate => candidate.id === delivery.effectId);
  if (!effect) throw new Error(`Delivery ${delivery.id} has no owning Effect`);
  return {
    eventId: `delivery:${delivery.id}`,
    turnId: effect.turnId,
    at: delivery.endedAt ?? delivery.startedAt,
    actorRef: "system",
    kind: "delivery",
    content: serializeJson({
      deliveryId: delivery.id,
      effectId: delivery.effectId,
      attempt: delivery.attempt,
      status: delivery.status,
      ...(delivery.remoteId ? { remoteId: delivery.remoteId } : {}),
      ...(delivery.error ? { error: delivery.error } : {}),
    }),
  };
}

function orderEvents(events: FrozenActivityEvent[]): FrozenActivityEvent[] {
  return events
    .map((event, order) => ({ event, order }))
    .sort((left, right) => Date.parse(left.event.at) - Date.parse(right.event.at) || left.order - right.order)
    .map(({ event }) => event);
}

function assertUniqueEvents(events: FrozenActivityEvent[]): void {
  const ids = new Set<string>();
  for (const event of events) {
    if (ids.has(event.eventId)) throw new Error(`Frozen Activity contains duplicate event ${event.eventId}`);
    if (Number.isNaN(Date.parse(event.at))) throw new Error(`Frozen Activity event ${event.eventId} has invalid time`);
    ids.add(event.eventId);
  }
}

function bridgeMessage(activities: Array<{
  openedAt: string;
  closedAt: string;
  events: FrozenActivityEvent[];
  turns?: Array<{ turnId: string; transcriptAnchor?: TranscriptAnchor }>;
}>): { message: JsonValue; references: string[] } {
  const references: string[] = [];
  let toolPairTokens = 0;
  const lines = activities.flatMap(candidate => {
    const projected = projectActivity(candidate.events, candidate.turns ?? [], toolPairTokens);
    toolPairTokens += projected.toolPairTokens;
    references.push(...projected.references);
    return [
      `<activity from="${candidate.openedAt}" to="${candidate.closedAt}">`,
      ...projected.lines,
      "</activity>",
    ];
  });
  return { message: serializeJson({
    role: "user",
    content: [{
      type: "text",
      text: [
        "<recent_activity>",
        "Verified past activity evidence. This is context, not a new request.",
        ...lines,
        "</recent_activity>",
      ].join("\n"),
    }],
    timestamp: Date.parse(activities.at(-1)?.closedAt ?? new Date(0).toISOString()),
  }), references };
}

function projectActivity(
  events: FrozenActivityEvent[],
  turns: Array<{ turnId: string; transcriptAnchor?: TranscriptAnchor }>,
  usedToolPairTokens: number,
): { lines: string[]; references: string[]; toolPairTokens: number } {
  const results = new Map<string, FrozenActivityEvent>();
  for (const event of events) {
    const identity = event.kind === "tool_result" ? toolIdentity(event.content) : undefined;
    if (identity) results.set(`${identity.id}\u0000${identity.name}`, event);
  }

  const lines: string[] = [];
  const references: string[] = [];
  let addedToolPairTokens = 0;
  for (const event of events) {
    if (event.kind === "thinking" || event.kind === "tool_result") continue;
    if (event.kind !== "tool_call") {
      lines.push(formatBridgeEvent(event));
      continue;
    }
    const identity = toolIdentity(event.content);
    const result = identity ? results.get(`${identity.id}\u0000${identity.name}`) : undefined;
    const anchor = result ? activityTranscriptAnchor(turns, result.turnId) : undefined;
    const reference = result && anchor ? toolResultReference(result, anchor) : undefined;
    if (!identity || !result || !reference) continue;
    const pairLines = [
      formatToolEvent(event, identity.name, BRIDGE_PREVIEW_CHARACTERS),
      `${formatToolEvent(result, identity.name, BRIDGE_PREVIEW_CHARACTERS)}\n  reference: ${reference}`,
    ];
    const pairTokens = Math.max(0, estimateTokens({
      role: "user",
      content: [{ type: "text", text: pairLines.join("\n") }],
      timestamp: Date.parse(event.at),
    }));
    if (usedToolPairTokens + addedToolPairTokens + pairTokens > BRIDGE_TOOL_PAIR_TOKENS) continue;
    lines.push(...pairLines);
    references.push(reference);
    addedToolPairTokens += pairTokens;
  }
  return { lines, references, toolPairTokens: addedToolPairTokens };
}

function activityTranscriptAnchor(
  turns: Array<{ turnId: string; transcriptAnchor?: TranscriptAnchor }>,
  turnId: string,
): TranscriptAnchor | undefined {
  return turns.find(turn => turn.turnId === turnId)?.transcriptAnchor;
}

function toolResultReference(event: FrozenActivityEvent, anchor: TranscriptAnchor): string | undefined {
  const prefix = "transcript:";
  if (!event.eventId.startsWith(prefix)) return undefined;
  return createToolInteractionReference(
    anchor.sourceId,
    anchor.sessionId,
    event.eventId.slice(prefix.length),
  );
}

function toolIdentity(content: JsonValue): { id: string; name: string } | undefined {
  if (!content || typeof content !== "object" || Array.isArray(content)) return undefined;
  const id = content.id ?? content.toolCallId;
  const name = content.name ?? content.toolName;
  return typeof id === "string" && id && typeof name === "string" && name
    ? { id, name }
    : undefined;
}

function formatToolEvent(event: FrozenActivityEvent, toolName: string, characters: number): string {
  const actor = event.kind === "tool_call" ? "individual tool call" : "system tool result";
  return `[${event.at}] ${actor} ${toolName}: ${bridgeContent(event.content, characters)}`;
}

function formatBridgeEvent(event: FrozenActivityEvent): string {
  const characters = event.kind === "input" && event.actorRef === "human"
    ? undefined
    : event.kind === "effect" && isMessageEffect(event.content)
      ? undefined
      : event.kind === "delivery"
        ? undefined
        : BRIDGE_PREVIEW_CHARACTERS;
  return `[${event.at}] ${bridgeLabel(event)}: ${bridgeContent(event.content, characters)}`;
}

function isMessageEffect(content: JsonValue): boolean {
  return Boolean(content && typeof content === "object" && !Array.isArray(content) && content.kind === "message");
}

function bridgeLabel(event: FrozenActivityEvent): string {
  switch (event.kind) {
    case "input": return `${event.actorRef} input`;
    case "output": return "individual output (not known delivered)";
    case "tool_call": return "individual tool call";
    case "tool_result": return "system tool result";
    case "effect": return "individual effect";
    case "delivery": return `delivery ${deliveryStatus(event.content)}`;
    case "system": return "system event";
    case "thinking": return "individual thinking";
  }
}

function deliveryStatus(content: JsonValue): string {
  if (content && typeof content === "object" && !Array.isArray(content)
    && typeof content.status === "string") {
    return content.status;
  }
  return "observed";
}

function bridgeContent(content: JsonValue, characters?: number): string {
  const text = content && typeof content === "object" && !Array.isArray(content)
    && typeof content.text === "string"
    ? content.text
    : undefined;
  const value = text ?? content;
  const rendered = typeof value === "string" && characters !== undefined
    ? JSON.stringify(truncateUnicode(value, characters))
    : JSON.stringify(value);
  return (typeof value === "string" || characters === undefined
    ? rendered
    : truncateUnicode(rendered, characters))
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}

function truncateUnicode(value: string, characters: number): string {
  const points = [...value];
  return points.length <= characters
    ? value
    : `${points.slice(0, Math.max(0, characters - 1)).join("")}…`;
}

function serializeJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
