import { randomUUID } from "node:crypto";

import type { OperationalEvent } from "../../operational-events.js";

export interface RaftActivityEvent {
  hookEventName: string;
  eventId: string;
  sessionId?: string;
  toolName?: string;
  status?: string;
  occurredAt: string;
  durationMs?: number;
  errorClass?: string;
}

export interface RaftActivityDrain {
  schema: "raft-activity-drain.v1";
  events: RaftActivityEvent[];
  dropped: number;
}

/**
 * Bounded in-memory activity queue limit, matching the official external-agent
 * reference default. Overflow drops the oldest event and is reported through
 * `dropped` on the next drain; draining is at-most-once.
 */
export const ACTIVITY_QUEUE_LIMIT = 500;

/**
 * Projects a bounded Loom run/tool lifecycle onto `raft-activity.v1` hook
 * events for the Raft bridge. It never emits prompts, message bodies,
 * thinking, tool input/output, Transcript, Workspace or raw error content,
 * and it never persists anything: activity is lossy UI telemetry only.
 *
 * State machine per agent name:
 *
 *   Idle -> (agent.run.started) -> Thinking -> (tool started) -> Working
 *        -> (tool ended) -> Thinking -> (last run ended) -> Idle
 *
 * A `Stop` (Idle) is only emitted when the last active run AND all tools have
 * finished, so overlapping runs or tools never report Idle early.
 */
export class RaftActivityProjector {
  #queue: RaftActivityEvent[] = [];
  #dropped = 0;
  /** runId -> agentName for runs that started but have not finished. */
  readonly #runs = new Map<string, string>();
  /** toolCallId -> toolName for tools that started but have not completed. */
  readonly #tools = new Map<string, string>();

  observe(event: OperationalEvent): void {
    for (const mapped of this.#map(event)) {
      if (this.#queue.length >= ACTIVITY_QUEUE_LIMIT) {
        this.#queue.shift();
        this.#dropped += 1;
      }
      this.#queue.push(mapped);
    }
  }

  drain(max: number): RaftActivityDrain {
    const bounded = Math.max(0, Math.min(Math.floor(max), this.#queue.length));
    const events = this.#queue.splice(0, bounded);
    const dropped = this.#dropped;
    this.#dropped = 0;
    return { schema: "raft-activity-drain.v1", events, dropped };
  }

  #map(event: OperationalEvent): RaftActivityEvent[] {
    switch (event.event) {
      case "agent.run.started": {
        this.#runs.set(event.runId, event.agentName);
        return [{
          hookEventName: "UserPromptSubmit",
          eventId: randomUUID(),
          sessionId: event.agentName,
          occurredAt: event.at,
        }];
      }
      case "agent.run.finished": {
        const agentName = this.#runs.get(event.runId);
        this.#runs.delete(event.runId);
        if (this.#runs.size > 0 || this.#tools.size > 0) return [];
        return [{
          hookEventName: "Stop",
          eventId: randomUUID(),
          ...(agentName ? { sessionId: agentName } : {}),
          occurredAt: event.at,
        }];
      }
      case "agent.tool.started": {
        this.#tools.set(event.toolCallId, event.toolName);
        return [{
          hookEventName: "PreToolUse",
          eventId: randomUUID(),
          toolName: event.toolName,
          occurredAt: event.at,
        }];
      }
      case "agent.tool.completed": {
        const toolName = this.#tools.get(event.toolCallId) ?? event.toolName;
        this.#tools.delete(event.toolCallId);
        const result: RaftActivityEvent[] = [{
          hookEventName: event.status === "error" ? "PostToolUseFailure" : "PostToolUse",
          eventId: randomUUID(),
          toolName,
          status: event.status,
          occurredAt: event.at,
          durationMs: event.durationMs,
          ...(event.status === "error" ? { errorClass: "tool_error" } : {}),
        }];
        // A run may have finished before its last tool (e.g. interrupt while a
        // tool is still active); Idle is only reported once everything is done.
        if (this.#runs.size === 0 && this.#tools.size === 0) {
          result.push({
            hookEventName: "Stop",
            eventId: randomUUID(),
            occurredAt: event.at,
          });
        }
        return result;
      }
      default:
        return [];
    }
  }
}
