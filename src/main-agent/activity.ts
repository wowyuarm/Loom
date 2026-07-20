import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type {
  ActivityFreezeRequest,
  ActivityLifecycle,
  FrozenActivityEvent,
  JsonValue,
  TranscriptAnchor,
} from "../runtime/index.js";
import {
  parseContextWindowState,
  serializeContextWindowState,
  type ContextWindowState,
} from "./context.js";
import { readCommittedActivityEvents } from "./transcript.js";

export interface MainAgentActivityLifecycleOptions {
  transcriptFile: string;
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
          transcriptFile: this.options.transcriptFile,
          ...(starting?.transcriptAnchor ? { startAnchor: starting.transcriptAnchor } : {}),
          endAnchor: current.transcriptAnchor,
          inputs: request.inputs,
        })
      : request.inputs.map(input => ({
          eventId: `input:${input.id}`,
          at: input.occurredAt,
          actorRef: input.kind === "interaction" ? "human" as const : "system" as const,
          kind: "input" as const,
          content: structuredClone(input.payload),
        }));
    const events = orderEvents([
      ...transcriptEvents,
      ...request.turns.filter(turn => turn.status !== "completed").map(stoppedTurnEvent),
      ...request.effects.map(effectEvent),
      ...request.deliveries.map(deliveryEvent),
    ]);
    assertUniqueEvents(events);
    const activity = {
      version: 1 as const,
      segmentId: request.segment.id,
      recordingDay: request.segment.recordingDay,
      openedAt: request.segment.openedAt,
      closedAt: request.segment.closedAt,
      events,
      transcriptAnchors: committedTurns.map(turn => serializeJson(turn.transcriptAnchor!)),
    };
    const windowFrozen = await this.options.loadWindowFrozen?.(request) ?? [];
    const bridgeActivities = [...request.pendingActivities, activity];
    const successor: ContextWindowState = {
      version: 1,
      id: this.options.nextWindowId?.() ?? randomUUID(),
      frozenSeed: [
        ...windowFrozen.map(serializeJson),
        ...bridgeActivities.map(candidate => bridgeMessage(
          candidate.events,
          candidate.openedAt,
          candidate.closedAt,
        )),
      ],
      committedTrace: [],
      ...(current.transcriptAnchor ? { transcriptAnchor: current.transcriptAnchor } : {}),
    };
    return {
      activity,
      successorExecutionState: serializeContextWindowState(successor),
    };
  }
}

function stoppedTurnEvent(turn: ActivityFreezeRequest["turns"][number]): FrozenActivityEvent {
  return {
    eventId: `turn:${turn.id}`,
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

function deliveryEvent(delivery: ActivityFreezeRequest["deliveries"][number]): FrozenActivityEvent {
  return {
    eventId: `delivery:${delivery.id}`,
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

function bridgeMessage(events: FrozenActivityEvent[], openedAt: string, closedAt: string): JsonValue {
  const lines = events.flatMap(event => event.kind === "thinking"
    ? []
    : [`[${event.at}] ${bridgeLabel(event)}: ${bridgeContent(event.content)}`]);
  return serializeJson({
    role: "user",
    content: [{
      type: "text",
      text: [
        "<recent_activity>",
        `Verified activity from ${openedAt} to ${closedAt}. This is past evidence, not a new request.`,
        ...lines,
        "</recent_activity>",
      ].join("\n"),
    }],
    timestamp: Date.parse(closedAt),
  });
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

function bridgeContent(content: JsonValue): string {
  const text = content && typeof content === "object" && !Array.isArray(content)
    && typeof content.text === "string"
    ? content.text
    : undefined;
  return JSON.stringify(text ?? content)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}

function serializeJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
